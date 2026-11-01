import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router, type RequestHandler, type Response } from 'express';
import twilio from 'twilio';
import type { CallConfig } from '@fia/shared';
import {
  CallError,
  MAX_CALLS_PER_HOUR,
  MAX_CALLS_PER_WORK_ORDER,
  type CallService,
} from '../calls/service';
import type { Env } from '../env';
import type { ChainService } from '../dispatch/chain';
import { toChainRecord } from '../dispatch/models';
import { CallModel, toCallRecord } from '../models/call';

const ADMIN_HEADER = 'x-admin-key';

function sendError(res: Response, err: unknown): void {
  if (err instanceof CallError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

/** Call start (admin only) and read-only call records for the UI. */
export function callsRouter(
  calls: CallService,
  chains: ChainService,
  limiter: RequestHandler,
): Router {
  const router = Router();

  router.get('/work-orders/:id/chain', async (req, res) => {
    const found = await chains.forWorkOrder(String(req.params.id));
    res.json(found ? toChainRecord(found.chain, found.nextCallAt) : null);
  });

  router.get('/calls/config', (_req, res) => {
    const body: CallConfig = {
      enabled: calls.enabled(),
      maxPerHour: MAX_CALLS_PER_HOUR,
      maxPerWorkOrder: MAX_CALLS_PER_WORK_ORDER,
    };
    res.json(body);
  });

  // Rate limited with the demo limiter so the key can't be brute-forced.
  router.post('/calls/verify-key', limiter, (req, res) => {
    if (!calls.checkAdminKey(req.header(ADMIN_HEADER))) {
      res.status(401).json({ error: 'Invalid admin key' });
      return;
    }
    res.json({ ok: true, enabled: calls.enabled() });
  });

  router.post('/work-orders/:id/call', limiter, async (req, res) => {
    try {
      const call = await calls.start(String(req.params.id), req.header(ADMIN_HEADER));
      res.status(202).json(toCallRecord(call));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/work-orders/:id/calls', async (req, res) => {
    const docs = await CallModel.find({ workOrderId: req.params.id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json(docs.map(toCallRecord));
  });

  /** Most recent call that got as far as a conversation: shown as "Recorded demo call". */
  router.get('/calls/latest', async (_req, res) => {
    const doc = await CallModel.findOne({ 'transcript.1': { $exists: true } })
      .sort({ createdAt: -1 })
      .lean();
    res.json(doc ? toCallRecord(doc) : null);
  });

  router.get('/calls/:id', async (req, res) => {
    const doc = await CallModel.findById(req.params.id).lean();
    if (!doc) {
      res.status(404).json({ error: 'Call not found' });
      return;
    }
    res.json(toCallRecord(doc));
  });

  return router;
}

/**
 * POST /api/jobs/run-due: runs scheduled calls that are due. For an external cron; the server
 * also runs it on startup and every 2 minutes while awake. Needs X-Jobs-Secret = JOBS_SECRET.
 */
export function jobsRouter(env: Pick<Env, 'JOBS_SECRET'>, chains: ChainService): Router {
  const router = Router();
  router.post('/jobs/run-due', async (req, res) => {
    const given = req.header('x-jobs-secret');
    const digest = (s: string) => createHash('sha256').update(s).digest();
    if (!env.JOBS_SECRET) {
      res.status(503).json({ error: 'JOBS_SECRET is not set' });
      return;
    }
    if (!given || !timingSafeEqual(digest(given), digest(env.JOBS_SECRET))) {
      res.status(401).json({ error: 'Invalid jobs secret' });
      return;
    }
    res.json({ placed: await chains.runDue() });
  });
  return router;
}

/**
 * Rejects any request without a valid X-Twilio-Signature (403). The URL is rebuilt from
 * PUBLIC_API_URL, since behind Render's proxy the request's own host and scheme aren't the
 * ones Twilio signed. https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function twilioSignature(
  env: Pick<Env, 'TWILIO_AUTH_TOKEN' | 'PUBLIC_API_URL'>,
): RequestHandler {
  return (req, res, next) => {
    const signature = req.header('x-twilio-signature');
    const url = `${env.PUBLIC_API_URL.replace(/\/+$/, '')}${req.originalUrl}`;
    const params = (req.body ?? {}) as Record<string, string>;
    if (
      !env.TWILIO_AUTH_TOKEN ||
      !env.PUBLIC_API_URL ||
      !signature ||
      !twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params)
    ) {
      res.status(403).type('text/plain').send('Invalid Twilio signature');
      return;
    }
    next();
  };
}

/** Twilio voice webhooks (form-encoded, signed). Mounted at /api/twilio/voice. */
export function twilioRouter(env: Env, calls: CallService): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false, limit: '50kb' }));
  router.use(twilioSignature(env));

  const twiml = (res: Response, xml: string): void => {
    res.type('text/xml').send(xml);
  };

  router.post('/:callId/answer', async (req, res) => {
    twiml(res, await calls.answer(req.params.callId, req.body));
  });

  router.post('/:callId/turn', async (req, res) => {
    const n = Number(req.query.n);
    if (!Number.isInteger(n) || n < 1) {
      res.status(400).type('text/plain').send('Bad turn number');
      return;
    }
    twiml(res, await calls.turn(req.params.callId, n, req.query.retry === '1', req.body));
  });

  router.post('/:callId/status', async (req, res) => {
    await calls.status(req.params.callId, req.body);
    res.status(204).end();
  });

  return router;
}
