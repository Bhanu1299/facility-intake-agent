import type { LlmClient, LlmRequest, LlmResult } from '../llm/client';

export interface PacerOptions {
  /** Stay under the provider's tokens-per-minute limit (per model). */
  tokensPerMinute: number;
  requestsPerMinute: number;
  /** Tokens reserved for a call before its real usage is known. */
  estimateTokens?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

export interface ModelUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

interface WindowEntry {
  at: number;
  tokens: number;
}

const WINDOW_MS = 60_000;

/**
 * Wraps an LlmClient for the eval run: keeps each model under free-tier RPM/TPM with a rolling
 * one-minute window, and meters usage per model for the cost estimate. 429s that still happen
 * are retried with backoff by the inner client.
 */
export class PacedLlmClient implements LlmClient {
  readonly usage = new Map<string, ModelUsage>();
  /** Total time spent waiting for the window (subtracted from reported latency). */
  waitedMs = 0;
  errors = 0;
  private readonly windows = new Map<string, WindowEntry[]>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;
  private readonly estimate: number;

  constructor(
    private readonly inner: LlmClient,
    private readonly opts: PacerOptions,
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.clock = opts.clock ?? Date.now;
    this.estimate = opts.estimateTokens ?? 1500;
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const slot = await this.acquire(req.model);
    try {
      const res = await this.inner.complete(req);
      slot.tokens = res.usage.totalTokens;
      const u = this.usage.get(req.model) ?? { calls: 0, promptTokens: 0, completionTokens: 0 };
      u.calls += 1;
      u.promptTokens += res.usage.promptTokens;
      u.completionTokens += res.usage.completionTokens;
      this.usage.set(req.model, u);
      return res;
    } catch (err) {
      this.errors += 1;
      throw err;
    }
  }

  private async acquire(model: string): Promise<WindowEntry> {
    const window = this.windows.get(model) ?? [];
    this.windows.set(model, window);
    for (;;) {
      const now = this.clock();
      while (window.length && now - window[0]!.at >= WINDOW_MS) window.shift();
      const used = window.reduce((sum, e) => sum + e.tokens, 0);
      if (
        window.length < this.opts.requestsPerMinute &&
        (window.length === 0 || used + this.estimate <= this.opts.tokensPerMinute)
      ) {
        const entry = { at: now, tokens: this.estimate };
        window.push(entry);
        return entry;
      }
      const waitMs = window[0]!.at + WINDOW_MS - now + 50;
      this.waitedMs += waitMs;
      await this.sleep(waitMs);
    }
  }
}
