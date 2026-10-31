import express, { Router, type RequestHandler, type Response } from 'express';
import twilio from 'twilio';
import type { CallConfig } from '@fia/shared';
import { CallError, MAX_CALLS_PER_HOUR, type CallService } from '../calls/service';
import type { Env } from '../env';
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
export function callsRouter(calls: CallService, limiter: RequestHandler): Router {
  const router = Router();

  router.get('/calls/config', (_req, res) => {
    const body: CallConfig = { enabled: calls.enabled(), maxPerHour: MAX_CALLS_PER_HOUR };
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
