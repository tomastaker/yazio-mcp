import { describe, expect, it, vi } from 'vitest';
import { YazioAdapter } from '../src/adapters/yazio-adapter.js';
import { PRODUCT_FIXTURE, PRODUCT_ID } from './fixtures/yazio.js';

describe('YazioAdapter', () => {
  it('uses Russian product search defaults and normalizes nutrients', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            score: 0.9,
            name: PRODUCT_FIXTURE.name,
            product_id: PRODUCT_ID,
            serving: 'portion',
            serving_quantity: 1,
            amount: 100,
            base_unit: 'g',
            producer: PRODUCT_FIXTURE.producer,
            is_verified: true,
            nutrients: PRODUCT_FIXTURE.nutrients,
            countries: ['RU'],
            language: 'ru',
          },
        ]),
        { status: 200 },
      ),
    );
    const adapter = new YazioAdapter(
      {
        baseUrl: 'https://yzapi.yazio.com/v20',
        countries: ['RU'],
        locales: ['ru_RU'],
        defaultSex: 'male',
        timeoutMs: 1000,
      },
      { getAccessToken: vi.fn().mockResolvedValue('fixture-access-token'), invalidate: vi.fn() },
      fetchMock,
    );

    const products = await adapter.searchProducts({ query: 'овсянка' });
    const requestInput = fetchMock.mock.calls[0]?.[0];
    const requestUrl =
      typeof requestInput === 'string'
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.href
          : (requestInput?.url ?? '');
    expect(requestUrl).toContain('countries=RU');
    expect(requestUrl).toContain('locales=ru_RU');
    expect(products[0]?.nutrition).toEqual({
      calories: 370,
      protein: 13,
      fat: 7,
      carbs: 62,
      fiber: 10,
      sugar: 1,
      energy_unit: 'kcal',
      mass_unit: 'g',
    });
  });

  it('retries once with a refreshed token after a 401', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(PRODUCT_FIXTURE), { status: 200 }));
    const auth = {
      getAccessToken: vi
        .fn()
        .mockResolvedValueOnce('expired-access-token')
        .mockResolvedValueOnce('fresh-access-token'),
      invalidate: vi.fn(),
    };
    const adapter = new YazioAdapter(
      {
        baseUrl: 'https://yzapi.yazio.com/v20',
        countries: ['RU'],
        locales: ['ru_RU'],
        defaultSex: 'male',
        timeoutMs: 1000,
      },
      auth,
      fetchMock,
    );

    await expect(adapter.getProduct(PRODUCT_ID)).resolves.toMatchObject({ id: PRODUCT_ID });
    expect(auth.invalidate).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['/user', {}, 'getUserProfile'],
    [
      '/user/consumed-items?date=2026-07-29',
      {},
      'getDiary',
    ],
    [
      '/user/widgets/daily-summary?date=2026-07-29',
      { meals: {}, goals: {} },
      'getDailySummary',
    ],
    ['/user/water-intake?date=2026-07-29', {}, 'getWaterIntake'],
  ] as const)(
    'rejects malformed successful payloads for %s',
    async (_path, payload, method) => {
      const adapter = new YazioAdapter(
        {
          baseUrl: 'https://yzapi.yazio.com/v20',
          countries: ['RU'],
          locales: ['ru_RU'],
          defaultSex: 'male',
          timeoutMs: 1000,
        },
        { getAccessToken: vi.fn().mockResolvedValue('fixture-access-token'), invalidate: vi.fn() },
        vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })),
      );

      const invocation =
        method === 'getUserProfile'
          ? adapter.getUserProfile()
          : method === 'getDiary'
            ? adapter.getDiary('2026-07-29')
            : method === 'getDailySummary'
              ? adapter.getDailySummary('2026-07-29')
              : adapter.getWaterIntake('2026-07-29');
      await expect(invocation).rejects.toMatchObject({ code: 'UPSTREAM_INVALID_RESPONSE' });
    },
  );

  it('retries a read once after Retry-After without retrying mutations', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{}', { status: 429, headers: { 'retry-after': '0' } }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(PRODUCT_FIXTURE), { status: 200 }));
    const adapter = new YazioAdapter(
      {
        baseUrl: 'https://yzapi.yazio.com/v20',
        countries: ['RU'],
        locales: ['ru_RU'],
        defaultSex: 'male',
        timeoutMs: 1000,
      },
      { getAccessToken: vi.fn().mockResolvedValue('fixture-access-token'), invalidate: vi.fn() },
      fetchMock,
    );

    await expect(adapter.getProduct(PRODUCT_ID)).resolves.toMatchObject({ id: PRODUCT_ID });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const mutationFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 429, headers: { 'retry-after': '0' } }));
    const mutationAdapter = new YazioAdapter(
      {
        baseUrl: 'https://yzapi.yazio.com/v20',
        countries: ['RU'],
        locales: ['ru_RU'],
        defaultSex: 'male',
        timeoutMs: 1000,
      },
      { getAccessToken: vi.fn().mockResolvedValue('fixture-access-token'), invalidate: vi.fn() },
      mutationFetch,
    );
    await expect(
      mutationAdapter.addConsumedItem({
        id: '55555555-5555-4555-8555-555555555555',
        product_id: PRODUCT_ID,
        date: '2026-07-29',
        daytime: 'breakfast',
        amount: 10,
        serving: null,
        serving_quantity: null,
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED' });
    expect(mutationFetch).toHaveBeenCalledOnce();
  });
});
