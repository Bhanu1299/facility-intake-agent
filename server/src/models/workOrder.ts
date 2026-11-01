import { Schema, model } from 'mongoose';
import {
  TRADES,
  URGENCIES,
  WORK_ORDER_STATUSES,
  type DispatchEmail,
  type QuoteResult,
  type Trade,
  type Urgency,
  type WorkOrderStatus,
} from '@fia/shared';
import { baseOptions } from './common';

export interface WorkOrderDoc {
  _id: string;
  number: string;
  siteId: string;
  assetId: string | null;
  trade: Trade;
  title: string;
  description: string;
  locationText: string;
  urgency: Urgency;
  nte: number;
  vendorId: string | null;
  status: WorkOrderStatus;
  proposalId: string | null;
  notes: string[];
  dispatchEmail: DispatchEmail | null;
  /** Confirmed arrival time from the dispatch call. Optional: seeded rows don't set it. */
  eta?: Date | null;
  declinedVendorIds?: string[];
  /** Winning quote (approximate), stored when the booking call confirms. */
  agreedQuote?: QuoteResult | null;
  actualCost: number | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

/** Statuses that count as "open" for duplicate detection and Committed budget. */
export const OPEN_STATUSES: WorkOrderStatus[] = [
  'approved',
  'dispatched',
  'accepted',
  'in_progress',
];

const WorkOrderSchema = new Schema<WorkOrderDoc>(
  {
    _id: { type: String, required: true },
    number: { type: String, required: true, unique: true },
    siteId: { type: String, required: true },
    assetId: { type: String, default: null },
    trade: { type: String, enum: TRADES, required: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    locationText: { type: String, default: '' },
    urgency: { type: String, enum: URGENCIES, required: true },
    nte: { type: Number, required: true, min: 0 },
    vendorId: { type: String, default: null },
    status: { type: String, enum: WORK_ORDER_STATUSES, required: true },
    proposalId: { type: String, default: null },
    notes: { type: [String], default: [] },
    dispatchEmail: {
      type: new Schema(
        { to: String, subject: String, body: String, sent: { type: Boolean, default: false } },
        { _id: false },
      ),
      default: null,
    },
    eta: { type: Date, default: null },
    declinedVendorIds: { type: [String], default: [] },
    agreedQuote: { type: Schema.Types.Mixed, default: null },
    actualCost: { type: Number, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    closedAt: { type: Date, default: null },
  },
  baseOptions<WorkOrderDoc>('work_orders'),
);
WorkOrderSchema.index({ siteId: 1, status: 1, createdAt: -1 });
WorkOrderSchema.index({ assetId: 1, createdAt: -1 });

export const WorkOrderModel = model<WorkOrderDoc>('WorkOrder', WorkOrderSchema);

/** Monotonic counters, e.g. the next work order number. */
export const CounterModel = model<{ _id: string; seq: number }>(
  'Counter',
  new Schema<{ _id: string; seq: number }>(
    { _id: { type: String, required: true }, seq: { type: Number, required: true } },
    { collection: 'counters', versionKey: false },
  ),
);

export async function nextWorkOrderNumber(): Promise<string> {
  const counter = await CounterModel.findOneAndUpdate(
    { _id: 'workOrder' },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return `WO-${counter.seq}`;
}

/** Short reference handed to the requester on the confirmation page: REQ-1001, REQ-1002, ... */
export async function nextRequestReference(): Promise<string> {
  const counter = await CounterModel.findOneAndUpdate(
    { _id: 'request' },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return `REQ-${1000 + counter.seq}`;
}
