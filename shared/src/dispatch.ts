import { z } from 'zod';
import { QuoteResult } from './call';
import type { Urgency } from './enums';
import { DispatchEmail, WorkOrderDraftPatch } from './workOrder';

/**
 * How the agent calls vendors after approval. `quote`: phone the top 2 for a rough estimate, the
 * manager picks, then the winner gets a booking call. `book`: call vendor #1 to book right away.
 */
export const CALL_MODES = ['quote', 'book'] as const;
export const CallMode = z.enum(CALL_MODES);
export type CallMode = z.infer<typeof CallMode>;

/** Quote for routine / low / urgent, Book for emergencies. */
export const defaultCallMode = (urgency: Urgency): CallMode =>
  urgency === 'emergency' ? 'book' : 'quote';

/** Sent with an approval (admin only) to start a call chain. */
export const CallPlanInput = z.object({
  mode: CallMode,
  /** Book mode: on a miss or decline, call the next vendor without asking. */
  autoBackup: z.boolean(),
});
export type CallPlanInput = z.infer<typeof CallPlanInput>;

/** Body of POST /api/proposals/:id/approve: optional edits, plus a call plan (admin only). */
export const ApproveProposalInput = WorkOrderDraftPatch.extend({
  callPlan: CallPlanInput.optional(),
}).strict();
export type ApproveProposalInput = z.infer<typeof ApproveProposalInput>;

/** `closed` = the manager took over (picked a vendor by hand); the agent makes no more calls. */
export const CHAIN_PHASES = [
  'quoting',
  'quotes_ready',
  'booking',
  'awaiting_approval',
  'booked',
  'needs_human',
  'closed',
] as const;
/** Phases in which the agent may still place calls or is waiting on the manager. */
export const ACTIVE_CHAIN_PHASES = [
  'quoting',
  'quotes_ready',
  'booking',
  'awaiting_approval',
] as const;
export const ChainPhase = z.enum(CHAIN_PHASES);
export type ChainPhase = z.infer<typeof ChainPhase>;

/**
 * Per-vendor progress. `waiting` = called or retry scheduled; `dropped` = missed for good,
 * declined, opted out or rejected by the manager; never called again in this chain.
 */
export const CHAIN_VENDOR_STATES = ['unused', 'waiting', 'quoted', 'dropped', 'booked'] as const;
export const ChainVendorState = z.enum(CHAIN_VENDOR_STATES);
export type ChainVendorState = z.infer<typeof ChainVendorState>;

export const ChainVendor = z.object({
  vendorId: z.string(),
  name: z.string(),
  state: ChainVendorState,
  quoteAttempts: z.number().int().nonnegative(),
  bookAttempts: z.number().int().nonnegative(),
  quote: QuoteResult.nullable(),
  quoteCallId: z.string().nullable(),
  /** Why the vendor was dropped, or the last miss. */
  note: z.string().nullable(),
});
export type ChainVendor = z.infer<typeof ChainVendor>;

export const VendorEmailDraft = z.object({
  /** rfq = request for quote after a missed call; decline = "we've gone with another provider". */
  kind: z.enum(['rfq', 'decline']),
  vendorId: z.string(),
  vendorName: z.string(),
  email: DispatchEmail,
  createdAt: z.string(),
});
export type VendorEmailDraft = z.infer<typeof VendorEmailDraft>;

export const DispatchChain = z.object({
  id: z.string(),
  workOrderId: z.string(),
  mode: CallMode,
  autoBackup: z.boolean(),
  phase: ChainPhase,
  vendors: z.array(ChainVendor),
  /** Vendor picked from the quotes (or being booked). */
  bookingVendorId: z.string().nullable(),
  /** Open proposal waiting on the manager (quotes ready, runner-up, next vendor, needs human). */
  proposalId: z.string().nullable(),
  emails: z.array(VendorEmailDraft),
  /** Next scheduled call, if any. */
  nextCallAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DispatchChain = z.infer<typeof DispatchChain>;

/** One card in the "Quotes ready" comparison. */
export const QuoteCard = z.object({
  vendorId: z.string(),
  vendorName: z.string(),
  callId: z.string().nullable(),
  quote: QuoteResult,
  distanceMiles: z.number().nullable(),
  rating: z.number().nullable(),
  performanceScore: z.number().nullable(),
  summary: z.string().nullable(),
});
export type QuoteCard = z.infer<typeof QuoteCard>;

/** Set on `quotes` proposals: the manager picks one vendor (approve) or rejects all. */
export const QuotesInfo = z.object({
  workOrderId: z.string(),
  workOrderNumber: z.string(),
  chainId: z.string(),
  cards: z.array(QuoteCard),
  /** Vendor ids, or null when there is one card or a tie. */
  cheapestVendorId: z.string().nullable(),
  soonestVendorId: z.string().nullable(),
});
export type QuotesInfo = z.infer<typeof QuotesInfo>;

type Estimate = Pick<QuoteResult, 'quoteType' | 'low' | 'high' | 'callOutFee' | 'hourlyRate'>;

const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/** "$350", "$300–$450", "$95 call-out + $120/hr", "No estimate". Always approximate. */
export function formatEstimate(e: Estimate): string {
  switch (e.quoteType) {
    case 'fixed':
      return e.low !== null ? usd(e.low) : 'No estimate';
    case 'range':
      return e.low !== null && e.high !== null ? `${usd(e.low)}–${usd(e.high)}` : 'No estimate';
    case 'rates':
      return (
        [
          e.callOutFee !== null ? `${usd(e.callOutFee)} call-out` : null,
          e.hourlyRate !== null ? `${usd(e.hourlyRate)}/hr` : null,
        ]
          .filter(Boolean)
          .join(' + ') || 'No estimate'
      );
    case 'none':
      return 'No estimate';
  }
}

/**
 * The amount compared with the NTE: a fixed price, the top of a range, or the call-out fee plus
 * two hours at the hourly rate. Null when the vendor gave no numbers.
 */
export function estimateCeiling(e: Estimate): number | null {
  switch (e.quoteType) {
    case 'fixed':
      return e.low;
    case 'range':
      return e.high ?? e.low;
    case 'rates':
      return e.callOutFee === null && e.hourlyRate === null
        ? null
        : (e.callOutFee ?? 0) + 2 * (e.hourlyRate ?? 0);
    case 'none':
      return null;
  }
}
