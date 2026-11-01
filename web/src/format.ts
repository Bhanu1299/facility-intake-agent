import type {
  CallOutcome,
  CallStatus,
  ChainPhase,
  ChainVendorState,
  Trade,
  TradeOrUnknown,
  Urgency,
  WithinNte,
  WorkOrderStatus,
} from '@fia/shared';

export const TRADE_LABEL: Record<TradeOrUnknown, string> = {
  plumbing: 'Plumbing',
  hvac: 'HVAC',
  refrigeration: 'Refrigeration',
  electrical: 'Electrical',
  handyman: 'Handyman',
  pest_control: 'Pest control',
  unknown: 'Unknown',
};

/** Gas lines are plumber work; say so, so it reads as deliberate. */
export const tradeLabel = (trade: TradeOrUnknown, safetyRuleId?: string | null): string =>
  trade === 'plumbing' && safetyRuleId === 'gas_smell' ? 'Plumbing (gas)' : TRADE_LABEL[trade];

export const TRADE_OPTIONS = Object.keys(TRADE_LABEL).filter((t) => t !== 'unknown') as Trade[];

export const URGENCY_LABEL: Record<Urgency, string> = {
  emergency: 'Emergency',
  urgent: 'Urgent',
  routine: 'Routine',
  low: 'Low',
};

export const URGENCY_STYLE: Record<Urgency, string> = {
  emergency: 'bg-red-600 text-white',
  urgent: 'bg-orange-500 text-white',
  routine: 'bg-blue-600 text-white',
  low: 'bg-slate-400 text-white',
};

export const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  dispatched: 'Dispatched',
  accepted: 'Accepted',
  in_progress: 'In progress',
  completed: 'Completed',
};

export const STATUS_STYLE: Record<WorkOrderStatus, string> = {
  proposed: 'bg-slate-100 text-slate-700 ring-slate-300',
  approved: 'bg-teal-50 text-teal-800 ring-teal-300',
  dispatched: 'bg-indigo-50 text-indigo-800 ring-indigo-300',
  accepted: 'bg-sky-50 text-sky-800 ring-sky-300',
  in_progress: 'bg-amber-50 text-amber-800 ring-amber-300',
  completed: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
};

export const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export const dateTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
  queued: 'Queued',
  ringing: 'Ringing',
  in_call: 'In call',
  ended: 'Ended',
};

export const CALL_OUTCOME_LABEL: Record<CallOutcome, string> = {
  confirmed: 'Confirmed',
  quoted: 'Quote received',
  declined: 'Declined',
  callback_requested: 'Callback requested',
  opted_out: 'Asked not to be called',
  ended: 'Ended without a decision · email fallback used',
  email_fallback: 'Email fallback used',
};

export const CHAIN_PHASE_LABEL: Record<ChainPhase, string> = {
  quoting: 'Collecting quotes',
  quotes_ready: 'Quotes ready · waiting on you',
  booking: 'Booking call',
  awaiting_approval: 'Next vendor · waiting on you',
  booked: 'Booked',
  needs_human: 'No vendor reached · needs you',
  closed: 'Handed to the manager',
};

export const CHAIN_VENDOR_STATE_LABEL: Record<ChainVendorState, string> = {
  unused: 'Not called',
  waiting: 'In progress',
  quoted: 'Quoted',
  dropped: 'Out',
  booked: 'Booked',
};

export const WITHIN_NTE_LABEL: Record<WithinNte, string> = {
  yes: 'Within the limit',
  no: "Can't work within the limit",
  maybe: 'Maybe within the limit',
  unknown: 'Limit not discussed',
};

/** Absolute local time for ETAs, in the sites' zone (all sites are in Buffalo). */
export const siteTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  });
