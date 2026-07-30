import { describe, expect, it } from 'vitest';
import { aggregateTrends, detectMissingMeals } from '../src/analytics/index.js';
import type { DailySummary } from '../src/types.js';

const summary = (date: string, calories: number): DailySummary => ({
  date,
  nutrition: {
    calories,
    protein: calories / 20,
    fat: calories / 30,
    carbs: calories / 10,
    fiber: 0,
    sugar: 0,
    energy_unit: 'kcal',
    mass_unit: 'g',
  },
  goal: {
    calories: 2000,
    protein: 100,
    fat: 70,
    carbs: 250,
    fiber: 0,
    sugar: 0,
    energy_unit: 'kcal',
    mass_unit: 'g',
  },
  water_ml: 1000,
  activity_calories: 0,
  steps: 0,
  meals: {
    breakfast: { calories: calories / 2, protein: 0, fat: 0, carbs: 0, fiber: 0, sugar: 0, energy_unit: 'kcal', mass_unit: 'g' },
    lunch: { calories: 0, protein: 0, fat: 0, carbs: 0, fiber: 0, sugar: 0, energy_unit: 'kcal', mass_unit: 'g' },
    dinner: { calories: calories / 2, protein: 0, fat: 0, carbs: 0, fiber: 0, sugar: 0, energy_unit: 'kcal', mass_unit: 'g' },
    snack: { calories: 0, protein: 0, fat: 0, carbs: 0, fiber: 0, sugar: 0, energy_unit: 'kcal', mass_unit: 'g' },
  },
});

describe('analytics', () => {
  it('aggregates averages, goal deviation and stability', () => {
    const trend = aggregateTrends([summary('2026-07-28', 1800), summary('2026-07-29', 2200)], 'day');
    expect(trend.average.calories).toBe(2000);
    expect(trend.goal_comparison.calories_percent).toBe(100);
    expect(trend.stability.calories_coefficient_of_variation).toBeCloseTo(0.1);
  });

  it('flags probable missing meals without proposing writes', () => {
    const findings = detectMissingMeals([summary('2026-07-29', 1800)], ['lunch'], 50);
    expect(findings).toEqual([
      expect.objectContaining({ date: '2026-07-29', meal: 'lunch', reason: expect.any(String) }),
    ]);
  });
});
