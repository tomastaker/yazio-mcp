import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { YazioAdapter } from '../../src/adapters/yazio-adapter.js';
import { AuthManager } from '../../src/auth/auth-manager.js';
import { FileTokenStore } from '../../src/auth/token-store.js';
import { loadConfig } from '../../src/config.js';
import { NutritionMcpError } from '../../src/errors.js';

const liveEnabled = process.env.YAZIO_LIVE_TEST === '1';

describe.skipIf(!liveEnabled)('YAZIO live integration', () => {
  const config = loadConfig();
  const auth = new AuthManager(
    {
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      username: config.username,
      password: config.password,
    },
    new FileTokenStore(config.tokenCachePath),
  );
  const adapter = new YazioAdapter(
    {
      baseUrl: config.baseUrl,
      countries: config.countries,
      locales: config.locales,
      defaultSex: config.defaultSex,
      timeoutMs: config.timeoutMs,
    },
    auth,
  );

  it('authenticates and reads the privacy-filtered profile', async () => {
    const profile = await adapter.getUserProfile();
    expect(profile.user_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(profile).not.toHaveProperty('email');
  });

  it('writes and always removes its own fixture entry', async () => {
    const productId = process.env.YAZIO_LIVE_PRODUCT_ID;
    if (!productId) {
      throw new Error('YAZIO_LIVE_PRODUCT_ID is required for the cleanup-safe live write test.');
    }
    const entryId = randomUUID();
    const date = new Date().toISOString().slice(0, 10);
    let operationError: unknown;
    let cleanupError: unknown;
    try {
      await adapter.addConsumedItem({
        id: entryId,
        product_id: productId,
        date,
        daytime: 'snack',
        amount: 1,
        serving: null,
        serving_quantity: null,
      });
      const diary = await adapter.getDiary(date);
      expect(diary.items.some((item) => item.id === entryId)).toBe(true);
    } catch (error) {
      operationError = error;
    } finally {
      try {
        await adapter.removeConsumedItem(entryId);
      } catch (error) {
        if (!(error instanceof NutritionMcpError && error.code === 'UPSTREAM_NOT_FOUND')) {
          cleanupError = error;
        }
      }
      try {
        const diary = await adapter.getDiary(date);
        expect(diary.items.some((item) => item.id === entryId)).toBe(false);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error ? cleanupError : new Error('Live cleanup failed.');
    }
    if (operationError !== undefined) {
      throw operationError instanceof Error ? operationError : new Error('Live operation failed.');
    }
  });
});
