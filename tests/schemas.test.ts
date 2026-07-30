import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  addConsumedItemOutputSchema,
  addConsumedItemInputSchema,
  batchOutputSchema,
  comparePeriodsOutputSchema,
  dateRangeSchema,
  missingMealsOutputSchema,
  nutritionSchema,
  trendsOutputSchema,
  toolErrorSchema,
} from '../src/schemas.js';
import { PRODUCT_ID } from './fixtures/yazio.js';

describe('schemas', () => {
  it('rejects inverted date ranges and invalid calendar dates', () => {
    expect(dateRangeSchema.safeParse({ start_date: '2026-02-30', end_date: '2026-03-01' }).success).toBe(
      false,
    );
    expect(dateRangeSchema.safeParse({ start_date: '2026-03-02', end_date: '2026-03-01' }).success).toBe(
      false,
    );
  });

  it('requires idempotency keys for writes and defaults to dry-run', () => {
    const parsed = addConsumedItemInputSchema.parse({
      client_request_id: 'request-0001',
      product_id: PRODUCT_ID,
      date: '2026-07-29',
      daytime: 'breakfast',
      amount: 80,
    });
    expect(parsed.dry_run).toBe(true);
    expect(
      addConsumedItemInputSchema.safeParse({
        ...parsed,
        unexpected_confirmation_bypass: true,
      }).success,
    ).toBe(false);
  });

  it('normalizes all required nutrition fields and machine-readable errors', () => {
    expect(
      nutritionSchema.safeParse({
        calories: 1,
        protein: 2,
        fat: 3,
        carbs: 4,
        fiber: 5,
        sugar: 6,
        energy_unit: 'kcal',
        mass_unit: 'g',
      }).success,
    ).toBe(true);
    expect(
      toolErrorSchema.safeParse({
        ok: false,
        error: { code: 'AUTH_FAILED', message: 'Authentication failed', retryable: false },
      }).success,
    ).toBe(true);
  });

  it('declares strict machine-readable write and analytics contracts', () => {
    const addJson = z.toJSONSchema(addConsumedItemOutputSchema);
    const batchJson = z.toJSONSchema(batchOutputSchema);
    const trendsJson = z.toJSONSchema(trendsOutputSchema);
    const compareJson = z.toJSONSchema(comparePeriodsOutputSchema);
    const missingJson = z.toJSONSchema(missingMealsOutputSchema);

    expect(JSON.stringify(addJson)).toContain('"verified"');
    expect(JSON.stringify(batchJson)).toContain('"not_attempted"');
    expect(JSON.stringify(trendsJson)).toContain('"goal_comparison"');
    expect(JSON.stringify(compareJson)).toContain('"change_percent"');
    expect(JSON.stringify(missingJson)).toContain('"recorded_calories"');
    for (const schema of [addJson, batchJson, trendsJson, compareJson, missingJson]) {
      expect(JSON.stringify(schema)).not.toContain('"additionalProperties":{}');
    }
  });
});
