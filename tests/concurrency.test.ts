import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileIdempotencyStore } from '../src/persistence/idempotency-store.js';
import { AsyncSemaphore, mapWithConcurrency } from '../src/utils/concurrency.js';

describe('bounded concurrency and cross-process locks', () => {
  it('never exceeds the configured mapper concurrency', async () => {
    let active = 0;
    let maximum = 0;
    const result = await mapWithConcurrency(
      Array.from({ length: 30 }, (_, index) => index),
      4,
      async (value) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return value * 2;
      },
    );

    expect(maximum).toBeLessThanOrEqual(4);
    expect(result).toHaveLength(30);
  });

  it('limits concurrency shared by independent callers', async () => {
    const semaphore = new AsyncSemaphore(3);
    let active = 0;
    let maximum = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        semaphore.run(async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active -= 1;
        }),
      ),
    );
    expect(maximum).toBe(3);
  });

  it('does not steal a live lock after the stale threshold', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nutrition-mcp-lock-'));
    const path = join(directory, 'state.json');
    const first = new FileIdempotencyStore(path, 'scope-a', {
      staleLockMs: 20,
      acquireTimeoutMs: 1_000,
      pollIntervalMs: 5,
      heartbeatMs: 5,
    });
    const second = new FileIdempotencyStore(path, 'scope-b', {
      staleLockMs: 20,
      acquireTimeoutMs: 1_000,
      pollIntervalMs: 5,
      heartbeatMs: 5,
    });
    const events: string[] = [];

    const firstOperation = first.runExclusive('water:2026-07-29', async () => {
      events.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 80));
      events.push('first-end');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondOperation = second.runExclusive('water:2026-07-29', async () => {
      await Promise.resolve();
      events.push('second-start');
    });
    await Promise.all([firstOperation, secondOperation]);

    expect(events).toEqual(['first-start', 'first-end', 'second-start']);
  });
});
