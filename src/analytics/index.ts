import { DateTime } from 'luxon';
import type { Aggregation, DailySummary, MealType, Nutrition } from '../types.js';

const numericKeys = ['calories', 'protein', 'fat', 'carbs', 'fiber', 'sugar'] as const;
type NumericNutritionKey = (typeof numericKeys)[number];

const emptyNutrition = (): Nutrition => ({
  calories: 0,
  protein: 0,
  fat: 0,
  carbs: 0,
  fiber: 0,
  sugar: 0,
  energy_unit: 'kcal',
  mass_unit: 'g',
});

const sumNutrition = (rows: Nutrition[]): Nutrition => {
  const result = emptyNutrition();
  for (const row of rows) {
    for (const key of numericKeys) result[key] += row[key];
  }
  return result;
};

const divideNutrition = (nutrition: Nutrition, divisor: number): Nutrition => {
  const result = emptyNutrition();
  if (divisor === 0) return result;
  for (const key of numericKeys) result[key] = nutrition[key] / divisor;
  return result;
};

const round = (value: number, precision = 2): number => {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
};

const roundedNutrition = (nutrition: Nutrition): Nutrition => ({
  ...nutrition,
  calories: round(nutrition.calories),
  protein: round(nutrition.protein),
  fat: round(nutrition.fat),
  carbs: round(nutrition.carbs),
  fiber: round(nutrition.fiber),
  sugar: round(nutrition.sugar),
});

const periodKey = (date: string, aggregation: Aggregation): string => {
  const parsed = DateTime.fromISO(date, { zone: 'utc' });
  if (aggregation === 'month') return parsed.toFormat('yyyy-MM');
  if (aggregation === 'week') {
    return `${parsed.weekYear}-W${String(parsed.weekNumber).padStart(2, '0')}`;
  }
  return date;
};

const coefficientOfVariation = (values: number[]): number => {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
};

export interface TrendsResult {
  aggregation: Aggregation;
  days: number;
  average: Nutrition;
  goal_average: Nutrition;
  goal_comparison: {
    calories_percent: number | null;
    protein_percent: number | null;
    fat_percent: number | null;
    carbs_percent: number | null;
  };
  stability: {
    calories_coefficient_of_variation: number;
    mean_absolute_calorie_deviation: number;
  };
  periods: Array<{ period: string; days: number; average: Nutrition }>;
}

export const aggregateTrends = (
  summaries: DailySummary[],
  aggregation: Aggregation,
): TrendsResult => {
  const average = divideNutrition(
    sumNutrition(summaries.map((summary) => summary.nutrition)),
    summaries.length,
  );
  const goalAverage = divideNutrition(
    sumNutrition(summaries.map((summary) => summary.goal)),
    summaries.length,
  );
  const groups = new Map<string, DailySummary[]>();
  for (const summary of summaries) {
    const key = periodKey(summary.date, aggregation);
    groups.set(key, [...(groups.get(key) ?? []), summary]);
  }
  const percent = (actual: number, goal: number): number | null =>
    goal <= 0 ? null : round((actual / goal) * 100);
  return {
    aggregation,
    days: summaries.length,
    average: roundedNutrition(average),
    goal_average: roundedNutrition(goalAverage),
    goal_comparison: {
      calories_percent: percent(average.calories, goalAverage.calories),
      protein_percent: percent(average.protein, goalAverage.protein),
      fat_percent: percent(average.fat, goalAverage.fat),
      carbs_percent: percent(average.carbs, goalAverage.carbs),
    },
    stability: {
      calories_coefficient_of_variation: round(
        coefficientOfVariation(summaries.map((summary) => summary.nutrition.calories)),
        4,
      ),
      mean_absolute_calorie_deviation: round(
        summaries.length === 0
          ? 0
          : summaries.reduce(
              (total, summary) =>
                total + Math.abs(summary.nutrition.calories - average.calories),
              0,
            ) / summaries.length,
      ),
    },
    periods: [...groups.entries()].map(([period, rows]) => ({
      period,
      days: rows.length,
      average: roundedNutrition(
        divideNutrition(
          sumNutrition(rows.map((row) => row.nutrition)),
          rows.length,
        ),
      ),
    })),
  };
};

export const compareTrendPeriods = (
  first: DailySummary[],
  second: DailySummary[],
): {
  first: TrendsResult;
  second: TrendsResult;
  change_percent: Record<NumericNutritionKey, number | null>;
} => {
  const firstTrend = aggregateTrends(first, 'day');
  const secondTrend = aggregateTrends(second, 'day');
  const change = {} as Record<NumericNutritionKey, number | null>;
  for (const key of numericKeys) {
    change[key] =
      firstTrend.average[key] === 0
        ? null
        : round(
            ((secondTrend.average[key] - firstTrend.average[key]) / firstTrend.average[key]) *
              100,
          );
  }
  return { first: firstTrend, second: secondTrend, change_percent: change };
};

export interface MissingMealFinding {
  date: string;
  meal: MealType;
  recorded_calories: number;
  reason: string;
  confidence: 'low' | 'medium';
}

export const detectMissingMeals = (
  summaries: DailySummary[],
  meals: MealType[],
  maximumRecordedCalories: number,
): MissingMealFinding[] =>
  summaries.flatMap((summary) =>
    meals
      .filter((meal) => summary.meals[meal].calories <= maximumRecordedCalories)
      .map((meal) => ({
        date: summary.date,
        meal,
        recorded_calories: round(summary.meals[meal].calories),
        reason: `No more than ${maximumRecordedCalories} kcal was recorded; this may indicate missing logging but does not prove that no food was eaten.`,
        confidence: summary.meals[meal].calories === 0 ? ('medium' as const) : ('low' as const),
      })),
  );
