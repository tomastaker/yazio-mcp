import { describe, expect, it } from 'vitest';
import {
  DEFAULT_YAZIO_CLIENT_ID,
  DEFAULT_YAZIO_CLIENT_SECRET,
} from '../src/auth/yazio-client-credentials.js';
import { loadConfig } from '../src/config.js';
import { todayInZone } from '../src/domain/dates.js';

describe('YAZIO authentication configuration', () => {
  it('requires only username and password for the initial login', () => {
    const config = loadConfig({
      YAZIO_USERNAME: 'fixture@example.test',
      YAZIO_PASSWORD: 'fixture-password',
    });

    expect(config.username).toBe('fixture@example.test');
    expect(config.password).toBe('fixture-password');
    expect(config.clientId).toBe(DEFAULT_YAZIO_CLIENT_ID);
    expect(config.clientSecret).toBe(DEFAULT_YAZIO_CLIENT_SECRET);
    expect(config.baseUrl).toBe('https://yzapi.yazio.com/v19');
  });

  it('allows an advanced client credential pair override', () => {
    const config = loadConfig({
      YAZIO_CLIENT_ID: 'replacement-client',
      YAZIO_CLIENT_SECRET: 'replacement-secret',
    });

    expect(config.clientId).toBe('replacement-client');
    expect(config.clientSecret).toBe('replacement-secret');
  });

  it.each([
    { YAZIO_CLIENT_ID: 'partial-client' },
    { YAZIO_CLIENT_SECRET: 'partial-secret' },
  ])('rejects a partial client credential override', (environment) => {
    expect(() => loadConfig(environment)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_ERROR' }),
    );
  });
});

describe('timezone configuration', () => {
  it('rejects an unknown IANA timezone at startup', () => {
    expect(() =>
      loadConfig({ YAZIO_MCP_TIMEZONE: 'Mars/Olympus_Mons' }),
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_ERROR' }));
    expect(() => todayInZone('Mars/Olympus_Mons')).toThrowError(
      expect.objectContaining({ code: 'CONFIG_ERROR' }),
    );
  });

  it('accepts the legacy timezone alias during migration', () => {
    expect(
      loadConfig({ NUTRITION_MCP_TIMEZONE: 'Asia/Tokyo' }).timezone,
    ).toBe('Asia/Tokyo');
  });

  it('rejects conflicting current and legacy aliases', () => {
    expect(() =>
      loadConfig({
        YAZIO_MCP_TIMEZONE: 'Europe/Moscow',
        NUTRITION_MCP_TIMEZONE: 'Asia/Tokyo',
      }),
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_ERROR' }));
  });
});
