import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import type { HealthResponse } from '@fia/shared';
import { corsOrigins, type Env } from './env';
import { dbState } from './db';

export function createApp(env: Env): express.Express {
  const app = express();

  // Render (and most hosts) sit behind one proxy; needed for per-IP rate limiting.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(cors({ origin: corsOrigins(env) }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => {
    const body: HealthResponse = {
      status: 'ok',
      db: dbState(),
      autonomyMode: env.AUTONOMY_MODE,
      version: process.env.npm_package_version ?? '0.1.0',
    };
    res.json(body);
  });

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
