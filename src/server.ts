import { createHash } from 'node:crypto';
import {
  McpServer,
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  type CallToolResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { aggregateTrends, compareTrendPeriods, detectMissingMeals } from './analytics/index.js';
import { YazioAdapter } from './adapters/yazio-adapter.js';
import { AuthManager } from './auth/auth-manager.js';
import { FileTokenStore } from './auth/token-store.js';
import type { AppConfig } from './config.js';
import { enumerateDates, resolveDateOrRange, todayInZone } from './domain/dates.js';
import { NutritionMcpError, toPublicError } from './errors.js';
import { FileIdempotencyStore, fingerprint } from './persistence/idempotency-store.js';
import {
  addConsumedItemOutputSchema,
  addConsumedItemInputSchema,
  addMealBatchInputSchema,
  addWaterOutputSchema,
  addWaterInputSchema,
  batchOutputSchema,
  comparePeriodsOutputSchema,
  comparePeriodsInputSchema,
  dailySummaryOutputSchema,
  dateOrRangeInputSchema,
  diaryDayOutputSchema,
  exerciseOutputSchema,
  getDateInputSchema,
  getGoalsInputSchema,
  getProductInputSchema,
  goalsOutputSchema,
  missingMealsInputSchema,
  missingMealsOutputSchema,
  productDetailsOutputSchema,
  productOutputSchema,
  removeConsumedItemInputSchema,
  removeConsumedItemOutputSchema,
  searchProductsInputSchema,
  toolOutputSchema,
  trendsInputSchema,
  trendsOutputSchema,
  updateConsumedItemInputSchema,
  updateConsumedItemOutputSchema,
  userProfileOutputSchema,
  waterOutputSchema,
  weightOutputSchema,
} from './schemas.js';
import { WriteService } from './services/write-service.js';
import type { NutritionBackend } from './types.js';
import { mapSettledWithConcurrency, mapWithConcurrency } from './utils/concurrency.js';

export interface ServerDependencies {
  backend?: NutritionBackend;
  writeService?: WriteService;
  fetchImplementation?: typeof fetch;
}

const confirmationSchema = z.object({ confirm: z.boolean() });
const rangeReadConcurrency = 6;

interface DestructiveRequestState {
  operation: 'remove_consumed_item' | 'update_consumed_item';
  fingerprint: string;
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const removeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const resultMeta = (config: AppConfig) => ({
  timezone: config.timezone,
  backend: 'yazio-unofficial',
  generated_at: new Date().toISOString(),
});

const successResult = (
  config: AppConfig,
  data: unknown,
  text: string,
): CallToolResult => ({
  content: [{ type: 'text', text }],
  structuredContent: { ok: true, data, meta: resultMeta(config) },
});

const errorResult = (error: unknown): CallToolResult => {
  const publicError = toPublicError(error);
  return {
    content: [{ type: 'text', text: `${publicError.code}: ${publicError.message}` }],
    structuredContent: { ok: false, error: publicError },
    isError: true,
  };
};

const safeResult = async (
  config: AppConfig,
  operation: () => Promise<unknown>,
  summarize: (data: unknown) => string,
): Promise<CallToolResult> => {
  try {
    const data = await operation();
    return successResult(config, data, summarize(data));
  } catch (error) {
    return errorResult(error);
  }
};

const statusText = (data: unknown): string => {
  if (typeof data !== 'object' || data === null) return 'unknown';
  const status = (data as { status?: unknown }).status;
  return typeof status === 'string' ? status : 'unknown';
};

const createDefaultBackend = (
  config: AppConfig,
  fetchImplementation?: typeof fetch,
): NutritionBackend => {
  const tokenStore = new FileTokenStore(config.tokenCachePath);
  const auth = new AuthManager(
    {
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      username: config.username,
      password: config.password,
      timeoutMs: config.timeoutMs,
    },
    tokenStore,
    fetchImplementation,
  );
  return new YazioAdapter(
    {
      baseUrl: config.baseUrl,
      countries: config.countries,
      locales: config.locales,
      defaultSex: config.defaultSex,
      timeoutMs: config.timeoutMs,
    },
    auth,
    fetchImplementation,
  );
};

export const createYazioServer = async (
  config: AppConfig,
  dependencies: ServerDependencies = {},
): Promise<McpServer> => {
  const backend =
    dependencies.backend ?? createDefaultBackend(config, dependencies.fetchImplementation);
  const scope = createHash('sha256')
    .update(`${config.baseUrl}\0${config.username ?? 'token-only'}`)
    .digest('hex')
    .slice(0, 24);
  const idempotency = new FileIdempotencyStore(config.statePath, scope);
  const writeService =
    dependencies.writeService ??
    new WriteService(backend, idempotency, config.timezone);
  const requestStateCodec = createRequestStateCodec<DestructiveRequestState>({
    key: await idempotency.requestStateKey(),
    ttlSeconds: 10 * 60,
    bind: (context) => `${context.mcpReq.method}\0${scope}`,
  });
  const server = new McpServer(
    { name: 'yazio-mcp', version: '0.1.0' },
    {
      capabilities: { tools: { listChanged: false } },
      requestState: {
        verify: (state, context) => requestStateCodec.verify(state, context),
      },
    },
  );

  const loadDailySummaries = async (dates: string[]) => {
    const settled = await mapSettledWithConcurrency(
      dates,
      rangeReadConcurrency,
      (date) => backend.getDailySummary(date),
    );
    const summaries = settled.values.filter((value) => value !== undefined);
    if (summaries.length === 0 && settled.errors[0] !== undefined) {
      throw settled.errors[0].error;
    }
    const failedDates = settled.errors
      .map(({ index }) => dates[index])
      .filter((date): date is string => date !== undefined);
    const coverage = {
      requested_days: dates.length,
      successful_days: summaries.length,
      failed_dates: failedDates,
    };
    return { summaries, coverage, partial: failedDates.length > 0 };
  };

  server.registerTool(
    'get_user_profile',
    {
      title: 'Профиль питания',
      description:
        'Возвращает минимально необходимый allowlist профиля YAZIO без email, даты рождения, токенов и платёжных идентификаторов.',
      inputSchema: z.object({}),
      outputSchema: toolOutputSchema(userProfileOutputSchema),
      annotations: readAnnotations,
    },
    async () =>
      safeResult(config, () => backend.getUserProfile(), () => 'Профиль YAZIO получен.'),
  );

  server.registerTool(
    'get_goals',
    {
      title: 'Цели питания',
      description: 'Возвращает цели калорий, БЖУ, воды, шагов и веса на дату.',
      inputSchema: getGoalsInputSchema,
      outputSchema: toolOutputSchema(goalsOutputSchema),
      annotations: readAnnotations,
    },
    async ({ date }) => {
      const resolvedDate = date ?? todayInZone(config.timezone);
      return safeResult(
        config,
        () => backend.getGoals(resolvedDate),
        () => `Цели на ${resolvedDate} получены.`,
      );
    },
  );

  server.registerTool(
    'search_products',
    {
      title: 'Поиск продуктов',
      description:
        'Ищет продукты YAZIO. По умолчанию используются RU и ru_RU; nutrition нормализован на 100 g/ml.',
      inputSchema: searchProductsInputSchema,
      outputSchema: toolOutputSchema(z.array(productOutputSchema)),
      annotations: readAnnotations,
    },
    async (input) =>
      safeResult(
        config,
        () => backend.searchProducts(input),
        (data) => `Найдено ${Array.isArray(data) ? data.length : 0} продуктов.`,
      ),
  );

  server.registerTool(
    'get_product',
    {
      title: 'Карточка продукта',
      description: 'Возвращает продукт по UUID с нормализованными nutrients на 100 g/ml.',
      inputSchema: getProductInputSchema,
      outputSchema: toolOutputSchema(productDetailsOutputSchema.nullable()),
      annotations: readAnnotations,
    },
    async ({ product_id }) =>
      safeResult(
        config,
        () => backend.getProduct(product_id),
        (data) => (data === null ? 'Продукт не найден.' : 'Карточка продукта получена.'),
      ),
  );

  server.registerTool(
    'get_diary',
    {
      title: 'Дневник питания',
      description:
        'Возвращает дневник за дату или локально агрегированный диапазон до 31 дня; YAZIO не имеет подтверждённого range endpoint.',
      inputSchema: dateOrRangeInputSchema,
      outputSchema: toolOutputSchema(z.object({ days: z.array(diaryDayOutputSchema) })),
      annotations: readAnnotations,
    },
    async (input) =>
      safeResult(
        config,
        async () => {
          const dates = resolveDateOrRange(input, config.timezone, 31);
          return {
            days: await mapWithConcurrency(
              dates,
              rangeReadConcurrency,
              (date) => backend.getDiary(date),
            ),
          };
        },
        (data) => {
          const count =
            typeof data === 'object' &&
            data !== null &&
            Array.isArray((data as { days?: unknown }).days)
              ? (data as { days: unknown[] }).days.length
              : 0;
          return `Дневник получен за ${count} дн.`;
        },
      ),
  );

  server.registerTool(
    'get_daily_summary',
    {
      title: 'Сводка дня',
      description: 'Возвращает суточные calories/БЖУ, цели, воду, шаги и разбивку по приёмам пищи.',
      inputSchema: getDateInputSchema,
      outputSchema: toolOutputSchema(dailySummaryOutputSchema),
      annotations: readAnnotations,
    },
    async ({ date }) => {
      const resolvedDate = date ?? todayInZone(config.timezone);
      return safeResult(
        config,
        () => backend.getDailySummary(resolvedDate),
        () => `Сводка за ${resolvedDate} получена.`,
      );
    },
  );

  server.registerTool(
    'get_water_intake',
    {
      title: 'Вода',
      description: 'Возвращает кумулятивное потребление воды в миллилитрах на дату.',
      inputSchema: getDateInputSchema,
      outputSchema: toolOutputSchema(waterOutputSchema),
      annotations: readAnnotations,
    },
    async ({ date }) => {
      const resolvedDate = date ?? todayInZone(config.timezone);
      return safeResult(
        config,
        () => backend.getWaterIntake(resolvedDate),
        () => `Вода за ${resolvedDate} получена.`,
      );
    },
  );

  server.registerTool(
    'get_weight',
    {
      title: 'Вес',
      description: 'Возвращает последнюю запись веса на указанную дату или ранее.',
      inputSchema: getDateInputSchema,
      outputSchema: toolOutputSchema(weightOutputSchema.nullable()),
      annotations: readAnnotations,
    },
    async ({ date }) => {
      const resolvedDate = date ?? todayInZone(config.timezone);
      return safeResult(
        config,
        () => backend.getWeight(resolvedDate),
        () => `Вес на ${resolvedDate} получен.`,
      );
    },
  );

  server.registerTool(
    'get_exercises',
    {
      title: 'Упражнения',
      description: 'Возвращает тренировки и custom training на дату.',
      inputSchema: getDateInputSchema,
      outputSchema: toolOutputSchema(z.array(exerciseOutputSchema)),
      annotations: readAnnotations,
    },
    async ({ date }) => {
      const resolvedDate = date ?? todayInZone(config.timezone);
      return safeResult(
        config,
        () => backend.getExercises(resolvedDate),
        (data) => `Получено ${Array.isArray(data) ? data.length : 0} упражнений.`,
      );
    },
  );

  server.registerTool(
    'add_consumed_item',
    {
      title: 'Добавить продукт',
      description:
        'Показывает preview, проверяет дубли, записывает продукт идемпотентно и перечитывает дневник. dry_run=true по умолчанию.',
      inputSchema: addConsumedItemInputSchema,
      outputSchema: toolOutputSchema(addConsumedItemOutputSchema),
      annotations: writeAnnotations,
    },
    async (input) =>
      safeResult(
        config,
        () => writeService.addConsumedItem(input),
        (data) => `Результат добавления: ${statusText(data)}.`,
      ),
  );

  server.registerTool(
    'add_meal_batch',
    {
      title: 'Пакетное добавление еды',
      description:
        'Последовательно добавляет до 25 продуктов; при частичной ошибке компенсирует ранее созданные записи и сообщает результат каждого элемента.',
      inputSchema: addMealBatchInputSchema,
      outputSchema: toolOutputSchema(batchOutputSchema),
      annotations: writeAnnotations,
    },
    async (input) =>
      safeResult(
        config,
        () => writeService.addMealBatch(input),
        (data) => `Результат batch: ${statusText(data)}.`,
      ),
  );

  server.registerTool(
    'update_consumed_item',
    {
      title: 'Изменить количество продукта',
      description:
        'Безопасно заменяет существующую запись продукта: создаёт и проверяет replacement, затем удаляет точный старый ID. При ошибке пытается компенсировать replacement. Нативный PATCH YAZIO не подтверждён.',
      inputSchema: updateConsumedItemInputSchema,
      outputSchema: toolOutputSchema(updateConsumedItemOutputSchema),
      annotations: removeAnnotations,
    },
    async (input, context: ServerContext) => {
      if (input.dry_run || input.confirmation_token !== undefined) {
        return safeResult(
          config,
          () => writeService.updateConsumedItem(input),
          (data) => `Результат изменения: ${statusText(data)}.`,
        );
      }
      const operationFingerprint = fingerprint({
        item_id: input.item_id,
        date: input.date,
        amount: input.amount,
      });
      const requestState = context.mcpReq.requestState<DestructiveRequestState>();
      let prepared: Awaited<ReturnType<WriteService['prepareConsumedItemUpdate']>>;
      try {
        prepared = await writeService.prepareConsumedItemUpdate(input);
      } catch (error) {
        return errorResult(error);
      }
      const response = acceptedContent(
        context.mcpReq.inputResponses,
        'confirm_update',
        confirmationSchema,
      );
      if (
        response?.confirm === true &&
        requestState?.operation === 'update_consumed_item' &&
        requestState.fingerprint === operationFingerprint
      ) {
        return safeResult(
          config,
          () => writeService.updateConsumedItem(input, { kind: 'mrtr' }),
          (data) => `Результат изменения: ${statusText(data)}.`,
        );
      }
      if (response?.confirm === false) {
        return errorResult(
          new NutritionMcpError('CONFIRMATION_REQUIRED', 'Изменение отменено пользователем.'),
        );
      }
      if (response?.confirm === true) {
        return errorResult(
          new NutritionMcpError(
            'CONFIRMATION_REQUIRED',
            'MRTR requestState отсутствует, истёк или не соответствует операции.',
          ),
        );
      }
      return inputRequired({
        inputRequests: {
          confirm_update: inputRequired.elicit({
            message:
              `Подтвердите изменение «${prepared.preview.old_item.name ?? input.item_id}» ` +
              `(${prepared.preview.old_item.daytime}, ${input.date}) ` +
              `с ${prepared.preview.old_item.amount} на ${input.amount}.`,
            requestedSchema: confirmationSchema,
          }),
        },
        requestState: await requestStateCodec.mint(
          {
            operation: 'update_consumed_item',
            fingerprint: operationFingerprint,
          },
          context,
        ),
      });
    },
  );

  server.registerTool(
    'remove_consumed_item',
    {
      title: 'Удалить запись еды',
      description:
        'Удаляет только конкретный diary item ID после MRTR-подтверждения. Fallback: dry-run выдаёт одноразовый confirmation_token с TTL.',
      inputSchema: removeConsumedItemInputSchema,
      outputSchema: toolOutputSchema(removeConsumedItemOutputSchema),
      annotations: removeAnnotations,
    },
    async (input, context: ServerContext) => {
      if (input.dry_run || input.confirmation_token !== undefined) {
        return safeResult(
          config,
          () => writeService.removeConsumedItem(input),
          (data) => `Результат удаления: ${statusText(data)}.`,
        );
      }
      const operationFingerprint = fingerprint({ date: input.date, item_id: input.item_id });
      const requestState = context.mcpReq.requestState<DestructiveRequestState>();
      let prepared: Awaited<ReturnType<WriteService['prepareConsumedItemRemoval']>>;
      try {
        prepared = await writeService.prepareConsumedItemRemoval(input);
      } catch (error) {
        return errorResult(error);
      }
      const response = acceptedContent(
        context.mcpReq.inputResponses,
        'confirm_removal',
        confirmationSchema,
      );
      if (
        response?.confirm === true &&
        requestState?.operation === 'remove_consumed_item' &&
        requestState.fingerprint === operationFingerprint
      ) {
        return safeResult(
          config,
          () => writeService.removeConsumedItem(input, { kind: 'mrtr' }),
          (data) => `Результат удаления: ${statusText(data)}.`,
        );
      }
      if (response?.confirm === false) {
        return errorResult(
          new NutritionMcpError('CONFIRMATION_REQUIRED', 'Удаление отменено пользователем.'),
        );
      }
      if (response?.confirm === true) {
        return errorResult(
          new NutritionMcpError(
            'CONFIRMATION_REQUIRED',
            'MRTR requestState отсутствует, истёк или не соответствует операции.',
          ),
        );
      }
      return inputRequired({
        inputRequests: {
          confirm_removal: inputRequired.elicit({
            message:
              `Подтвердите удаление «${prepared.item.name ?? input.item_id}» ` +
              `(${prepared.item.daytime}, ${prepared.item.amount}, ${input.date}).`,
            requestedSchema: confirmationSchema,
          }),
        },
        requestState: await requestStateCodec.mint(
          {
            operation: 'remove_consumed_item',
            fingerprint: operationFingerprint,
          },
          context,
        ),
      });
    },
  );

  server.registerTool(
    'add_water_intake',
    {
      title: 'Добавить воду',
      description:
        'Читает текущий кумулятивный объём, добавляет amount_ml, записывает новый total и проверяет повторным чтением.',
      inputSchema: addWaterInputSchema,
      outputSchema: toolOutputSchema(addWaterOutputSchema),
      annotations: writeAnnotations,
    },
    async (input) =>
      safeResult(
        config,
        () => writeService.addWaterIntake(input),
        (data) => `Результат воды: ${statusText(data)}.`,
      ),
  );

  server.registerTool(
    'get_nutrition_trends',
    {
      title: 'Тренды питания',
      description:
        'Агрегирует daily summary по дням, ISO-неделям или месяцам; считает средние, цели, стабильность и отклонения.',
      inputSchema: trendsInputSchema,
      outputSchema: toolOutputSchema(trendsOutputSchema),
      annotations: readAnnotations,
    },
    async ({ start_date, end_date, aggregation }) =>
      safeResult(
        config,
        async () => {
          const dates = enumerateDates(start_date, end_date, config.timezone, 366);
          const loaded = await loadDailySummaries(dates);
          return {
            ...aggregateTrends(loaded.summaries, aggregation),
            coverage: loaded.coverage,
            partial: loaded.partial,
          };
        },
        () => `Тренды ${start_date}–${end_date} рассчитаны.`,
      ),
  );

  server.registerTool(
    'compare_periods',
    {
      title: 'Сравнить периоды',
      description: 'Сравнивает средние calories/БЖУ двух диапазонов до 366 дней каждый.',
      inputSchema: comparePeriodsInputSchema,
      outputSchema: toolOutputSchema(comparePeriodsOutputSchema),
      annotations: readAnnotations,
    },
    async (input) =>
      safeResult(
        config,
        async () => {
          const firstDates = enumerateDates(
            input.first_start_date,
            input.first_end_date,
            config.timezone,
            366,
          );
          const secondDates = enumerateDates(
            input.second_start_date,
            input.second_end_date,
            config.timezone,
            366,
          );
          const firstLoaded = await loadDailySummaries(firstDates);
          const secondLoaded = await loadDailySummaries(secondDates);
          const compared = compareTrendPeriods(
            firstLoaded.summaries,
            secondLoaded.summaries,
          );
          return {
            first: {
              ...compared.first,
              coverage: firstLoaded.coverage,
              partial: firstLoaded.partial,
            },
            second: {
              ...compared.second,
              coverage: secondLoaded.coverage,
              partial: secondLoaded.partial,
            },
            change_percent: compared.change_percent,
            partial: firstLoaded.partial || secondLoaded.partial,
          };
        },
        () => 'Периоды сравнены.',
      ),
  );

  server.registerTool(
    'detect_probable_missing_meals',
    {
      title: 'Вероятные пропуски еды',
      description:
        'Находит подозрительно пустые meal buckets. Не создаёт записи и не утверждает, что пользователь действительно ел.',
      inputSchema: missingMealsInputSchema,
      outputSchema: toolOutputSchema(missingMealsOutputSchema),
      annotations: readAnnotations,
    },
    async ({ start_date, end_date, meals, maximum_recorded_calories }) =>
      safeResult(
        config,
        async () => {
          const dates = enumerateDates(start_date, end_date, config.timezone, 366);
          const loaded = await loadDailySummaries(dates);
          return {
            findings: detectMissingMeals(
              loaded.summaries,
              meals,
              maximum_recorded_calories,
            ),
            auto_write_performed: false,
            coverage: loaded.coverage,
            partial: loaded.partial,
          };
        },
        (data) => {
          const count =
            typeof data === 'object' &&
            data !== null &&
            Array.isArray((data as { findings?: unknown }).findings)
              ? (data as { findings: unknown[] }).findings.length
              : 0;
          return `Найдено ${count} вероятных пропусков; автоматических записей нет.`;
        },
      ),
  );

  return server;
};
