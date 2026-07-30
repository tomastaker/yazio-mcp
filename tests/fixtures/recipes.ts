export const USER_RECIPE_ID = '66666666-6666-4666-8666-666666666666';
export const SECOND_USER_RECIPE_ID = '77777777-7777-4777-8777-777777777777';

export const USER_RECIPE_FIXTURE = {
  id: USER_RECIPE_ID,
  yazio_id: null,
  locale: 'ru_RU',
  name: 'Тестовая паста',
  portion_count: 2,
  nutrients: {
    'energy.energy': 620,
    'nutrient.protein': 24,
    'nutrient.fat': 18,
    'nutrient.carb': 92,
    'nutrient.dietaryfiber': 7,
    'nutrient.sugar': 6,
  },
  image: null,
  instructions: ['Смешать ингредиенты'],
  is_yazio_recipe: false,
  available_since: null,
  is_pro_recipe: false,
  servings: [
    {
      producer: 'Fixture Foods',
      name: 'Макароны',
      amount: 200,
      base_unit: 'g',
      serving: null,
      serving_quantity: null,
      note: null,
      product_id: '11111111-1111-4111-8111-111111111111',
    },
  ],
} as const;
