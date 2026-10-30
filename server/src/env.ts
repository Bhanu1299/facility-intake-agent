import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { AutonomyMode } from '@fia/shared';

// Load the repo-root .env whether we run from /server (npm -w) or the root. Real env vars win.
dotenv.config({
  path: [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../.env')],
  quiet: true,
});

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  GROQ_API_KEY: z.string().default(''),
  LLM_BASE_URL: z.url().default('https://api.groq.com/openai/v1'),
  LLM_MODEL_SMALL: z.string().min(1).default('openai/gpt-oss-20b'),
  LLM_MODEL_BIG: z.string().min(1).default('openai/gpt-oss-120b'),
  MONGODB_URI: z.string().default(''),
  AUTONOMY_MODE: AutonomyMode.default('propose'),
  DEMO_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(20),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat empty strings as "unset" so defaults apply to blank lines in .env.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && !env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required in production.');
  }
  return env;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
