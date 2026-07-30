import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { todayInZone } from '../src/domain/dates.js';

describe('timezone configuration', () => {
  it('rejects an unknown IANA timezone at startup', () => {
    expect(() =>
      loadConfig({ NUTRITION_MCP_TIMEZONE: 'Mars/Olympus_Mons' }),
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_ERROR' }));
    expect(() => todayInZone('Mars/Olympus_Mons')).toThrowError(
      expect.objectContaining({ code: 'CONFIG_ERROR' }),
    );
  });
});
