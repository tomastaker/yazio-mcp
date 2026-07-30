import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NutritionMcpError } from '../errors.js';
import { tokenSchema, type StoredToken, type TokenStore } from './token-store.js';

export interface AuthConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string | undefined;
  password: string | undefined;
  timeoutMs?: number;
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
  invalidate(): Promise<void> | void;
}

const oauthResponseSchema = tokenSchema.omit({ expires_at: true, account_binding: true });

export const authAccountBinding = (
  config: Pick<AuthConfig, 'baseUrl' | 'clientId' | 'username'>,
): string | null => {
  if (config.username === undefined) return null;
  return createHash('sha256')
    .update(
      `${config.baseUrl.replace(/\/+$/, '').toLowerCase()}\0${config.clientId}\0${config.username.trim().toLowerCase()}`,
    )
    .digest('hex');
};

export class AuthManager implements AccessTokenProvider {
  private token: StoredToken | null = null;
  private pending: Promise<StoredToken> | null = null;

  constructor(
    private readonly config: AuthConfig,
    private readonly store: TokenStore,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.token !== null && this.isUsable(this.token)) return this.token.access_token;
    let stored = this.token ?? (await this.store.load());
    if (stored !== null && !this.matchesConfiguredAccount(stored)) {
      await this.store.clear();
      stored = null;
      this.token = null;
    }
    if (stored !== null && this.isUsable(stored)) {
      this.token = stored;
      return stored.access_token;
    }
    this.pending ??= this.obtainToken(stored).finally(() => {
      this.pending = null;
    });
    this.token = await this.pending;
    return this.token.access_token;
  }

  invalidate(): void {
    if (this.token !== null) this.token = { ...this.token, expires_at: 0 };
  }

  private isUsable(token: StoredToken): boolean {
    return token.expires_at - 60_000 > Date.now();
  }

  private matchesConfiguredAccount(token: StoredToken): boolean {
    const expected = authAccountBinding(this.config);
    return expected === null || token.account_binding === expected;
  }

  private async obtainToken(expired: StoredToken | null): Promise<StoredToken> {
    if (expired?.refresh_token) {
      try {
        return await this.requestToken({
          grant_type: 'refresh_token',
          refresh_token: expired.refresh_token,
        });
      } catch (error) {
        if (
          !(error instanceof NutritionMcpError) ||
          error.code !== 'AUTH_FAILED' ||
          error.details?.reason !== 'invalid_grant'
        ) {
          throw error;
        }
      }
    }
    if (!this.config.username || !this.config.password) {
      throw new NutritionMcpError(
        'AUTH_REQUIRED',
        'Нужны YAZIO_USERNAME и YAZIO_PASSWORD: refresh token отсутствует или отклонён.',
      );
    }
    return this.requestToken({
      grant_type: 'password',
      username: this.config.username,
      password: this.config.password,
    });
  }

  private async requestToken(grant: Record<string, string>): Promise<StoredToken> {
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.config.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          ...grant,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new NutritionMcpError('AUTH_FAILED', 'Сетевой сбой авторизации YAZIO.', {
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      let reason: string | undefined;
      try {
        const errorPayload = z
          .object({ error: z.string() })
          .passthrough()
          .safeParse(await response.json());
        reason = errorPayload.success ? errorPayload.data.error : undefined;
      } catch {
        // OAuth error bodies are untrusted and intentionally not surfaced.
      }
      throw new NutritionMcpError(
        response.status === 401 || response.status === 400 ? 'AUTH_FAILED' : 'UPSTREAM_ERROR',
        'YAZIO отклонил запрос авторизации.',
        {
          retryable: response.status >= 500,
          ...(reason === undefined ? {} : { details: { reason } }),
        },
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new NutritionMcpError('UPSTREAM_INVALID_RESPONSE', 'YAZIO вернул невалидный OAuth JSON.', {
        cause: error,
      });
    }
    const parsed = oauthResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new NutritionMcpError('UPSTREAM_INVALID_RESPONSE', 'YAZIO вернул неполный OAuth token.');
    }
    const accountBinding = authAccountBinding(this.config);
    const token: StoredToken = {
      ...parsed.data,
      expires_at: Date.now() + parsed.data.expires_in * 1000,
      ...(accountBinding === null ? {} : { account_binding: accountBinding }),
    };
    await this.store.save(token);
    return token;
  }
}
