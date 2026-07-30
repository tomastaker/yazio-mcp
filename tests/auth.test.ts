import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../src/auth/auth-manager.js';
import { FileTokenStore } from '../src/auth/token-store.js';
import { TOKEN_FIXTURE } from './fixtures/yazio.js';

const fetchMock = vi.fn<typeof fetch>();

afterEach(() => {
  fetchMock.mockReset();
});

describe('AuthManager', () => {
  it('refreshes an expired cached token and writes cache with 0600 permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nutrition-mcp-auth-'));
    const path = join(directory, 'token.json');
    const store = new FileTokenStore(path);
    await store.save({ ...TOKEN_FIXTURE, expires_at: Date.now() - 1 });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...TOKEN_FIXTURE,
          access_token: 'refreshed-access-token',
          refresh_token: 'rotated-refresh-token',
        }),
        { status: 200 },
      ),
    );

    const auth = new AuthManager(
      {
        baseUrl: 'https://yzapi.yazio.com/v20',
        clientId: 'fixture-client',
        clientSecret: 'fixture-secret',
        username: 'fixture@example.test',
        password: 'fixture-password',
      },
      store,
      fetchMock,
    );

    await expect(auth.getAccessToken()).resolves.toBe('refreshed-access-token');
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof requestBody).toBe('string');
    const request = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as Record<
      string,
      string
    >;
    expect(request).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: TOKEN_FIXTURE.refresh_token,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty('password');
  });

  it('falls back to password grant when refresh is rejected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nutrition-mcp-auth-'));
    const store = new FileTokenStore(join(directory, 'token.json'));
    await store.save({ ...TOKEN_FIXTURE, expires_at: Date.now() - 1 });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 }));

    const auth = new AuthManager(
      {
        baseUrl: 'https://yzapi.yazio.com/v20',
        clientId: 'fixture-client',
        clientSecret: 'fixture-secret',
        username: 'fixture@example.test',
        password: 'fixture-password',
      },
      store,
      fetchMock,
    );

    await expect(auth.getAccessToken()).resolves.toBe(TOKEN_FIXTURE.access_token);
    const rawSecondBody = fetchMock.mock.calls[1]?.[1]?.body;
    expect(typeof rawSecondBody).toBe('string');
    const secondBody = JSON.parse(
      typeof rawSecondBody === 'string' ? rawSecondBody : '{}',
    ) as Record<string, string>;
    expect(secondBody.grant_type).toBe('password');
  });

  it('does not send the password when refresh fails for a reason other than invalid_grant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nutrition-mcp-auth-'));
    const store = new FileTokenStore(join(directory, 'token.json'));
    await store.save({ ...TOKEN_FIXTURE, expires_at: Date.now() - 1 });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }),
    );
    const auth = new AuthManager(
      {
        baseUrl: 'https://yzapi.yazio.com/v20',
        clientId: 'fixture-client',
        clientSecret: 'fixture-secret',
        username: 'fixture@example.test',
        password: 'fixture-password',
      },
      store,
      fetchMock,
    );

    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
