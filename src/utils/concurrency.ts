export interface SettledMapResult<T> {
  values: Array<T | undefined>;
  errors: Array<{ index: number; error: unknown }>;
}

const assertConcurrency = (concurrency: number): void => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }
};

export class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly concurrency: number) {
    assertConcurrency(concurrency);
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export const mapWithConcurrency = async <Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapper: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> => {
  assertConcurrency(concurrency);
  const values = new Array<Output>(inputs.length);
  let cursor = 0;
  let firstError: unknown;

  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      const index = cursor;
      cursor += 1;
      if (index >= inputs.length) return;
      const input = inputs[index];
      if (input === undefined) return;
      try {
        values[index] = await mapper(input, index);
      } catch (error) {
        firstError = error;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()),
  );
  if (firstError !== undefined) {
    throw firstError instanceof Error ? firstError : new Error('Concurrent mapper failed.');
  }
  return values;
};

export const mapSettledWithConcurrency = async <Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapper: (input: Input, index: number) => Promise<Output>,
): Promise<SettledMapResult<Output>> => {
  assertConcurrency(concurrency);
  const values = new Array<Output | undefined>(inputs.length);
  const errors: Array<{ index: number; error: unknown }> = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= inputs.length) return;
      const input = inputs[index];
      if (input === undefined) return;
      try {
        values[index] = await mapper(input, index);
      } catch (error) {
        errors.push({ index, error });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()),
  );
  errors.sort((left, right) => left.index - right.index);
  return { values, errors };
};
