import { Router, type RequestHandler } from 'express';
import type { Env } from '../env';
import { resetDemoData } from '../seed/reset';

export function demoRouter(env: Env, limiter: RequestHandler): Router {
  const router = Router();

  router.post('/reset', limiter, async (_req, res) => {
    const summary = await resetDemoData(env.AUTONOMY_MODE);
    res.json({ ok: true, ...summary });
  });

  return router;
}
