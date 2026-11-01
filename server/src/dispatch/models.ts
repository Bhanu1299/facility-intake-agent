import { Schema, model } from 'mongoose';
import {
  CALL_MODES,
  CHAIN_PHASES,
  type CallMode,
  type ChainPhase,
  type ChainVendorState,
  type DispatchChain,
  type QuoteResult,
  type Urgency,
  type VendorEmailDraft,
} from '@fia/shared';
import { baseOptions } from '../models/common';

const Mixed = Schema.Types.Mixed;

export interface ChainVendorDoc {
  vendorId: string;
  name: string;
  state: ChainVendorState;
  quoteAttempts: number;
  bookAttempts: number;
  quote: QuoteResult | null;
  quoteCallId: string | null;
  note: string | null;
  // From the ranking, for the comparison cards.
  distanceMiles: number | null;
  rating: number | null;
  performanceScore: number | null;
}

/**
 * The agent working through vendors for one work order after an admin approved it: quote
 * calls, the booking call, retries and backups. Reset with the demo data (calls are kept).
 */
export interface ChainDoc {
  _id: string;
  workOrderId: string;
  workOrderNumber: string;
  urgency: Urgency;
  mode: CallMode;
  autoBackup: boolean;
  phase: ChainPhase;
  /** Ranked; the approved vendor first. */
  vendors: ChainVendorDoc[];
  bookingVendorId: string | null;
  proposalId: string | null;
  /** Bumped each time a proposal is raised, so proposal ids stay unique. */
  round: number;
  emails: (Omit<VendorEmailDraft, 'createdAt'> & { createdAt: Date })[];
  createdAt: Date;
  updatedAt: Date;
}

export const ChainModel = model<ChainDoc>(
  'DispatchChain',
  new Schema<ChainDoc>(
    {
      _id: { type: String, required: true },
      workOrderId: { type: String, required: true, index: true },
      workOrderNumber: { type: String, required: true },
      urgency: { type: String, required: true },
      mode: { type: String, enum: CALL_MODES, required: true },
      autoBackup: { type: Boolean, required: true },
      phase: { type: String, enum: CHAIN_PHASES, required: true },
      vendors: { type: Mixed, default: [] },
      bookingVendorId: { type: String, default: null },
      proposalId: { type: String, default: null },
      round: { type: Number, default: 0 },
      emails: { type: Mixed, default: [] },
      createdAt: { type: Date, required: true },
      updatedAt: { type: Date, required: true },
    },
    { ...baseOptions<ChainDoc>('dispatch_chains'), minimize: false },
  ),
);

export type JobPurpose = 'quote' | 'book' | 'retry';
export type JobStatus = 'pending' | 'running' | 'done' | 'cancelled';

/**
 * A call the chain will place once it's due. Stored in Mongo, not in-memory timers: Render's
 * free tier sleeps, and on wake the overdue jobs run.
 */
export interface ScheduledCallDoc {
  _id: string;
  dueAt: Date;
  workOrderId: string;
  chainId: string;
  vendorIndex: number;
  vendorId: string;
  purpose: JobPurpose;
  /** For retries: what is being retried. */
  retryOf: 'quote' | 'book' | null;
  attempt: number;
  status: JobStatus;
  claimedAt: Date | null;
  callId: string | null;
  result: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ScheduledCallSchema = new Schema<ScheduledCallDoc>(
  {
    _id: { type: String, required: true },
    dueAt: { type: Date, required: true },
    workOrderId: { type: String, required: true },
    chainId: { type: String, required: true },
    vendorIndex: { type: Number, required: true },
    vendorId: { type: String, required: true },
    purpose: { type: String, enum: ['quote', 'book', 'retry'], required: true },
    retryOf: { type: String, default: null },
    attempt: { type: Number, required: true },
    status: {
      type: String,
      enum: ['pending', 'running', 'done', 'cancelled'],
      required: true,
    },
    claimedAt: { type: Date, default: null },
    callId: { type: String, default: null },
    result: { type: String, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  baseOptions<ScheduledCallDoc>('scheduledCalls'),
);
ScheduledCallSchema.index({ status: 1, dueAt: 1, createdAt: 1 });
ScheduledCallSchema.index({ chainId: 1, status: 1 });

export const ScheduledCallModel = model<ScheduledCallDoc>('ScheduledCall', ScheduledCallSchema);

export function toChainRecord(c: ChainDoc, nextCallAt: Date | null): DispatchChain {
  return {
    id: c._id,
    workOrderId: c.workOrderId,
    mode: c.mode,
    autoBackup: c.autoBackup,
    phase: c.phase,
    vendors: c.vendors.map((v) => ({
      vendorId: v.vendorId,
      name: v.name,
      state: v.state,
      quoteAttempts: v.quoteAttempts,
      bookAttempts: v.bookAttempts,
      quote: v.quote,
      quoteCallId: v.quoteCallId,
      note: v.note,
    })),
    bookingVendorId: c.bookingVendorId,
    proposalId: c.proposalId,
    emails: c.emails.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    nextCallAt: nextCallAt ? nextCallAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
