import { z } from 'zod';
import { ProposalAction, ProposalStatus, URGENCY_RANK } from './enums';
import { QuotesInfo } from './dispatch';
import { WorkOrderDraft } from './workOrder';

export const VendorRecommendation = z.object({
  vendorId: z.string(),
  name: z.string(),
  score: z.number().min(0).max(1),
  distanceMiles: z.number().nonnegative(),
  rating: z.number(),
  performanceScore: z.number(),
  hourlyRate: z.number(),
  /** One line, e.g. "Closest (2.1 mi), 4.8 rating, insurance valid to Mar 2027." */
  reason: z.string(),
});
export type VendorRecommendation = z.infer<typeof VendorRecommendation>;

export const SafetyRuleHit = z.object({
  ruleId: z.string(),
  label: z.string(),
  matchedText: z.string(),
});
export type SafetyRuleHit = z.infer<typeof SafetyRuleHit>;

export const BudgetCheck = z.object({
  /** NTE from the trade x urgency table, before the budget cap. */
  tableNte: z.number().nonnegative(),
  available: z.number(),
  needsBudgetIncrease: z.boolean(),
  shortfall: z.number().nonnegative(),
});
export type BudgetCheck = z.infer<typeof BudgetCheck>;

export const DuplicateInfo = z.object({
  workOrderId: z.string(),
  workOrderNumber: z.string(),
  reason: z.string(),
  urgencyRaised: z.boolean(),
});
export type DuplicateInfo = z.infer<typeof DuplicateInfo>;

export const ReassignInfo = z.object({
  workOrderId: z.string(),
  workOrderNumber: z.string(),
  previousVendorId: z.string(),
  previousVendorName: z.string(),
  /** What the vendor said on the call. */
  reason: z.string(),
  callId: z.string(),
});
export type ReassignInfo = z.infer<typeof ReassignInfo>;

export const TokenUsage = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const VerifyCheck = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});
export type VerifyCheck = z.infer<typeof VerifyCheck>;

export const Proposal = z.object({
  id: z.string(),
  signalId: z.string(),
  signalType: z.enum(['request', 'sensor']),
  /** Short number given to the requester, e.g. REQ-1042. Null for sensor signals. */
  reference: z.string().nullable(),
  /** What came in: the request text, or the sensor reading in words. */
  inputText: z.string(),
  status: ProposalStatus,
  action: ProposalAction,
  draft: WorkOrderDraft,
  urgencyReason: z.string(),
  safetyRule: SafetyRuleHit.nullable(),
  vendors: z.array(VendorRecommendation).max(3),
  budget: BudgetCheck,
  duplicate: DuplicateInfo.nullable(),
  /** Set on `reassign` proposals. Older proposals may not have the field. */
  reassign: ReassignInfo.nullable().optional(),
  /** Set on `quotes` proposals. */
  quotes: QuotesInfo.nullable().optional(),
  repeatIssueNote: z.string().nullable(),
  /** Sensor signals only: "at this rate it crosses the threshold in about N days." */
  trendNote: z.string().nullable(),
  needsHuman: z.boolean(),
  needsHumanReason: z.string().nullable(),
  clarifyingQuestion: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  /** Results of the verify step, shown to the manager. */
  checks: z.array(VerifyCheck),
  /** Vendors removed by hard filters, with the reason. */
  excludedVendors: z.array(z.object({ name: z.string(), reason: z.string() })),
  modelUsed: z.string().nullable(),
  escalated: z.boolean(),
  latencyMs: z.number().nonnegative(),
  usage: TokenUsage,
  workOrderId: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Proposal = z.infer<typeof Proposal>;

export const RejectProposalInput = z.object({
  reason: z.string().trim().min(3).max(1000),
});
export type RejectProposalInput = z.infer<typeof RejectProposalInput>;

interface InboxSortable {
  draft: Pick<Proposal['draft'], 'urgency'>;
  needsHuman: boolean;
  createdAt: string | Date;
}

/** Inbox order: most urgent first, then needs-human, then newest. */
export function compareForInbox(a: InboxSortable, b: InboxSortable): number {
  const byUrgency = URGENCY_RANK[b.draft.urgency] - URGENCY_RANK[a.draft.urgency];
  if (byUrgency !== 0) return byUrgency;
  if (a.needsHuman !== b.needsHuman) return a.needsHuman ? -1 : 1;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}
