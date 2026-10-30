import type { LlmClient, LlmRequest } from '../llm/client';
import { computeMetrics, mismatches, percentile, safetyPassed, type CaseResult } from './metrics';
import { PacedLlmClient } from './pacer';
import { renderReport } from './report';

const expected = {
  trade: 'plumbing' as const,
  assetId: 'elmwood-restroom-mens',
  urgency: 'routine' as const,
  duplicateOf: null,
  needsHuman: false,
  safetyEmergency: false,
};

function result(over: Partial<CaseResult> & { id: string }): CaseResult {
  return {
    category: 'easy',
    source: 'tune',
    inputText: 'toilet running',
    expected,
    predicted: { ...expected, escalated: false, modelUsed: 'small' },
    error: null,
    latencyMs: 1000,
    tokens: 1000,
    ...over,
  };
}

describe('eval metrics', () => {
  it('counts a perfect case as passed', () => {
    const m = computeMetrics([result({ id: 'a' })]);
    expect(m.passed).toBe(1);
    expect(m.trade).toEqual({ hit: 1, of: 1 });
    expect(mismatches(result({ id: 'a' }))).toEqual([]);
  });

  it('tracks urgency exact, within-one and under-calls', () => {
    const rs = [
      result({ id: 'exact' }),
      result({
        id: 'under',
        predicted: { ...expected, urgency: 'low', escalated: false, modelUsed: 's' },
      }),
      result({
        id: 'over2',
        expected: { ...expected, urgency: 'low' },
        predicted: { ...expected, urgency: 'urgent', escalated: false, modelUsed: 's' },
      }),
    ];
    const m = computeMetrics(rs);
    expect(m.urgency).toEqual({ hit: 1, of: 3 });
    expect(m.urgencyWithinOne).toEqual({ hit: 2, of: 3 });
    expect(m.underCalls).toEqual({ hit: 1, of: 3 });
  });

  it('fails safety when a labeled emergency is missed, passes when there are none', () => {
    const safe = { ...expected, urgency: 'emergency' as const, safetyEmergency: true };
    const missed = result({
      id: 'gas',
      expected: safe,
      predicted: { ...safe, safetyEmergency: false, escalated: false, modelUsed: 's' },
    });
    expect(safetyPassed(computeMetrics([missed]))).toBe(false);
    expect(safetyPassed(computeMetrics([result({ id: 'a' })]))).toBe(true);
    // A crashed case counts as a miss, never as a pass.
    expect(
      safetyPassed(computeMetrics([result({ id: 'x', expected: safe, predicted: null })])),
    ).toBe(false);
  });

  it('scores duplicates by the exact work order merged into', () => {
    const dup = { ...expected, duplicateOf: 'wo-seed-001' };
    const rs = [
      result({
        id: 'right',
        expected: dup,
        predicted: { ...dup, escalated: false, modelUsed: 's' },
      }),
      result({
        id: 'wrong-wo',
        expected: dup,
        predicted: { ...dup, duplicateOf: 'wo-seed-005', escalated: false, modelUsed: 's' },
      }),
      result({
        id: 'false-merge',
        predicted: { ...expected, duplicateOf: 'wo-seed-001', escalated: false, modelUsed: 's' },
      }),
    ];
    const m = computeMetrics(rs);
    expect(m.duplicate.precision).toEqual({ hit: 1, of: 3 });
    expect(m.duplicate.recall).toEqual({ hit: 1, of: 2 });
  });

  it('computes p95 by nearest rank', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([], 95)).toBe(0);
  });

  it('renders AI, human and combined sections for the holdout', () => {
    const md = renderReport({
      set: 'holdout',
      results: [result({ id: 'h1', source: 'ai' }), result({ id: 'h2', source: 'human' })],
      usage: new Map([
        ['openai/gpt-oss-20b', { calls: 2, promptTokens: 1000, completionTokens: 200 }],
      ]),
      models: { small: 'openai/gpt-oss-20b', big: 'openai/gpt-oss-120b' },
      startedAt: new Date('2026-10-30T12:00:00Z'),
      durationMs: 5000,
      pacing: { tokensPerMinute: 7000, requestsPerMinute: 25, waitedMs: 0 },
      skipped: [],
    });
    expect(md).toContain('Test cases and expected answers were written by the author.');
    expect(md).toContain('## AI-written cases');
    expect(md).toContain('## Human-written cases');
    expect(md).toContain('## Combined');
    expect(md).toContain('Safety recall: PASS');
    // 1000 * 0.075/1M + 200 * 0.30/1M = 0.000135
    expect(md).toContain('$0.00014');
  });
});

describe('PacedLlmClient', () => {
  const fakeInner = (tokens: number): LlmClient => ({
    complete: <T>(req: LlmRequest<T>) =>
      Promise.resolve({
        data: {} as T,
        model: req.model,
        usage: { promptTokens: tokens - 100, completionTokens: 100, totalTokens: tokens },
        latencyMs: 1,
      }),
  });
  const req = {
    model: 'm',
    system: '',
    user: '',
    schemaName: 'x',
  } as unknown as LlmRequest<unknown>;

  it('waits for the window when the token budget is used up, and meters usage', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const llm = new PacedLlmClient(fakeInner(3000), {
      tokensPerMinute: 7000,
      requestsPerMinute: 25,
      estimateTokens: 1500,
      clock: () => now,
      sleep: (ms) => {
        sleeps.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });
    await llm.complete(req); // 3000
    await llm.complete(req); // 6000
    expect(sleeps).toEqual([]);
    await llm.complete(req); // 6000 + 1500 > 7000 -> wait for the first to expire
    expect(sleeps).toEqual([60_050]);
    expect(llm.usage.get('m')).toEqual({ calls: 3, promptTokens: 8700, completionTokens: 300 });
  });

  it('respects the request-per-minute cap', async () => {
    let now = 0;
    const llm = new PacedLlmClient(fakeInner(10), {
      tokensPerMinute: 1_000_000,
      requestsPerMinute: 2,
      clock: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    await llm.complete(req);
    await llm.complete(req);
    await llm.complete(req);
    expect(llm.waitedMs).toBe(60_050);
  });
});
