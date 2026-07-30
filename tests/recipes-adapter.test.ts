import { describe, expect, it, vi } from 'vitest';
import { YazioAdapter } from '../src/adapters/yazio-adapter.js';
import {
  SECOND_USER_RECIPE_ID,
  USER_RECIPE_FIXTURE,
  USER_RECIPE_ID,
} from './fixtures/recipes.js';
import { SUMMARY_FIXTURE } from './fixtures/yazio.js';

const adapterWith = (fetchImplementation: typeof fetch): YazioAdapter =>
  new YazioAdapter(
    {
      baseUrl: 'https://yzapi.yazio.com/v19',
      countries: ['RU'],
      locales: ['ru_RU'],
      defaultSex: 'male',
      timeoutMs: 1_000,
    },
    {
      getAccessToken: vi.fn().mockResolvedValue('fixture-access-token'),
      invalidate: vi.fn(),
    },
    fetchImplementation,
  );

const requestUrl = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, call: number): string => {
  const input = fetchMock.mock.calls[call]?.[0];
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : (input?.url ?? '');
};

describe('YazioAdapter user recipes', () => {
  it('lists only validated user recipe IDs from GET /user/recipes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify([USER_RECIPE_ID, SECOND_USER_RECIPE_ID]), { status: 200 }),
      );

    await expect(adapterWith(fetchMock).listUserRecipeIds()).resolves.toEqual([
      USER_RECIPE_ID,
      SECOND_USER_RECIPE_ID,
    ]);
    expect(requestUrl(fetchMock, 0)).toBe('https://yzapi.yazio.com/v19/user/recipes');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('rejects malformed recipe IDs instead of passing an upstream shape drift through', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify([USER_RECIPE_ID, 'not-a-uuid']), { status: 200 }));

    await expect(adapterWith(fetchMock).listUserRecipeIds()).rejects.toMatchObject({
      code: 'UPSTREAM_INVALID_RESPONSE',
    });
  });

  it('gets a recipe and normalizes its nutrients from GET /recipes/{id}', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(USER_RECIPE_FIXTURE), { status: 200 }));

    await expect(adapterWith(fetchMock).getRecipe(USER_RECIPE_ID)).resolves.toEqual({
      id: USER_RECIPE_ID,
      yazio_id: null,
      locale: 'ru_RU',
      name: 'Тестовая паста',
      portion_count: 2,
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
    });
    expect(requestUrl(fetchMock, 0)).toBe(
      `https://yzapi.yazio.com/v19/recipes/${USER_RECIPE_ID}`,
    );
  });

  it('returns null when a requested recipe does not exist', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(adapterWith(fetchMock).getRecipe(USER_RECIPE_ID)).resolves.toBeNull();
  });

  it('keeps recipe_id and portion_count when reading recipe portions from the diary', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          products: [],
          recipe_portions: [
            {
              id: '88888888-8888-4888-8888-888888888888',
              date: '2026-07-29',
              daytime: 'dinner',
              type: 'recipe_portion',
              recipe_id: USER_RECIPE_ID,
              portion_count: 1.5,
            },
          ],
          simple_products: [],
        }),
        { status: 200 },
      ),
    );

    await expect(adapterWith(fetchMock).getDiary('2026-07-29')).resolves.toMatchObject({
      items: [
        {
          kind: 'recipe_portion',
          recipe_id: USER_RECIPE_ID,
          product_id: null,
          amount: 1.5,
        },
      ],
    });
  });

  it('marks recipe totals complete only after using the daily summary', async () => {
    const diaryPayload = {
      products: [],
      recipe_portions: [
        {
          id: '88888888-8888-4888-8888-888888888888',
          date: '2026-07-29',
          daytime: 'dinner',
          type: 'recipe_portion',
          recipe_id: USER_RECIPE_ID,
          portion_count: 1,
        },
      ],
      simple_products: [],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(diaryPayload), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(USER_RECIPE_FIXTURE), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(SUMMARY_FIXTURE), { status: 200 }),
      );

    await expect(adapterWith(fetchMock).getDiary('2026-07-29')).resolves.toMatchObject({
      items: [
        {
          kind: 'recipe_portion',
          recipe_id: USER_RECIPE_ID,
          name: USER_RECIPE_FIXTURE.name,
          nutrition: null,
        },
      ],
      totals: { calories: 1170 },
      totals_complete: true,
      totals_source: 'daily_summary',
      missing_nutrition_item_ids: [],
    });
  });
});
