import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { NutritionMcpError } from '../errors.js';

const entrySchema = z.object({
  fingerprint: z.string(),
  status: z.enum(['pending', 'completed', 'failed']),
  updated_at: z.string(),
  result: z.unknown().optional(),
});

const stateSchema = z.object({
  version: z.literal(1),
  requests: z.record(z.string(), entrySchema),
  request_state_secret: z.string().optional(),
  confirmations: z
    .record(
      z.string(),
      z.object({
        fingerprint: z.string(),
        expires_at: z.number().int(),
      }),
    )
    .optional(),
});

type State = z.infer<typeof stateSchema>;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};

export const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');

export type BeginResult<T> = { kind: 'new' } | { kind: 'cached'; result: T };

export interface IdempotencyStore {
  begin<T>(tool: string, requestId: string, requestFingerprint: string): Promise<BeginResult<T>>;
  complete(tool: string, requestId: string, result: unknown): Promise<void>;
  fail(tool: string, requestId: string): Promise<void>;
  runExclusive<T>(resource: string, operation: () => Promise<T>): Promise<T>;
  issueConfirmation(requestFingerprint: string, ttlMs?: number): Promise<{
    token: string;
    expiresAt: string;
  }>;
  consumeConfirmation(token: string, requestFingerprint: string): Promise<boolean>;
  requestStateKey(): Promise<Uint8Array>;
}

export interface FileLockOptions {
  staleLockMs?: number;
  acquireTimeoutMs?: number;
  pollIntervalMs?: number;
  heartbeatMs?: number;
}

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  instance_id: z.string(),
});

export class FileIdempotencyStore implements IdempotencyStore {
  private queue: Promise<void> = Promise.resolve();
  private readonly instanceId = randomUUID();
  private readonly lockOptions: Required<FileLockOptions>;

  constructor(
    private readonly path: string,
    private readonly scope: string,
    lockOptions: FileLockOptions = {},
  ) {
    this.lockOptions = {
      staleLockMs: lockOptions.staleLockMs ?? 10_000,
      acquireTimeoutMs: lockOptions.acquireTimeoutMs ?? 150_000,
      pollIntervalMs: lockOptions.pollIntervalMs ?? 50,
      heartbeatMs: lockOptions.heartbeatMs ?? 2_000,
    };
  }

  async begin<T>(
    tool: string,
    requestId: string,
    requestFingerprint: string,
  ): Promise<BeginResult<T>> {
    return this.serialized(async () => {
      const state = await this.load();
      const key = this.key(tool, requestId);
      const existing = state.requests[key];
      if (existing !== undefined) {
        if (existing.fingerprint !== requestFingerprint) {
          throw new NutritionMcpError(
            'IDEMPOTENCY_CONFLICT',
            'client_request_id has already been used with different parameters.',
          );
        }
        if (existing.status === 'completed') {
          return { kind: 'cached', result: existing.result as T };
        }
        if (existing.status === 'pending') {
          throw new NutritionMcpError(
            'IDEMPOTENCY_UNCERTAIN',
            'The previous operation with this client_request_id has an uncertain outcome; another write is blocked.',
          );
        }
      }
      state.requests[key] = {
        fingerprint: requestFingerprint,
        status: 'pending',
        updated_at: new Date().toISOString(),
      };
      await this.save(state);
      return { kind: 'new' };
    });
  }

  async complete(tool: string, requestId: string, result: unknown): Promise<void> {
    await this.serialized(async () => {
      const state = await this.load();
      const key = this.key(tool, requestId);
      const existing = state.requests[key];
      if (existing === undefined) {
        throw new NutritionMcpError('INTERNAL_ERROR', 'The idempotency journal entry is missing.');
      }
      state.requests[key] = {
        ...existing,
        status: 'completed',
        result,
        updated_at: new Date().toISOString(),
      };
      await this.save(state);
    });
  }

  async fail(tool: string, requestId: string): Promise<void> {
    await this.serialized(async () => {
      const state = await this.load();
      const key = this.key(tool, requestId);
      const existing = state.requests[key];
      if (existing !== undefined) {
        state.requests[key] = {
          ...existing,
          status: 'failed',
          updated_at: new Date().toISOString(),
        };
        await this.save(state);
      }
    });
  }

  async runExclusive<T>(resource: string, operation: () => Promise<T>): Promise<T> {
    const resourceHash = createHash('sha256').update(resource).digest('hex').slice(0, 24);
    return this.withFileLock(operation, `${this.path}.${resourceHash}.lock`);
  }

  async issueConfirmation(
    requestFingerprint: string,
    ttlMs = 10 * 60_000,
  ): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = fingerprint(token);
    const scopedFingerprint = fingerprint({ scope: this.scope, requestFingerprint });
    const expiresAt = Date.now() + ttlMs;
    await this.serialized(async () => {
      const state = await this.load();
      const confirmations = this.activeConfirmations(state);
      confirmations[tokenHash] = {
        fingerprint: scopedFingerprint,
        expires_at: expiresAt,
      };
      state.confirmations = confirmations;
      await this.save(state);
    });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async consumeConfirmation(token: string, requestFingerprint: string): Promise<boolean> {
    return this.serialized(async () => {
      const state = await this.load();
      const confirmations = this.activeConfirmations(state);
      const tokenHash = fingerprint(token);
      const scopedFingerprint = fingerprint({ scope: this.scope, requestFingerprint });
      const confirmation = confirmations[tokenHash];
      if (
        confirmation === undefined ||
        confirmation.fingerprint !== scopedFingerprint ||
        confirmation.expires_at <= Date.now()
      ) {
        state.confirmations = confirmations;
        await this.save(state);
        return false;
      }
      delete confirmations[tokenHash];
      state.confirmations = confirmations;
      await this.save(state);
      return true;
    });
  }

  async requestStateKey(): Promise<Uint8Array> {
    return this.serialized(async () => {
      const state = await this.load();
      if (state.request_state_secret === undefined) {
        state.request_state_secret = randomBytes(32).toString('base64url');
        await this.save(state);
      }
      return Buffer.from(state.request_state_secret, 'base64url');
    });
  }

  private key(tool: string, requestId: string): string {
    return `${this.scope}:${tool}:${requestId}`;
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    let release: () => void = () => undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.withFileLock(operation);
    } finally {
      release();
    }
  }

  private async withFileLock<T>(
    operation: () => Promise<T>,
    lockPath = `${this.path}.lock`,
  ): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    for (;;) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await this.removeAbandonedLock(lockPath)) continue;
        if (Date.now() - startedAt >= this.lockOptions.acquireTimeoutMs) break;
        await new Promise((resolve) => setTimeout(resolve, this.lockOptions.pollIntervalMs));
        continue;
      }

      const ownerPath = join(lockPath, 'owner.json');
      try {
        await writeFile(
          ownerPath,
          JSON.stringify({ pid: process.pid, instance_id: this.instanceId }),
          { mode: 0o600, flag: 'wx' },
        );
      } catch (error) {
        await unlink(ownerPath).catch(() => undefined);
        await rmdir(lockPath).catch(() => undefined);
        throw error;
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(lockPath, now, now).catch(() => undefined);
      }, this.lockOptions.heartbeatMs);
      heartbeat.unref();
      try {
        return await operation();
      } finally {
        clearInterval(heartbeat);
        await this.releaseOwnedLock(lockPath, ownerPath);
      }
    }
    throw new NutritionMcpError(
      'CONFIG_ERROR',
      'Unable to acquire the idempotency journal lock.',
      { retryable: true },
    );
  }

  private activeConfirmations(state: State): NonNullable<State['confirmations']> {
    return Object.fromEntries(
      Object.entries(state.confirmations ?? {})
        .filter(([, value]) => value.expires_at > Date.now())
        .sort((left, right) => right[1].expires_at - left[1].expires_at)
        .slice(0, 128),
    );
  }

  private pruneRequests(requests: State['requests']): State['requests'] {
    const retentionBoundary = Date.now() - 90 * 24 * 60 * 60_000;
    const pending = Object.entries(requests).filter(([, entry]) => entry.status === 'pending');
    const terminal = Object.entries(requests)
      .filter(
        ([, entry]) =>
          entry.status !== 'pending' &&
          Date.parse(entry.updated_at) >= retentionBoundary,
      )
      .sort(
        (left, right) =>
          Date.parse(right[1].updated_at) - Date.parse(left[1].updated_at),
      )
      .slice(0, 5_000);
    return Object.fromEntries([...pending, ...terminal]);
  }

  private async releaseOwnedLock(lockPath: string, ownerPath: string): Promise<void> {
    try {
      const owner = ownerSchema.parse(JSON.parse(await readFile(ownerPath, 'utf8')));
      if (owner.instance_id !== this.instanceId || owner.pid !== process.pid) return;
      await unlink(ownerPath);
      await rmdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // The operation result is more important than best-effort lock cleanup.
      }
    }
  }

  private async removeAbandonedLock(lockPath: string): Promise<boolean> {
    const ownerPath = join(lockPath, 'owner.json');
    try {
      const lock = await lstat(lockPath);
      if (Date.now() - lock.mtimeMs <= this.lockOptions.staleLockMs) return false;
      const owner = ownerSchema.safeParse(JSON.parse(await readFile(ownerPath, 'utf8')));
      if (owner.success && this.processIsAlive(owner.data.pid)) return false;
      await unlink(ownerPath).catch(() => undefined);
      await rmdir(lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      return false;
    }
  }

  private processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private async load(): Promise<State> {
    await this.rejectSymlink();
    try {
      const parsed = stateSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')));
      if (!parsed.success) {
        throw new NutritionMcpError('CONFIG_ERROR', 'The idempotency state is corrupted.');
      }
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, requests: {} };
      }
      if (error instanceof SyntaxError) {
        throw new NutritionMcpError('CONFIG_ERROR', 'The idempotency state contains invalid JSON.');
      }
      throw error;
    }
  }

  private async save(state: State): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.rejectSymlink();
    state.requests = this.pruneRequests(state.requests);
    state.confirmations = this.activeConfirmations(state);
    const temporaryPath = join(directory, `.state-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.path);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw new NutritionMcpError('CONFIG_ERROR', 'Unable to write the idempotency state.', {
        cause: error,
      });
    }
  }

  private async rejectSymlink(): Promise<void> {
    try {
      if ((await lstat(this.path)).isSymbolicLink()) {
        throw new NutritionMcpError('CONFIG_ERROR', 'The state file must not be a symbolic link.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
