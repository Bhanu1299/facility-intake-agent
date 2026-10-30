import type { DuplicateVerdict, Understanding } from '@fia/shared';
import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from '../llm/client';

type Responder<T> = (req: LlmRequest<T>) => T | Error;

/** Scripted model for tests. Records every request so tests can assert what the model saw. */
export class FakeLlm implements LlmClient {
  readonly calls: LlmRequest<unknown>[] = [];

  constructor(
    private readonly understand: Responder<Understanding>,
    private readonly duplicate: Responder<DuplicateVerdict> = () => ({
      sameProblem: false,
      reason: 'Different problem.',
    }),
  ) {}

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push(req as LlmRequest<unknown>);
    const out =
      req.schemaName === 'duplicate_verdict'
        ? this.duplicate(req as unknown as LlmRequest<DuplicateVerdict>)
        : this.understand(req as unknown as LlmRequest<Understanding>);
    if (out instanceof Error) throw out;
    return {
      data: req.schema.parse(out),
      model: req.model,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      latencyMs: 5,
    };
  }
}

export const understanding = (overrides: Partial<Understanding>): Understanding => ({
  trade: 'plumbing',
  problemSummary: 'Something is wrong',
  assetId: null,
  locationText: '',
  urgency: 'routine',
  urgencyReason: 'Operations continue.',
  confidence: 0.9,
  clarifyingQuestion: null,
  ...overrides,
});

export const modelDown = (): Error => new LlmError('LLM call failed: connection refused', true);
