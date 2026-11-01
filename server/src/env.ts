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
  // Vendor dispatch call (optional). Without these the app runs and the Call button never shows.
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM_NUMBER: z.string().default(''),
  /** The only number the app will ever dial (the author's own, verified on the Twilio trial). */
  DEMO_VENDOR_PHONE: z.string().default(''),
  CALL_ADMIN_KEY: z.string().default(''),
  CALLS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Public base URL of this API (the Render URL); Twilio webhooks are built and signed on it. */
  PUBLIC_API_URL: z.string().default(''),
  /** Wait before retrying a missed routine / low call (set to 2 for a demo video). */
  DEMO_RETRY_MINUTES: z.coerce
    .number()
    .positive()
    .max(24 * 60)
    .default(90),
  /** Secret for POST /api/jobs/run-due (an external cron in production). Unset = route disabled. */
  JOBS_SECRET: z.string().default(''),
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
