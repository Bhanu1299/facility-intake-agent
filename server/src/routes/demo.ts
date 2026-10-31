import { Router, type RequestHandler } from 'express';
import type { Env } from '../env';
import { logActivity } from '../activity';
import { resetDemoData } from '../seed/reset';

export function demoRouter(env: Env, limiter: RequestHandler): Router {
  const router = Router();

  router.post('/reset', limiter, async (_req, res) => {
    const summary = await resetDemoData(env.AUTONOMY_MODE);
    await logActivity({
      step: 'reset',
      actor: 'manager',
      outputSummary: `Demo data reset: ${summary.workOrders} work orders, ${summary.vendors} vendors, ${summary.sites} sites in ${(summary.timingsMs.total / 1000).toFixed(1)} s`,
    });
    res.json({ ok: true, ...summary });
  });

  return router;
}
