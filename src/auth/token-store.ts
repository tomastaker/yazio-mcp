import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NutritionMcpError } from '../errors.js';

export const tokenSchema = z.object({
  token_type: z.string(),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  expires_at: z.number().positive(),
});

export type StoredToken = z.infer<typeof tokenSchema>;

export interface TokenStore {
  load(): Promise<StoredToken | null>;
  save(token: StoredToken): Promise<void>;
  clear(): Promise<void>;
}

const rejectSymlink = async (path: string): Promise<void> => {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new NutritionMcpError('CONFIG_ERROR', 'Token cache не может быть символической ссылкой.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  async load(): Promise<StoredToken | null> {
    await rejectSymlink(this.path);
    try {
      const parsed = tokenSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw new NutritionMcpError('CONFIG_ERROR', 'Не удалось прочитать token cache.', { cause: error });
    }
  }

  async save(token: StoredToken): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rejectSymlink(this.path);

    const temporaryPath = join(directory, `.token-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(JSON.stringify(token));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.path);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw new NutritionMcpError('CONFIG_ERROR', 'Не удалось безопасно сохранить token cache.', {
        cause: error,
      });
    }
  }

  async clear(): Promise<void> {
    await rejectSymlink(this.path);
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
