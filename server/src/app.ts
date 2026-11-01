import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import type { HealthResponse } from '@fia/shared';
import { CallService } from './calls/service';
import { TwilioCallProvider, type CallProvider } from './calls/provider';
import { corsOrigins, type Env } from './env';
import { dbState } from './db';
import { LlmError, OpenAiCompatibleClient, type LlmClient } from './llm/client';
import { catalogRouter } from './routes/catalog';
import { demoRouter } from './routes/demo';
import { callsRouter, jobsRouter, twilioRouter } from './routes/calls';
import { ChainService } from './dispatch/chain';
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

/**
 * Call turns get their own client: no retries and a 5 s timeout, so a turn never waits on
 * backoff (the eval's pacer runs in its own process and never sees these requests).
 */
export function createCallLlmClient(env: Env): LlmClient {
  if (!env.GROQ_API_KEY) return noKeyClient;
  return new OpenAiCompatibleClient({
    apiKey: env.GROQ_API_KEY,
    baseURL: env.LLM_BASE_URL,
    maxRetries: 0,
    timeoutMs: 5000,
  });
}

function createCallProvider(env: Env): CallProvider | null {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return null;
  return new TwilioCallProvider(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
}

export interface AppDeps {
  llm?: LlmClient;
  /** Model client for vendor call turns. */
  callLlm?: LlmClient;
  callProvider?: CallProvider | null;
  now?: () => Date;
}

export type App = express.Express & {
  locals: { pipelines: PipelineRunner; calls: CallService; chains: ChainService };
};

export function createApp(env: Env, deps: AppDeps = {}): App {
  const app = express() as App;
  const pipelines = new PipelineRunner({
    llm: deps.llm ?? createLlmClient(env),
    models: { small: env.LLM_MODEL_SMALL, big: env.LLM_MODEL_BIG },
    now: deps.now,
  });
  app.locals.pipelines = pipelines;
  const calls = new CallService({
    env,
    provider: deps.callProvider !== undefined ? deps.callProvider : createCallProvider(env),
    llm: deps.callLlm ?? createCallLlmClient(env),
    models: { small: env.LLM_MODEL_SMALL, big: env.LLM_MODEL_BIG },
    now: deps.now,
  });
  app.locals.calls = calls;
  const chains = new ChainService({ env, calls, now: deps.now });
  app.locals.chains = chains;

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
  app.use('/api', proposalsRouter(calls, chains));
  app.use('/api', activityRouter());
  app.use('/api', workOrdersRouter());
  app.use('/api', settingsRouter());
  app.use('/api/demo', demoRouter(env, limiter));
  app.use('/api', callsRouter(calls, chains, limiter));
  app.use('/api', jobsRouter(env, chains));
  app.use('/api/twilio/voice', twilioRouter(env, calls));

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
