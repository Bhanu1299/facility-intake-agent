import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import type { HealthResponse } from '@fia/shared';
import { corsOrigins, type Env } from './env';
import { dbState } from './db';
import { LlmError, OpenAiCompatibleClient, type LlmClient } from './llm/client';
import { catalogRouter } from './routes/catalog';
import { demoRouter } from './routes/demo';
import { activityRouter, proposalsRouter } from './routes/proposals';
import { demoRateLimit } from './routes/rateLimit';
import { PipelineRunner, signalsRouter } from './routes/signals';
import { getAutonomyMode, settingsRouter, workOrdersRouter } from './routes/workOrders';

/** Without a key the app still runs; every model call fails honestly and proposals need a human. */
const noKeyClient: LlmClient = {
  complete() {
    return Promise.reject(new LlmError('No LLM API key configured (GROQ_API_KEY)', false));
  },
};

export function createLlmClient(env: Env): LlmClient {
  if (!env.GROQ_API_KEY) return noKeyClient;
  return new OpenAiCompatibleClient({ apiKey: env.GROQ_API_KEY, baseURL: env.LLM_BASE_URL });
}

export interface AppDeps {
  llm?: LlmClient;
  now?: () => Date;
}

export type App = express.Express & { locals: { pipelines: PipelineRunner } };

export function createApp(env: Env, deps: AppDeps = {}): App {
  const app = express() as App;
  const pipelines = new PipelineRunner({
    llm: deps.llm ?? createLlmClient(env),
    models: { small: env.LLM_MODEL_SMALL, big: env.LLM_MODEL_BIG },
    now: deps.now,
  });
  app.locals.pipelines = pipelines;

  // Render (and most hosts) sit behind one proxy; needed for per-IP rate limiting.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(cors({ origin: corsOrigins(env) }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', async (_req, res) => {
    const db = dbState();
    const body: HealthResponse = {
      status: 'ok',
      db,
      autonomyMode: db === 'connected' ? await getAutonomyMode() : env.AUTONOMY_MODE,
      version: process.env.npm_package_version ?? '0.1.0',
    };
    res.json(body);
  });

  // One shared per-IP budget for everything that calls the LLM or resets demo state.
  const limiter = demoRateLimit(env.DEMO_RATE_LIMIT_PER_HOUR);

  app.use('/api', catalogRouter());
  app.use('/api', signalsRouter(pipelines, limiter));
  app.use('/api', proposalsRouter());
  app.use('/api', activityRouter());
  app.use('/api', workOrdersRouter());
  app.use('/api', settingsRouter());
  app.use('/api/demo', demoRouter(env, limiter));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error('[api] unhandled error', err);
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(onError);

  return app;
}
