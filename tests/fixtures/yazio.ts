export const TOKEN_FIXTURE = {
  token_type: 'bearer',
  access_token: 'fixture-access-token',
  refresh_token: 'fixture-refresh-token',
  expires_in: 3600,
} as const;

export const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
export const ITEM_ID = '22222222-2222-4222-8222-222222222222';

export const PRODUCT_FIXTURE = {
  id: PRODUCT_ID,
  name: 'Овсяные хлопья',
  producer: 'Fixture Foods',
  base_unit: 'g',
  nutrients: {
    'energy.energy': 3.7,
    'nutrient.protein': 0.13,
    'nutrient.fat': 0.07,
    'nutrient.carb': 0.62,
    'nutrient.dietaryfiber': 0.1,
    'nutrient.sugar': 0.01,
  },
  servings: [{ serving: 'portion', amount: 40 }],
  eans: [],
  language: 'ru',
  countries: ['RU'],
  is_verified: true,
  is_private: false,
  is_deleted: false,
  has_ean: false,
  category: 'grain',
  updated_at: '2026-01-01T00:00:00Z',
} as const;

export const DIARY_FIXTURE = {
  products: [
    {
      id: ITEM_ID,
      date: '2026-07-29',
      daytime: 'breakfast',
      type: 'product',
      product_id: PRODUCT_ID,
      amount: 80,
      serving: null,
      serving_quantity: null,
    },
  ],
  recipe_portions: [],
  simple_products: [],
} as const;

export const SUMMARY_FIXTURE = {
  activity_energy: 120,
  consume_activity_energy: true,
  steps: 4500,
  water_intake: 1250,
  goals: {
    'energy.energy': 2000,
    'nutrient.protein': 100,
    'nutrient.fat': 70,
    'nutrient.carb': 250,
    water: 2000,
    'activity.step': 8000,
    'bodyvalue.weight': 70,
  },
  units: {
    unit_mass: 'kg',
    unit_energy: 'kcal',
    unit_serving: 'g',
    unit_length: 'cm',
  },
  meals: {
    breakfast: {
      energy_goal: 500,
      nutrients: {
        'energy.energy': 450,
        'nutrient.protein': 25,
        'nutrient.fat': 15,
        'nutrient.carb': 55,
      },
    },
    lunch: {
      energy_goal: 700,
      nutrients: {
        'energy.energy': 0,
        'nutrient.protein': 0,
        'nutrient.fat': 0,
        'nutrient.carb': 0,
      },
    },
    dinner: {
      energy_goal: 600,
      nutrients: {
        'energy.energy': 620,
        'nutrient.protein': 40,
        'nutrient.fat': 20,
        'nutrient.carb': 65,
      },
    },
    snack: {
      energy_goal: 200,
      nutrients: {
        'energy.energy': 100,
        'nutrient.protein': 5,
        'nutrient.fat': 3,
        'nutrient.carb': 15,
      },
    },
  },
  user: { current_weight: 72, goal: 'lose_weight', sex: 'male' },
  active_fasting_countdown_template_key: null,
} as const;
