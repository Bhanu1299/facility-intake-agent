import { Schema, model } from 'mongoose';
import {
  ActivityStep,
  PROPOSAL_STATUSES,
  type BudgetCheck,
  type DuplicateInfo,
  type ProposalStatus,
  type SafetyRuleHit,
  type SignalInput,
  type TokenUsage,
  type VendorRecommendation,
  type VerifyCheck,
  type WorkOrderDraft,
} from '@fia/shared';
import { baseOptions } from './common';

const Mixed = Schema.Types.Mixed;

export type SignalStatus = 'processing' | 'done' | 'failed';

export interface SignalDoc {
  _id: string;
  type: SignalInput['type'];
  siteId: string;
  input: SignalInput;
  receivedAt: Date;
  status: SignalStatus;
  proposalId: string | null;
  error: string | null;
}

export const SignalModel = model<SignalDoc>(
  'Signal',
  new Schema<SignalDoc>(
    {
      _id: { type: String, required: true },
      type: { type: String, enum: ['request', 'sensor'], required: true },
      siteId: { type: String, required: true },
      input: { type: Mixed, required: true },
      receivedAt: { type: Date, required: true },
      status: { type: String, enum: ['processing', 'done', 'failed'], required: true },
      proposalId: { type: String, default: null },
      error: { type: String, default: null },
    },
    baseOptions<SignalDoc>('signals'),
  ),
);

export interface ProposalDoc {
  _id: string;
  signalId: string;
  signalType: 'request' | 'sensor';
  inputText: string;
  status: ProposalStatus;
  action: 'create' | 'merge';
  draft: WorkOrderDraft;
  urgencyReason: string;
  safetyRule: SafetyRuleHit | null;
  vendors: VendorRecommendation[];
  budget: BudgetCheck;
  duplicate: DuplicateInfo | null;
  repeatIssueNote: string | null;
  trendNote: string | null;
  needsHuman: boolean;
  needsHumanReason: string | null;
  clarifyingQuestion: string | null;
  confidence: number;
  checks: VerifyCheck[];
  excludedVendors: { name: string; reason: string }[];
  modelUsed: string | null;
  escalated: boolean;
  latencyMs: number;
  usage: TokenUsage;
  workOrderId: string | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ProposalSchema = new Schema<ProposalDoc>(
  {
    _id: { type: String, required: true },
    signalId: { type: String, required: true, index: true },
    signalType: { type: String, enum: ['request', 'sensor'], required: true },
    inputText: { type: String, required: true },
    status: { type: String, enum: PROPOSAL_STATUSES, required: true },
    action: { type: String, enum: ['create', 'merge'], required: true },
    draft: { type: Mixed, required: true },
    urgencyReason: { type: String, default: '' },
    safetyRule: { type: Mixed, default: null },
    vendors: { type: Mixed, default: () => [] },
    budget: { type: Mixed, required: true },
    duplicate: { type: Mixed, default: null },
    repeatIssueNote: { type: String, default: null },
    trendNote: { type: String, default: null },
    needsHuman: { type: Boolean, required: true },
    needsHumanReason: { type: String, default: null },
    clarifyingQuestion: { type: String, default: null },
    confidence: { type: Number, required: true },
    checks: { type: Mixed, default: () => [] },
    excludedVendors: { type: Mixed, default: () => [] },
    modelUsed: { type: String, default: null },
    escalated: { type: Boolean, default: false },
    latencyMs: { type: Number, default: 0 },
    usage: { type: Mixed, required: true },
    workOrderId: { type: String, default: null },
    rejectionReason: { type: String, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { ...baseOptions<ProposalDoc>('proposals'), minimize: false },
);
ProposalSchema.index({ status: 1, createdAt: -1 });

export const ProposalModel = model<ProposalDoc>('Proposal', ProposalSchema);

export interface ActivityDoc {
  _id: string;
  timestamp: Date;
  signalId: string | null;
  proposalId: string | null;
  workOrderId: string | null;
  step: ActivityStep;
  actor: string;
  inputSummary: string;
  outputSummary: string;
  reason: string | null;
  latencyMs: number | null;
}

const ActivitySchema = new Schema<ActivityDoc>(
  {
    _id: { type: String, required: true },
    timestamp: { type: Date, required: true },
    signalId: { type: String, default: null },
    proposalId: { type: String, default: null },
    workOrderId: { type: String, default: null },
    step: { type: String, enum: ActivityStep.options, required: true },
    actor: { type: String, required: true },
    inputSummary: { type: String, default: '' },
    outputSummary: { type: String, default: '' },
    reason: { type: String, default: null },
    latencyMs: { type: Number, default: null },
  },
  baseOptions<ActivityDoc>('activity'),
);
ActivitySchema.index({ timestamp: -1 });
ActivitySchema.index({ proposalId: 1, timestamp: 1 });
ActivitySchema.index({ workOrderId: 1, timestamp: 1 });
ActivitySchema.index({ signalId: 1, timestamp: 1 });

export const ActivityModel = model<ActivityDoc>('Activity', ActivitySchema);
