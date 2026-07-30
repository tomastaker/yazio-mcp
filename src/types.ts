export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type Aggregation = 'day' | 'week' | 'month';

export interface Nutrition {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  fiber: number;
  sugar: number;
  energy_unit: 'kcal';
  mass_unit: 'g';
}

export interface Product {
  id: string;
  name: string;
  producer: string | null;
  base_unit: string;
  serving: string | null;
  serving_quantity: number | null;
  amount: number;
  is_verified: boolean;
  countries: string[];
  language: string;
  nutrition: Nutrition;
}

export interface ProductDetails extends Product {
  servings: Array<{ serving: string; amount: number }>;
  eans: string[];
  category: string | null;
}

export interface DiaryItem {
  id: string;
  date: string;
  daytime: MealType;
  kind: 'product' | 'recipe_portion' | 'simple_product';
  product_id: string | null;
  name: string | null;
  amount: number;
  serving: string | null;
  serving_quantity: number | null;
  nutrition: Nutrition | null;
}

export interface DiaryDay {
  date: string;
  items: DiaryItem[];
  totals: Nutrition;
}

export interface Goals {
  date: string;
  nutrition: Nutrition;
  water_ml: number;
  steps: number;
  weight_kg: number | null;
}

export interface UserProfile {
  user_id: string;
  first_name: string | null;
  sex: string | null;
  country: string | null;
  goal: string | null;
  diet: string | null;
  unit_energy: string | null;
  unit_mass: string | null;
}

export interface WaterIntake {
  date: string;
  water_ml: number;
}

export interface WeightEntry {
  id: string;
  date: string;
  weight_kg: number | null;
}

export interface Exercise {
  id: string;
  date: string;
  name: string;
  calories: number;
  duration_seconds: number;
  distance_meters: number;
  steps: number;
}

export interface DailySummary {
  date: string;
  nutrition: Nutrition;
  goal: Nutrition;
  water_ml: number;
  activity_calories: number;
  steps: number;
  meals: Record<MealType, Nutrition>;
}

export interface ConsumedItemInput {
  id: string;
  product_id: string;
  date: string;
  daytime: MealType;
  amount: number;
  serving: string | null;
  serving_quantity: number | null;
}

export interface WaterWriteInput {
  dateTime: string;
  cumulativeMl: number;
}

export interface NutritionBackend {
  getUserProfile(): Promise<UserProfile>;
  getGoals(date: string): Promise<Goals>;
  searchProducts(input: {
    query: string;
    countries?: string[] | undefined;
    locales?: string[] | undefined;
    sex?: 'male' | 'female' | undefined;
    limit?: number | undefined;
  }): Promise<Product[]>;
  getProduct(id: string): Promise<ProductDetails | null>;
  getDiary(date: string): Promise<DiaryDay>;
  getDailySummary(date: string): Promise<DailySummary>;
  getWaterIntake(date: string): Promise<WaterIntake>;
  getWeight(date: string): Promise<WeightEntry | null>;
  getExercises(date: string): Promise<Exercise[]>;
  addConsumedItem(input: ConsumedItemInput): Promise<void>;
  removeConsumedItem(itemId: string): Promise<void>;
  setWaterIntake(input: WaterWriteInput): Promise<void>;
}
