import { Schema, model } from 'mongoose';
import {
  CALL_OUTCOMES,
  CALL_PURPOSES,
  CALL_STATUSES,
  type CallOutcome,
  type CallPurpose,
  type QuoteEstimate,
  type QuoteResult,
  type CallRecord,
  type CallStatus,
  type CallTranscriptTurn,
} from '@fia/shared';
import type { QuoteStage } from '../calls/quote';
import { baseOptions } from './common';

type TranscriptTurnDoc = Omit<CallTranscriptTurn, 'at'> & { at: Date };

/**
 * One vendor dispatch call. Lives in its own collection that the demo reset never touches, so a
 * recorded call (and the hourly call limit) survives a reset; work order fields are copied in.
 * The dialed number is never stored.
 */
export interface CallDoc {
  _id: string;
  callSid: string | null;
  workOrderId: string;
  workOrderNumber: string;
  workOrderTitle: string;
  vendorId: string;
  vendorName: string;
  siteName: string;
  /** Older records have no purpose; they were booking calls. */
  purpose: CallPurpose;
  chainId: string | null;
  /** Booking a quote winner: the quote being confirmed. */
  bookingQuote: QuoteResult | null;
  /** Quote calls: the final structured result. */
  quote: QuoteResult | null;
  status: CallStatus;
  twilioStatus: string | null;
  outcome: CallOutcome | null;
  eta: Date | null;
  callbackAt: Date | null;
  reason: string | null;
  reassignProposalId: string | null;
  transcript: TranscriptTurnDoc[];
  summary: string | null;
  durationSec: number | null;
  endedReason: string | null;

  // Conversation state (internal, not sent to the browser).
  /** Last webhook sequence number handled (0 = the answer webhook). */
  seq: number;
  /** TwiML returned for each sequence number, replayed if Twilio retries a webhook. */
  responses: Record<string, string>;
  /** Vendor utterances the model has handled. */
  vendorTurns: number;
  noSpeechCount: number;
  llmFailures: number;
  /** Set once the job brief has been read to the vendor. */
  briefRead: boolean;
  /** Arrival time read back to the vendor, waiting for a yes. */
  pendingArrival: Date | null;
  /** Vendor speech held over when the model timed out and the agent said "one moment". */
  pendingSpeech: string | null;
  /** The question to repeat if the vendor says nothing. */
  lastQuestion: string;
  /** Set when the outcome's side effects (work order, proposal, log) have been applied. */
  outcomeAppliedAt: Date | null;
  /** Set once the chain hook has run for this call's final status. */
  chainNotifiedAt: Date | null;

  // Quote-call state.
  quoteStage: QuoteStage;
  /** Unclear answers at the current stage; after 2 the agent moves on. */
  stageTries: number;
  estimate: QuoteEstimate | null;
  /** An arrival time mentioned before the arrival question, read back when we get there. */
  heardArrival: Date | null;
  /** Arrival the vendor said yes to on the read-back. */
  arrivalConfirmed: Date | null;
  nteAsked: boolean;
  nteAnswer: 'yes' | 'no' | 'maybe' | null;
  quoteNotes: string[];

  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
}

const TurnSchema = new Schema(
  {
    n: { type: Number, required: true },
    speaker: { type: String, enum: ['agent', 'vendor'], required: true },
    text: { type: String, default: '' },
    at: { type: Date, required: true },
    confidence: { type: Number, default: null },
    latencyMs: { type: Number, default: null },
    model: { type: String, default: null },
    action: { type: String, default: null },
  },
  { _id: false },
);

const CallSchema = new Schema<CallDoc>(
  {
    _id: { type: String, required: true },
    callSid: { type: String, default: null },
    workOrderId: { type: String, required: true },
    workOrderNumber: { type: String, required: true },
    workOrderTitle: { type: String, required: true },
    vendorId: { type: String, required: true },
    vendorName: { type: String, required: true },
    siteName: { type: String, required: true },
    purpose: { type: String, enum: CALL_PURPOSES, default: 'book' },
    chainId: { type: String, default: null },
    bookingQuote: { type: Schema.Types.Mixed, default: null },
    quote: { type: Schema.Types.Mixed, default: null },
    status: { type: String, enum: CALL_STATUSES, required: true },
    twilioStatus: { type: String, default: null },
    outcome: { type: String, enum: [...CALL_OUTCOMES, null], default: null },
    eta: { type: Date, default: null },
    callbackAt: { type: Date, default: null },
    reason: { type: String, default: null },
    reassignProposalId: { type: String, default: null },
    transcript: { type: [TurnSchema], default: [] },
    summary: { type: String, default: null },
    durationSec: { type: Number, default: null },
    endedReason: { type: String, default: null },
    seq: { type: Number, default: -1 },
    responses: { type: Schema.Types.Mixed, default: () => ({}) },
    vendorTurns: { type: Number, default: 0 },
    noSpeechCount: { type: Number, default: 0 },
    llmFailures: { type: Number, default: 0 },
    briefRead: { type: Boolean, default: false },
    pendingArrival: { type: Date, default: null },
    pendingSpeech: { type: String, default: null },
    lastQuestion: { type: String, default: '' },
    outcomeAppliedAt: { type: Date, default: null },
    chainNotifiedAt: { type: Date, default: null },
    quoteStage: { type: String, default: 'identity' },
    stageTries: { type: Number, default: 0 },
    estimate: { type: Schema.Types.Mixed, default: null },
    heardArrival: { type: Date, default: null },
    arrivalConfirmed: { type: Date, default: null },
    nteAsked: { type: Boolean, default: false },
    nteAnswer: { type: String, default: null },
    quoteNotes: { type: [String], default: [] },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
  },
  { ...baseOptions<CallDoc>('calls'), minimize: false },
);
CallSchema.index({ createdAt: -1 });
CallSchema.index({ workOrderId: 1, createdAt: -1 });
CallSchema.index({ callSid: 1 }, { sparse: true });
CallSchema.index({ endedAt: 1, createdAt: -1 });

export const CallModel = model<CallDoc>('Call', CallSchema);

/** Collections the demo reset leaves alone. */
export const KEEP_ON_RESET = ['calls'];

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Public view of a call: no conversation internals, and never the dialed number. */
export function toCallRecord(c: CallDoc): CallRecord {
  return {
    id: c._id,
    callSid: c.callSid,
    workOrderId: c.workOrderId,
    purpose: c.purpose ?? 'book',
    chainId: c.chainId ?? null,
    workOrderNumber: c.workOrderNumber,
    workOrderTitle: c.workOrderTitle,
    vendorId: c.vendorId,
    vendorName: c.vendorName,
    siteName: c.siteName,
    status: c.status,
    twilioStatus: c.twilioStatus,
    outcome: c.outcome,
    eta: iso(c.eta),
    callbackAt: iso(c.callbackAt),
    reason: c.reason,
    reassignProposalId: c.reassignProposalId,
    quote: c.quote ?? null,
    transcript: c.transcript.map((t) => ({ ...t, at: t.at.toISOString() })),
    summary: c.summary,
    durationSec: c.durationSec,
    endedReason: c.endedReason,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    endedAt: iso(c.endedAt),
  };
}
