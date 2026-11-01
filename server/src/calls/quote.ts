import {
  QuoteEstimate,
  QuoteTurnDecision,
  estimateCeiling,
  type QuoteResult,
  type WithinNte,
} from '@fia/shared';
import type { LlmClient } from '../llm/client';
import { formatSpokenTime } from './time';
import {
  SPEAKING_RULES,
  askTurnModel,
  jobContextLines,
  transcriptLines,
  type CallJob,
  type ModelTurn,
  type TurnModels,
} from './turn';

/** Where a quote call is: who we're talking to, then estimate, arrival, and the limit question. */
export type QuoteStage = 'identity' | 'estimate' | 'arrival' | 'limit';

export const QUOTE_SYSTEM_PROMPT = `You are a phone assistant calling a maintenance vendor for a restaurant group to get a rough quote for one job. You do NOT book the job on this call. The call is turn-based: the system speaks the fixed lines (greeting, job description, the price, arrival and budget questions, read-backs, goodbye); you read each vendor reply from a speech-to-text transcript (it can contain recognition errors, especially in numbers) and extract what they said.

Output JSON with:
- say: a short reply, only used when the vendor's answer was unclear (one follow-up question) or the call is ending (a brief, friendly goodbye). Write amounts as "350 dollars".
- action:
  - continue: normal reply.
  - agree: the vendor said yes to what was just asked (a time read back to them, or the budget question).
  - decline_job: the vendor can't or won't do this job. reason = why.
  - request_callback: the vendor wants to be called back later. arrivalTime = callback time if given.
  - end: wrong person, they want to hang up, or you can't understand after several tries.
- estimate: ONLY when the vendor stated price information in this reply, else null.
  - quoteType fixed: one price (low = the price).
  - quoteType range: "between 300 and 450" (low and high).
  - quoteType rates: a call-out / trip fee and/or an hourly rate (callOutFee, hourlyRate). "Fifty an hour" = hourlyRate 50.
  - quoteType none: the vendor won't or can't estimate without seeing the job.
  Amounts in dollars as numbers; unused fields null.
- arrivalTime: when the vendor states an arrival time, the local date and time as YYYY-MM-DDTHH:mm from the calendar below. Otherwise null.
- withinNte: only when the vendor answers the budget question: yes, no or maybe. Otherwise null.
- notes: a short caveat worth keeping for the manager (e.g. "needs to see it first", "parts extra"), else null.
- reason: reason for decline / callback / end, otherwise null.
- vendorQuestion, answer: see below.

Rules:
- Never negotiate, never offer more money, never mention other vendors or their prices. If asked about the budget, set vendorQuestion and leave answer null.

${SPEAKING_RULES}`;

const STAGE_TEXT: Record<QuoteStage, string> = {
  identity: 'The agent asked whether this is the right company.',
  estimate:
    'The agent asked for a rough estimate, or a call-out fee and hourly rate. Extract the estimate.',
  arrival: 'The agent asked for (or read back) the earliest arrival time.',
  limit: 'The agent asked whether the vendor could work with the stated budget. Set withinNte.',
};

export interface QuoteTurnContext {
  job: CallJob;
  transcript: { speaker: 'agent' | 'vendor'; text: string }[];
  vendorSaid: string;
  stage: QuoteStage;
  pendingArrival: Date | null;
  now: Date;
}

function buildQuotePrompt(ctx: QuoteTurnContext): string {
  return [
    ...jobContextLines(ctx.job, ctx.now, { nte: ctx.stage === 'limit' }),
    '',
    `Current step: ${STAGE_TEXT[ctx.stage]}`,
    `Arrival time read back: ${ctx.pendingArrival ? formatSpokenTime(ctx.pendingArrival, ctx.now) : 'none yet'}`,
    '',
    'Conversation so far:',
    ...transcriptLines(ctx.transcript),
    '',
    `Vendor just said: "${ctx.vendorSaid}"`,
  ].join('\n');
}

export function decideQuoteTurn(
  llm: LlmClient,
  models: TurnModels,
  ctx: QuoteTurnContext,
): Promise<ModelTurn<QuoteTurnDecision>> {
  return askTurnModel(llm, models, {
    system: QUOTE_SYSTEM_PROMPT,
    user: buildQuotePrompt(ctx),
    schemaName: 'quote_turn',
    schema: QuoteTurnDecision,
  });
}

/**
 * Makes a stated estimate self-consistent: a "range" with one number is a fixed price, "rates"
 * without a rate is no estimate, a fixed price with only rates is rates, and unused fields are
 * null. Returns null for input that isn't an estimate at all.
 */
export function normalizeEstimate(input: unknown): QuoteEstimate | null {
  const parsed = QuoteEstimate.safeParse(input);
  if (!parsed.success) return null;
  const e = parsed.data;
  const none: QuoteEstimate = {
    quoteType: 'none',
    low: null,
    high: null,
    callOutFee: null,
    hourlyRate: null,
  };
  const rates = (): QuoteEstimate =>
    e.callOutFee !== null || e.hourlyRate !== null
      ? { ...none, quoteType: 'rates', callOutFee: e.callOutFee, hourlyRate: e.hourlyRate }
      : none;
  switch (e.quoteType) {
    case 'none':
      return none;
    case 'rates':
      return rates();
    case 'fixed': {
      const price = e.low ?? e.high;
      return price !== null ? { ...none, quoteType: 'fixed', low: price } : rates();
    }
    case 'range': {
      if (e.low !== null && e.high !== null && e.low !== e.high) {
        return {
          ...none,
          quoteType: 'range',
          low: Math.min(e.low, e.high),
          high: Math.max(e.low, e.high),
        };
      }
      const price = e.low ?? e.high;
      return price !== null ? { ...none, quoteType: 'fixed', low: price } : rates();
    }
  }
}

const PLAIN_YES =
  /^(yes|yeah|yep|yup|correct|right|exactly|sure|ok(ay)?|sounds good|that'?s (right|correct)|that is (right|correct)|you got it)\b/i;

/**
 * A short, unhedged "yes" to a read-back. The model sometimes answers these with "continue",
 * which would drop a time the vendor just confirmed.
 */
export function isPlainYes(speech: string): boolean {
  const s = speech.trim().replace(/[.,!]+/g, '');
  return s.split(/\s+/).length <= 6 && PLAIN_YES.test(s) && !/\b(no|not|but)\b/i.test(s);
}

/** True when the estimate is over the NTE, which earns the one-time limit question. */
export function overNte(estimate: QuoteEstimate | null, nte: number): boolean {
  if (!estimate) return false;
  const ceiling = estimateCeiling(estimate);
  return ceiling !== null && ceiling > nte;
}

/** Final quote result from the call's collected state. */
export function finalizeQuote(input: {
  estimate: QuoteEstimate | null;
  earliestArrival: Date | null;
  nte: number;
  nteAsked: boolean;
  nteAnswer: 'yes' | 'no' | 'maybe' | null;
  notes: string[];
  confidences: number[];
}): QuoteResult {
  const estimate = input.estimate ?? normalizeEstimate({ quoteType: 'none' })!;
  const ceiling = estimateCeiling(estimate);
  let withinNte: WithinNte;
  if (input.nteAsked) withinNte = input.nteAnswer ?? 'unknown';
  else withinNte = ceiling === null ? 'unknown' : ceiling <= input.nte ? 'yes' : 'unknown';
  const conf = input.confidences.filter((c) => Number.isFinite(c));
  const confidence = conf.length
    ? Math.round((conf.reduce((a, b) => a + b, 0) / conf.length) * 100) / 100
    : 0.5;
  return {
    ...estimate,
    withinNte,
    earliestArrival: input.earliestArrival ? input.earliestArrival.toISOString() : null,
    notes: [...new Set(input.notes.map((n) => n.trim()).filter(Boolean))].join('; ').slice(0, 500),
    confidence: Math.min(1, Math.max(0, confidence)),
  };
}
