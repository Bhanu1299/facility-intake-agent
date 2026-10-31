import { Router, type RequestHandler } from 'express';
import { SignalInput, SensorSignalInput, detectLanguage } from '@fia/shared';
import { SignalModel } from '../models/pipeline';
import {
  createSignal,
  runPipeline,
  SignalInputError,
  type PipelineDeps,
} from '../pipeline/pipeline';
import { checkSafety } from '../pipeline/safety';

/** Tracks background pipeline runs so tests (and graceful shutdown) can wait for them. */
export class PipelineRunner {
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly deps: PipelineDeps) {}

  start(signalId: string): void {
    const run = runPipeline(signalId, this.deps)
      .catch((err: unknown) => console.error(`[pipeline] ${signalId} failed`, err))
      .finally(() => this.inflight.delete(run));
    this.inflight.add(run);
  }

  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }
}

async function accept(
  input: SignalInput,
  runner: PipelineRunner,
): Promise<{ status: number; body: unknown }> {
  try {
    const { id: signalId, reference } = await createSignal(input);
    runner.start(signalId);
    // The safety check is pure code, so the requester can get guidance before the model runs.
    const request = input.type === 'request' ? input : null;
    return {
      status: 202,
      body: {
        signalId,
        status: 'processing',
        reference,
        safetyRuleId: request ? (checkSafety(request.text)?.ruleId ?? null) : null,
        language: request ? detectLanguage(request.text) : null,
      },
    };
  } catch (err) {
    if (err instanceof SignalInputError) return { status: 400, body: { error: err.message } };
    throw err;
  }
}

export function signalsRouter(runner: PipelineRunner, limiter: RequestHandler): Router {
  const router = Router();

  router.post('/signals', limiter, async (req, res) => {
    const parsed = SignalInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid signal', details: parsed.error.issues });
      return;
    }
    const { status, body } = await accept(parsed.data, runner);
    res.status(status).json(body);
  });

  router.get('/signals/:id', async (req, res) => {
    const signal = await SignalModel.findById(req.params.id);
    if (!signal) {
      res.status(404).json({ error: 'Signal not found' });
      return;
    }
    res.json(signal);
  });

  // Demo tool: push a sensor reading (same pipeline as a real device).
  router.post('/demo/sensor', limiter, async (req, res) => {
    const parsed = SensorSignalInput.omit({ type: true }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid sensor reading', details: parsed.error.issues });
      return;
    }
    const { status, body } = await accept({ type: 'sensor', ...parsed.data }, runner);
    res.status(status).json(body);
  });

  return router;
}
