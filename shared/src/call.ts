import { z } from 'zod';

/** What the UI shows while a call runs. Twilio's own status is stored alongside. */
export const CALL_STATUSES = ['queued', 'ringing', 'in_call', 'ended'] as const;
export const CallStatus = z.enum(CALL_STATUSES);
export type CallStatus = z.infer<typeof CallStatus>;

/** `book` = confirm the job and an arrival time; `quote` = collect a rough estimate, never book. */
export const CALL_PURPOSES = ['book', 'quote'] as const;
export const CallPurpose = z.enum(CALL_PURPOSES);
export type CallPurpose = z.infer<typeof CallPurpose>;

/**
 * confirmed / declined / callback_requested come from the conversation. `quoted` = a quote call
 * collected an estimate and/or arrival time. `opted_out` = the vendor said stop. `ended` = talked but no decision (turn cap or the model ended it). `email_fallback` =
 * no answer, busy, failed, no speech or the model was unavailable; the dispatch email is the record.
 */
export const CALL_OUTCOMES = [
  'confirmed',
  'quoted',
  'declined',
  'callback_requested',
  'opted_out',
  'ended',
  'email_fallback',
] as const;
export const CallOutcome = z.enum(CALL_OUTCOMES);
export type CallOutcome = z.infer<typeof CallOutcome>;

/** Actions the model may choose on each turn. */
export const CALL_ACTIONS = [
  'continue',
  'confirm_job',
  'decline_job',
  'request_callback',
  'end',
] as const;
export const CallAction = z.enum(CALL_ACTIONS);
export type CallAction = z.infer<typeof CallAction>;

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * One model turn (strict structured output). `arrivalTime` is local wall-clock time at the site,
 * ISO 8601 without an offset ("2026-11-02T09:00"); the server converts it with the site's zone.
 */
export const CallTurnDecision = z.object({
  say: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .refine((s) => words(s) <= 30, 'say must be at most 30 words'),
  action: CallAction,
  arrivalTime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .nullable(),
  reason: z.string().trim().max(300).nullable(),
  /** The vendor's question, when their reply mainly asks something. */
  vendorQuestion: z.string().trim().max(300).nullable(),
  /** Answer from the job details only; null when the details don't say. */
  answer: z.string().trim().max(240).nullable(),
});
export type CallTurnDecision = z.infer<typeof CallTurnDecision>;

export const QUOTE_TYPES = ['fixed', 'range', 'rates', 'none'] as const;
export const QuoteType = z.enum(QUOTE_TYPES);
export type QuoteType = z.infer<typeof QuoteType>;

/** Answer to "Our limit for this job is $N. Could you work within that?" (`unknown` = not asked). */
export const WITHIN_NTE = ['yes', 'no', 'maybe', 'unknown'] as const;
export const WithinNte = z.enum(WITHIN_NTE);
export type WithinNte = z.infer<typeof WithinNte>;

const dollars = z.number().nonnegative().max(1_000_000).nullable();

/** Price information as the vendor stated it. All amounts in USD and approximate. */
export const QuoteEstimate = z.object({
  quoteType: QuoteType,
  /** fixed: the price. range: the low end. */
  low: dollars,
  /** range: the high end. */
  high: dollars,
  callOutFee: dollars,
  hourlyRate: dollars,
});
export type QuoteEstimate = z.infer<typeof QuoteEstimate>;

/** Structured result of one quote call. */
export const QuoteResult = QuoteEstimate.extend({
  withinNte: WithinNte,
  /** UTC ISO, read back to the vendor. */
  earliestArrival: z.string().nullable(),
  notes: z.string().max(500),
  /** 0-1: mean speech-recognition confidence of the vendor's lines. */
  confidence: z.number().min(0).max(1),
});
export type QuoteResult = z.infer<typeof QuoteResult>;

/** One model turn on a quote call (strict structured output). */
export const QuoteTurnDecision = z.object({
  say: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .refine((s) => words(s) <= 30, 'say must be at most 30 words'),
  /** `agree` = the vendor said yes to what was just asked (a read-back time, or the limit). */
  action: z.enum(['continue', 'agree', 'decline_job', 'request_callback', 'end']),
  /** Set only when the vendor stated price information in this reply. */
  estimate: QuoteEstimate.nullable(),
  arrivalTime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .nullable(),
  /** Only when answering the limit question. */
  withinNte: z.enum(['yes', 'no', 'maybe']).nullable(),
  /** Caveats worth keeping, e.g. "needs to see it before a firm price". */
  notes: z.string().trim().max(200).nullable(),
  reason: z.string().trim().max(300).nullable(),
  vendorQuestion: z.string().trim().max(300).nullable(),
  answer: z.string().trim().max(240).nullable(),
});
export type QuoteTurnDecision = z.infer<typeof QuoteTurnDecision>;

export const CallTranscriptTurn = z.object({
  /** Webhook sequence number; agent and vendor lines from one webhook share it. */
  n: z.number().int().nonnegative(),
  speaker: z.enum(['agent', 'vendor']),
  text: z.string(),
  at: z.string(),
  /** Vendor lines: Twilio's speech confidence when present. */
  confidence: z.number().nullable(),
  /** Agent lines: time spent deciding the reply (model call included). */
  latencyMs: z.number().nonnegative().nullable(),
  /** Agent lines: model that wrote the line, or null for scripted lines. */
  model: z.string().nullable(),
  action: z.string().nullable(),
});
export type CallTranscriptTurn = z.infer<typeof CallTranscriptTurn>;

export const CallRecord = z.object({
  id: z.string(),
  callSid: z.string().nullable(),
  workOrderId: z.string(),
  purpose: CallPurpose,
  /** Set when the call is part of an automated quote / booking chain. */
  chainId: z.string().nullable(),
  /** Copied in so the record still reads well after a demo reset reseeds work orders. */
  workOrderNumber: z.string(),
  workOrderTitle: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  siteName: z.string(),
  status: CallStatus,
  twilioStatus: z.string().nullable(),
  outcome: CallOutcome.nullable(),
  /** Confirmed arrival time (UTC ISO). */
  eta: z.string().nullable(),
  callbackAt: z.string().nullable(),
  /** Decline / callback / opt-out reason, or why the call fell back to email. */
  reason: z.string().nullable(),
  /** Proposal created for the next vendor after a decline. */
  reassignProposalId: z.string().nullable(),
  /** Quote calls: what the vendor quoted (approximate). */
  quote: QuoteResult.nullable(),
  transcript: z.array(CallTranscriptTurn),
  summary: z.string().nullable(),
  durationSec: z.number().nonnegative().nullable(),
  endedReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type CallRecord = z.infer<typeof CallRecord>;

/** GET /api/calls/config: lets the UI decide whether to show the Call button. */
export const CallConfig = z.object({
  enabled: z.boolean(),
  maxPerHour: z.number().int(),
  maxPerWorkOrder: z.number().int(),
});
export type CallConfig = z.infer<typeof CallConfig>;

/** Stop phrases end the call before the model sees the turn. */
export const STOP_PHRASES = [
  'stop',
  'not interested',
  'wrong number',
  'remove me',
  "don't call",
  'do not call',
  'no thanks',
  'no thank you',
] as const;
