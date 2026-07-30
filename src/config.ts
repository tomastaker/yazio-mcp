import { homedir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { NutritionMcpError } from './errors.js';

const environmentSchema = z.object({
  YAZIO_USERNAME: z.string().min(1).optional(),
  YAZIO_PASSWORD: z.string().min(1).optional(),
  YAZIO_CLIENT_ID: z.string().min(1).optional(),
  YAZIO_CLIENT_SECRET: z.string().min(1).optional(),
  YAZIO_BASE_URL: z.url().default('https://yzapi.yazio.com/v20'),
  YAZIO_TOKEN_CACHE_PATH: z.string().min(1).optional(),
  NUTRITION_MCP_STATE_PATH: z.string().min(1).optional(),
  NUTRITION_MCP_TIMEZONE: z
    .string()
    .min(1)
    .refine((value) => DateTime.now().setZone(value).isValid, 'Ожидается существующая IANA timezone')
    .default('Europe/Moscow'),
  YAZIO_PRODUCT_COUNTRIES: z.string().default('RU'),
  YAZIO_PRODUCT_LOCALES: z.string().default('ru_RU'),
  YAZIO_DEFAULT_SEX: z.enum(['male', 'female']).default('male'),
  YAZIO_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
});

export interface AppConfig {
  baseUrl: string;
  username: string | undefined;
  password: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  tokenCachePath: string;
  statePath: string;
  timezone: string;
  countries: string[];
  locales: string[];
  defaultSex: 'male' | 'female';
  timeoutMs: number;
}

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new NutritionMcpError('CONFIG_ERROR', 'Некорректная конфигурация environment variables.', {
      details: {
        variables: parsed.error.issues.map((issue) => String(issue.path[0] ?? 'unknown')),
      },
    });
  }
  const dataDirectory = join(homedir(), '.nutrition-mcp');
  return {
    baseUrl: parsed.data.YAZIO_BASE_URL.replace(/\/+$/, ''),
    username: parsed.data.YAZIO_USERNAME,
    password: parsed.data.YAZIO_PASSWORD,
    clientId: parsed.data.YAZIO_CLIENT_ID,
    clientSecret: parsed.data.YAZIO_CLIENT_SECRET,
    tokenCachePath: parsed.data.YAZIO_TOKEN_CACHE_PATH ?? join(dataDirectory, 'token.json'),
    statePath: parsed.data.NUTRITION_MCP_STATE_PATH ?? join(dataDirectory, 'state.json'),
    timezone: parsed.data.NUTRITION_MCP_TIMEZONE,
    countries: splitList(parsed.data.YAZIO_PRODUCT_COUNTRIES),
    locales: splitList(parsed.data.YAZIO_PRODUCT_LOCALES),
    defaultSex: parsed.data.YAZIO_DEFAULT_SEX,
    timeoutMs: parsed.data.YAZIO_HTTP_TIMEOUT_MS,
  };
};
