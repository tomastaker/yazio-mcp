import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  getRecipeInputSchema,
  updateConsumedItemInputSchema,
  updateConsumedItemOutputSchema,
  userRecipeDetailsOutputSchema,
  userRecipeIdsOutputSchema,
} from '../src/schemas.js';
import { ITEM_ID } from './fixtures/yazio.js';
import { USER_RECIPE_FIXTURE, USER_RECIPE_ID } from './fixtures/recipes.js';

describe('recipe and consumed-item update schemas', () => {
  it('requires a recipe UUID and exposes a strict ID-list output', () => {
    expect(getRecipeInputSchema.parse({ recipe_id: USER_RECIPE_ID })).toEqual({
      recipe_id: USER_RECIPE_ID,
    });
    expect(getRecipeInputSchema.safeParse({ recipe_id: 'not-a-uuid' }).success).toBe(false);
    expect(
      userRecipeIdsOutputSchema.parse({
        recipe_ids: [USER_RECIPE_ID],
      }),
    ).toEqual({ recipe_ids: [USER_RECIPE_ID] });
    expect(
      userRecipeIdsOutputSchema.safeParse({
        recipe_ids: [USER_RECIPE_ID],
        access_token: 'must-not-leak',
      }).success,
    ).toBe(false);
  });

  it('validates normalized recipe details without accepting raw nutrient records', () => {
    const { nutrients: rawNutrients, ...recipeWithoutRawNutrients } = USER_RECIPE_FIXTURE;
    expect(rawNutrients).toBeDefined();
    const normalized = {
      ...recipeWithoutRawNutrients,
      nutrition: {
        calories: 620,
        protein: 24,
        fat: 18,
        carbs: 92,
        fiber: 7,
        sugar: 6,
        energy_unit: 'kcal',
        mass_unit: 'g',
      },
      nutrition_basis: 'upstream_unspecified',
    };
    expect(userRecipeDetailsOutputSchema.parse(normalized)).toEqual(normalized);
    expect(userRecipeDetailsOutputSchema.safeParse(USER_RECIPE_FIXTURE).success).toBe(false);
  });

  it('defaults updates to dry-run and rejects unsafe or ambiguous quantities', () => {
    const parsed = updateConsumedItemInputSchema.parse({
      client_request_id: 'request-update-0001',
      item_id: ITEM_ID,
      date: '2026-07-29',
      amount: 210,
    });
    expect(parsed.dry_run).toBe(true);
    expect(
      updateConsumedItemInputSchema.safeParse({
        ...parsed,
        amount: 0,
      }).success,
    ).toBe(false);
    expect(
      updateConsumedItemInputSchema.safeParse({
        ...parsed,
        product_id: USER_RECIPE_ID,
      }).success,
    ).toBe(false);
  });

  it('declares replacement, rollback, and partial-failure output states', () => {
    const outputJson = JSON.stringify(z.toJSONSchema(updateConsumedItemOutputSchema));

    expect(outputJson).toContain('"replacement_entry_id"');
    expect(outputJson).toContain('"rolled_back"');
    expect(outputJson).toContain('"partial_failure"');
    expect(outputJson).not.toContain('"additionalProperties":{}');
  });
});
