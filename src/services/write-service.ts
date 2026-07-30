import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { z } from 'zod';
import { NutritionMcpError } from '../errors.js';
import { fingerprint, type IdempotencyStore } from '../persistence/idempotency-store.js';
import type {
  addConsumedItemInputSchema,
  addMealBatchInputSchema,
  addWaterInputSchema,
  removeConsumedItemInputSchema,
  updateConsumedItemInputSchema,
} from '../schemas.js';
import type { DiaryItem, NutritionBackend, WaterIntake } from '../types.js';

type AddInput = z.infer<typeof addConsumedItemInputSchema>;
type BatchInput = z.infer<typeof addMealBatchInputSchema>;
type RemoveInput = z.infer<typeof removeConsumedItemInputSchema>;
type UpdateInput = z.infer<typeof updateConsumedItemInputSchema>;
type WaterInput = z.infer<typeof addWaterInputSchema>;

interface AddResult {
  status: 'dry_run' | 'applied' | 'applied_unverified';
  preview: Record<string, unknown>;
  entry_id: string | null;
  duplicate_check: 'clear';
  verified: boolean;
}

interface BatchItemResult {
  index: number;
  entry_id: string | null;
  status:
    | 'applied'
    | 'applied_unverified'
    | 'failed'
    | 'not_attempted'
    | 'rolled_back'
    | 'rollback_failed'
    | 'uncertain';
  message?: string;
}

interface BatchResult {
  status: 'dry_run' | 'applied' | 'rolled_back' | 'partial_failure';
  items: BatchItemResult[];
  preview: Array<Record<string, unknown>>;
}

type UpdateResult =
  | {
      status: 'dry_run';
      preview: Record<string, unknown>;
      old_entry_id: string;
      replacement_entry_id: null;
      verified: false;
    }
  | {
      status: 'applied';
      preview: Record<string, unknown>;
      old_entry_id: string;
      replacement_entry_id: string;
      verified: true;
    }
  | {
      status: 'rolled_back';
      preview: Record<string, unknown>;
      old_entry_id: string;
      replacement_entry_id: string;
      verified: true;
      message: string;
    }
  | {
      status: 'partial_failure';
      preview: Record<string, unknown>;
      old_entry_id: string;
      replacement_entry_id: string;
      verified: false;
      message: string;
    };

interface UpdatePreparation {
  original: DiaryItem;
  replacementPreview: Record<string, unknown>;
  preview: {
    action: 'update_consumed_item';
    old_item: DiaryItem;
    replacement: Record<string, unknown>;
  };
}

export class WriteService {
  private waterQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: NutritionBackend,
    private readonly idempotency: IdempotencyStore,
    private readonly timezone: string,
  ) {}

  async addConsumedItem(input: AddInput): Promise<AddResult> {
    const operationFingerprint = fingerprint({ ...input, client_request_id: undefined });
    if (!input.dry_run) {
      const begin = await this.idempotency.begin<AddResult>(
        'add_consumed_item',
        input.client_request_id,
        operationFingerprint,
      );
      if (begin.kind === 'cached') return begin.result;
    }
    let preview: Record<string, unknown>;
    try {
      preview = await this.consumedPreview(input);
      await this.assertNoDuplicate(input);
    } catch (error) {
      if (!input.dry_run) {
        await this.idempotency.fail('add_consumed_item', input.client_request_id);
      }
      throw error;
    }
    if (input.dry_run) {
      return {
        status: 'dry_run',
        preview,
        entry_id: null,
        duplicate_check: 'clear',
        verified: false,
      };
    }
    const generatedId = randomUUID();
    // If the network fails after YAZIO applied the request, the pending journal
    // makes the same idempotency key fail closed instead of blind retry.
    await this.backend.addConsumedItem({
      id: generatedId,
      product_id: input.product_id,
      date: input.date,
      daytime: input.daytime,
      amount: input.amount,
      serving: input.serving ?? null,
      serving_quantity: input.serving_quantity ?? null,
    });
    let verifiedItem: DiaryItem | null = null;
    try {
      verifiedItem = await this.findWrittenItem(input, generatedId);
    } catch {
      // The write already succeeded. A verification read failure must not make
      // the mutation retryable.
    }
    const result: AddResult = {
      status: verifiedItem === null ? 'applied_unverified' : 'applied',
      preview,
      entry_id: verifiedItem?.id ?? generatedId,
      duplicate_check: 'clear',
      verified: verifiedItem !== null,
    };
    await this.idempotency.complete('add_consumed_item', input.client_request_id, result);
    return result;
  }

  async addMealBatch(input: BatchInput): Promise<BatchResult> {
    const operationFingerprint = fingerprint({ ...input, client_request_id: undefined });
    if (!input.dry_run) {
      const begin = await this.idempotency.begin<BatchResult>(
        'add_meal_batch',
        input.client_request_id,
        operationFingerprint,
      );
      if (begin.kind === 'cached') return begin.result;
    }
    let preview: Array<Record<string, unknown>>;
    try {
      const batchKeys = new Set<string>();
      for (const item of input.items) {
        const key = fingerprint({
          product_id: item.product_id,
          date: item.date,
          daytime: item.daytime,
          amount: item.amount,
          serving: item.serving ?? null,
          serving_quantity: item.serving_quantity ?? null,
        });
        if (batchKeys.has(key)) {
          throw new NutritionMcpError(
            'DUPLICATE_DETECTED',
            'Batch содержит одинаковые позиции; запись не выполнена.',
          );
        }
        batchKeys.add(key);
      }
      preview = await Promise.all(input.items.map((item) => this.consumedPreview(item)));
      for (const item of input.items) await this.assertNoDuplicate(item);
    } catch (error) {
      if (!input.dry_run) await this.idempotency.fail('add_meal_batch', input.client_request_id);
      throw error;
    }
    if (input.dry_run) return { status: 'dry_run', items: [], preview };

    const results: BatchItemResult[] = [];
    const created: Array<{ id: string; date: string; resultIndex: number }> = [];
    let failed = false;
    for (const [index, item] of input.items.entries()) {
      const id = randomUUID();
      try {
        await this.backend.addConsumedItem({
          id,
          product_id: item.product_id,
          date: item.date,
          daytime: item.daytime,
          amount: item.amount,
          serving: item.serving ?? null,
          serving_quantity: item.serving_quantity ?? null,
        });
        let verified: DiaryItem | null = null;
        try {
          verified = await this.findWrittenItem(item, id);
        } catch {
          // Report an unverified success but retain the created ID for rollback.
        }
        results.push({
          index,
          entry_id: verified?.id ?? id,
          status: verified === null ? 'applied_unverified' : 'applied',
        });
        created.push({ id, date: item.date, resultIndex: results.length - 1 });
      } catch (error) {
        results.push({
          index,
          entry_id: id,
          status: 'failed',
          message: 'YAZIO отклонил элемент; чувствительные детали upstream скрыты.',
        });
        if (error instanceof NutritionMcpError && error.retryable) {
          try {
            const diary = await this.backend.getDiary(item.date);
            if (diary.items.some((entry) => entry.id === id)) {
              created.push({ id, date: item.date, resultIndex: results.length - 1 });
            }
          } catch {
            const failedResult = results[results.length - 1];
            if (failedResult !== undefined) {
              failedResult.status = 'uncertain';
              failedResult.message =
                'Итог записи и возможность безопасной компенсации не подтверждены.';
            }
          }
        }
        failed = true;
        break;
      }
    }
    for (let index = results.length; index < input.items.length; index += 1) {
      results.push({
        index,
        entry_id: null,
        status: 'not_attempted',
        message: 'Элемент пропущен из-за ошибки предыдущего элемента.',
      });
    }

    let status: BatchResult['status'] = 'applied';
    if (failed) {
      status = 'rolled_back';
      for (const createdItem of [...created].reverse()) {
        let removalReturned = false;
        try {
          await this.backend.removeConsumedItem(createdItem.id);
          removalReturned = true;
        } catch {
          // A DELETE error is not conclusive: verify the exact generated ID below.
        }
        const itemResult = results[createdItem.resultIndex];
        try {
          const diary = await this.backend.getDiary(createdItem.date);
          const removed = !diary.items.some((entry) => entry.id === createdItem.id);
          if (removed && itemResult !== undefined) {
            itemResult.status = 'rolled_back';
            if (removalReturned) {
              delete itemResult.message;
            } else {
              itemResult.message =
                'Удаление подтверждено повторным чтением после ошибки DELETE.';
            }
          } else {
            status = 'partial_failure';
            if (itemResult !== undefined) itemResult.status = 'rollback_failed';
          }
        } catch {
          status = 'partial_failure';
          if (itemResult !== undefined) itemResult.status = 'rollback_failed';
        }
      }
      if (results.some((item) => item.status === 'uncertain')) status = 'partial_failure';
    }
    const result: BatchResult = { status, items: results, preview };
    await this.idempotency.complete('add_meal_batch', input.client_request_id, result);
    return result;
  }

  async updateConsumedItem(
    input: UpdateInput,
    authorization?: { kind: 'mrtr' },
  ): Promise<UpdateResult> {
    return this.idempotency.runExclusive(
      `consumed-item:${input.date}:${input.item_id}`,
      () => this.updateConsumedItemLocked(input, authorization),
    );
  }

  async prepareConsumedItemUpdate(
    input: UpdateInput,
  ): Promise<{ preview: UpdatePreparation['preview']; old_entry_id: string }> {
    const prepared = await this.prepareUpdate(input);
    return { preview: prepared.preview, old_entry_id: prepared.original.id };
  }

  private async updateConsumedItemLocked(
    input: UpdateInput,
    authorization?: { kind: 'mrtr' },
  ): Promise<UpdateResult> {
    const operationFingerprint = fingerprint({
      item_id: input.item_id,
      date: input.date,
      amount: input.amount,
    });
    if (!input.dry_run) {
      const begin = await this.idempotency.begin<UpdateResult>(
        'update_consumed_item',
        input.client_request_id,
        operationFingerprint,
      );
      if (begin.kind === 'cached') return begin.result;
    }

    let prepared: UpdatePreparation;
    try {
      prepared = await this.prepareUpdate(input);
    } catch (error) {
      if (!input.dry_run) {
        await this.idempotency.fail('update_consumed_item', input.client_request_id);
      }
      throw error;
    }
    const { original, preview } = prepared;

    if (input.dry_run) {
      const confirmation = await this.idempotency.issueConfirmation(operationFingerprint);
      return {
        status: 'dry_run',
        preview: {
          ...preview,
          confirmation_token: confirmation.token,
          confirmation_expires_at: confirmation.expiresAt,
        },
        old_entry_id: original.id,
        replacement_entry_id: null,
        verified: false,
      };
    }

    if (
      authorization?.kind !== 'mrtr' &&
      (input.confirmation_token === undefined ||
        !(await this.idempotency.consumeConfirmation(
          input.confirmation_token,
          operationFingerprint,
        )))
    ) {
      await this.idempotency.fail('update_consumed_item', input.client_request_id);
      throw new NutritionMcpError(
        'CONFIRMATION_REQUIRED',
        'Нужен MRTR-ответ пользователя либо действующий одноразовый confirmation_token из dry-run.',
      );
    }

    const replacementId = randomUUID();
    try {
      await this.backend.addConsumedItem({
        id: replacementId,
        product_id: original.product_id as string,
        date: original.date,
        daytime: original.daytime,
        amount: input.amount,
        serving: original.serving,
        serving_quantity: original.serving_quantity,
      });
    } catch {
      const stateAfterError = await this.readReplacementState(
        input.date,
        original.id,
        replacementId,
      );
      if (stateAfterError?.newPresent !== true) {
        const restored = await this.compensateReplacement(
          input.date,
          original.id,
          replacementId,
        );
        const result: UpdateResult = restored
          ? {
              status: 'rolled_back',
              preview,
              old_entry_id: original.id,
              replacement_entry_id: replacementId,
              verified: true,
              message:
                'POST replacement завершился ошибкой; точный replacement ID удалён, исходная запись сохранена.',
            }
          : {
              status: 'partial_failure',
              preview,
              old_entry_id: original.id,
              replacement_entry_id: replacementId,
              verified: false,
              message:
                'POST replacement завершился неоднозначно; проверьте оба entry ID вручную.',
            };
        await this.idempotency.complete('update_consumed_item', input.client_request_id, result);
        return result;
      }
      // The exact generated ID exists, so the POST was applied despite the
      // transport error. Continue the verified replacement flow.
    }

    const replacementVerified = await this.hasDiaryItem(input.date, replacementId);
    if (replacementVerified !== true) {
      const restored = await this.compensateReplacement(input.date, original.id, replacementId);
      const result: UpdateResult = restored
        ? {
            status: 'rolled_back',
            preview,
            old_entry_id: original.id,
            replacement_entry_id: replacementId,
            verified: true,
            message:
              'Новая запись не была подтверждена; replacement удалён, исходная запись сохранена.',
          }
        : {
            status: 'partial_failure',
            preview,
            old_entry_id: original.id,
            replacement_entry_id: replacementId,
            verified: false,
            message:
              'Невозможно подтвердить replacement и восстановление исходного состояния; проверьте дневник вручную.',
          };
      await this.idempotency.complete('update_consumed_item', input.client_request_id, result);
      return result;
    }

    try {
      await this.backend.removeConsumedItem(original.id);
    } catch {
      // DELETE may have been applied before a transport error. The exact IDs
      // are checked below before deciding whether compensation is required.
    }

    const state = await this.readReplacementState(input.date, original.id, replacementId);
    if (state?.oldPresent === false && state.newPresent) {
      const result: UpdateResult = {
        status: 'applied',
        preview,
        old_entry_id: original.id,
        replacement_entry_id: replacementId,
        verified: true,
      };
      await this.idempotency.complete('update_consumed_item', input.client_request_id, result);
      return result;
    }

    if (state?.oldPresent === true && state.newPresent === false) {
      const result: UpdateResult = {
        status: 'rolled_back',
        preview,
        old_entry_id: original.id,
        replacement_entry_id: replacementId,
        verified: true,
        message: 'Исходная запись сохранена, replacement отсутствует.',
      };
      await this.idempotency.complete('update_consumed_item', input.client_request_id, result);
      return result;
    }

    if (state?.oldPresent === true && state.newPresent) {
      const restored = await this.compensateReplacement(input.date, original.id, replacementId);
      const result: UpdateResult = restored
        ? {
            status: 'rolled_back',
            preview,
            old_entry_id: original.id,
            replacement_entry_id: replacementId,
            verified: true,
            message:
              'Удаление исходной записи не подтвердилось; replacement удалён, исходная запись сохранена.',
          }
        : {
            status: 'partial_failure',
            preview,
            old_entry_id: original.id,
            replacement_entry_id: replacementId,
            verified: false,
            message:
              'Исходная и новая записи могут существовать одновременно; проверьте дневник вручную.',
          };
      await this.idempotency.complete('update_consumed_item', input.client_request_id, result);
      return result;
    }

    const result: UpdateResult = {
      status: 'partial_failure',
      preview,
      old_entry_id: original.id,
      replacement_entry_id: replacementId,
      verified: false,
      message:
        'Итог удаления не удалось перечитать; повторная запись заблокирована idempotency journal.',
    };
    await this.idempotency.complete('update_consumed_item', input.client_request_id, result);
    return result;
  }

  async removeConsumedItem(
    input: RemoveInput,
    authorization?: { kind: 'mrtr' },
  ): Promise<Record<string, unknown>> {
    const removalFingerprint = fingerprint({ item_id: input.item_id, date: input.date });
    if (!input.dry_run) {
      const operationFingerprint = removalFingerprint;
      const begin = await this.idempotency.begin<Record<string, unknown>>(
        'remove_consumed_item',
        input.client_request_id,
        operationFingerprint,
      );
      if (begin.kind === 'cached') return begin.result;
    }
    let prepared: { item: DiaryItem; preview: Record<string, unknown> };
    try {
      prepared = await this.prepareRemoval(input);
    } catch (error) {
      if (!input.dry_run) {
        await this.idempotency.fail('remove_consumed_item', input.client_request_id);
      }
      throw error;
    }
    const { preview } = prepared;
    if (input.dry_run) {
      const confirmation = await this.idempotency.issueConfirmation(removalFingerprint);
      return {
        status: 'dry_run',
        preview: {
          ...preview,
          confirmation_token: confirmation.token,
          confirmation_expires_at: confirmation.expiresAt,
        },
      };
    }
    if (
      authorization?.kind !== 'mrtr' &&
      (input.confirmation_token === undefined ||
        !(await this.idempotency.consumeConfirmation(
          input.confirmation_token,
          removalFingerprint,
        )))
    ) {
      await this.idempotency.fail('remove_consumed_item', input.client_request_id);
      throw new NutritionMcpError(
        'CONFIRMATION_REQUIRED',
        'Нужен MRTR-ответ пользователя либо действующий одноразовый confirmation_token из dry-run.',
      );
    }
    // DELETE can be applied before a network failure. A thrown error leaves the
    // request pending so the same key cannot issue a blind second delete.
    await this.backend.removeConsumedItem(input.item_id);
    let verified = false;
    try {
      const reread = await this.backend.getDiary(input.date);
      verified = !reread.items.some((entry) => entry.id === input.item_id);
    } catch {
      // Deletion already returned success; preserve it as unverified.
    }
    const result = { status: verified ? 'removed' : 'removed_unverified', preview, verified };
    await this.idempotency.complete('remove_consumed_item', input.client_request_id, result);
    return result;
  }

  async prepareConsumedItemRemoval(
    input: RemoveInput,
  ): Promise<{ preview: Record<string, unknown>; item: DiaryItem }> {
    return this.prepareRemoval(input);
  }

  async addWaterIntake(input: WaterInput): Promise<Record<string, unknown>> {
    let release: () => void = () => undefined;
    const previous = this.waterQueue;
    this.waterQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.idempotency.runExclusive(`water:${input.date}`, () =>
        this.addWaterIntakeLocked(input),
      );
    } finally {
      release();
    }
  }

  private async addWaterIntakeLocked(input: WaterInput): Promise<Record<string, unknown>> {
    if (!input.dry_run) {
      const operationFingerprint = fingerprint({ ...input, client_request_id: undefined });
      const begin = await this.idempotency.begin<Record<string, unknown>>(
        'add_water_intake',
        input.client_request_id,
        operationFingerprint,
      );
      if (begin.kind === 'cached') return begin.result;
    }
    let before: WaterIntake;
    try {
      before = await this.backend.getWaterIntake(input.date);
    } catch (error) {
      if (!input.dry_run) {
        await this.idempotency.fail('add_water_intake', input.client_request_id);
      }
      throw error;
    }
    const cumulative = before.water_ml + input.amount_ml;
    const preview = {
      action: 'add_water_intake',
      date: input.date,
      previous_ml: before.water_ml,
      amount_ml: input.amount_ml,
      resulting_cumulative_ml: cumulative,
    };
    if (input.dry_run) return { status: 'dry_run', preview };
    // A transport failure may happen after the cumulative POST was applied.
    // Leaving the request pending prevents a blind second increment.
    const time = DateTime.fromISO(input.date, { zone: this.timezone }).set({ hour: 12 });
    await this.backend.setWaterIntake({
      dateTime: time.toFormat('yyyy-MM-dd HH:mm:ss'),
      cumulativeMl: cumulative,
    });
    let after = { date: input.date, water_ml: cumulative };
    let verified = false;
    try {
      after = await this.backend.getWaterIntake(input.date);
      verified = after.water_ml === cumulative;
    } catch {
      // The cumulative write already returned success.
    }
    const result = {
      status: verified ? 'applied' : 'applied_unverified',
      preview,
      verified,
      water: after,
    };
    await this.idempotency.complete('add_water_intake', input.client_request_id, result);
    return result;
  }

  private async consumedPreview(
    item: Pick<
      AddInput,
      'product_id' | 'date' | 'daytime' | 'amount' | 'serving' | 'serving_quantity'
    >,
  ): Promise<Record<string, unknown>> {
    const product = await this.backend.getProduct(item.product_id);
    if (product === null) {
      throw new NutritionMcpError('UPSTREAM_NOT_FOUND', 'Продукт не найден.');
    }
    const factor = item.amount / 100;
    return {
      action: 'add_consumed_item',
      product_id: item.product_id,
      product_name: product.name,
      date: item.date,
      daytime: item.daytime,
      amount: item.amount,
      base_unit: product.base_unit,
      serving: item.serving ?? null,
      serving_quantity: item.serving_quantity ?? null,
      estimated_nutrition: {
        ...product.nutrition,
        calories: product.nutrition.calories * factor,
        protein: product.nutrition.protein * factor,
        fat: product.nutrition.fat * factor,
        carbs: product.nutrition.carbs * factor,
        fiber: product.nutrition.fiber * factor,
        sugar: product.nutrition.sugar * factor,
      },
    };
  }

  private async prepareUpdate(input: UpdateInput): Promise<UpdatePreparation> {
    const diary = await this.backend.getDiary(input.date);
    const item = diary.items.find((entry) => entry.id === input.item_id);
    if (item === undefined) {
      throw new NutritionMcpError(
        'UPSTREAM_NOT_FOUND',
        'Запись дневника не найдена на указанную дату.',
      );
    }
    if (item.kind !== 'product' || item.product_id === null) {
      throw new NutritionMcpError(
        'UNSUPPORTED_OPERATION',
        'Безопасное изменение подтверждено только для обычных продуктов YAZIO.',
      );
    }
    if (item.amount === input.amount) {
      throw new NutritionMcpError(
        'VALIDATION_ERROR',
        'Новое количество совпадает с текущим; изменение не требуется.',
      );
    }
    const replacementPreview = await this.consumedPreview({
      product_id: item.product_id,
      date: item.date,
      daytime: item.daytime,
      amount: input.amount,
      serving: item.serving,
      serving_quantity: item.serving_quantity,
    });
    return {
      original: item,
      replacementPreview,
      preview: {
        action: 'update_consumed_item',
        old_item: item,
        replacement: replacementPreview,
      },
    };
  }

  private async prepareRemoval(
    input: RemoveInput,
  ): Promise<{ preview: Record<string, unknown>; item: DiaryItem }> {
    const diary = await this.backend.getDiary(input.date);
    const item = diary.items.find((entry) => entry.id === input.item_id);
    if (item === undefined) {
      throw new NutritionMcpError(
        'UPSTREAM_NOT_FOUND',
        'Запись дневника не найдена на указанную дату.',
      );
    }
    return {
      item,
      preview: {
        action: 'remove_consumed_item',
        item,
      },
    };
  }

  private async assertNoDuplicate(
    item: Pick<AddInput, 'product_id' | 'date' | 'daytime' | 'amount'>,
  ): Promise<void> {
    const diary = await this.backend.getDiary(item.date);
    const tolerance = Math.max(1, item.amount * 0.02);
    const duplicate = diary.items.find(
      (entry) =>
        entry.product_id === item.product_id &&
        entry.daytime === item.daytime &&
        Math.abs(entry.amount - item.amount) <= tolerance,
    );
    if (duplicate !== undefined) {
      throw new NutritionMcpError(
        'DUPLICATE_DETECTED',
        'Найдена вероятная дублирующая запись; запись не выполнена.',
        { details: { existing_item_id: duplicate.id, date: duplicate.date } },
      );
    }
  }

  private async findWrittenItem(
    item: Pick<AddInput, 'product_id' | 'date' | 'daytime' | 'amount'>,
    generatedId: string,
  ): Promise<DiaryItem | null> {
    const diary = await this.backend.getDiary(item.date);
    return diary.items.find((entry) => entry.id === generatedId) ?? null;
  }

  private async hasDiaryItem(date: string, itemId: string): Promise<boolean | null> {
    try {
      const diary = await this.backend.getDiary(date);
      return diary.items.some((entry) => entry.id === itemId);
    } catch {
      return null;
    }
  }

  private async readReplacementState(
    date: string,
    oldId: string,
    replacementId: string,
  ): Promise<{ oldPresent: boolean; newPresent: boolean } | null> {
    try {
      const diary = await this.backend.getDiary(date);
      return {
        oldPresent: diary.items.some((entry) => entry.id === oldId),
        newPresent: diary.items.some((entry) => entry.id === replacementId),
      };
    } catch {
      return null;
    }
  }

  private async compensateReplacement(
    date: string,
    oldId: string,
    replacementId: string,
  ): Promise<boolean> {
    try {
      await this.backend.removeConsumedItem(replacementId);
    } catch {
      // Verify the exact IDs even if DELETE itself failed.
    }
    const state = await this.readReplacementState(date, oldId, replacementId);
    return state?.oldPresent === true && state.newPresent === false;
  }
}
