import { z } from 'zod';
import {
  ActivityEntry,
  Asset,
  AutonomyMode,
  Budget,
  HealthResponse,
  Proposal,
  SensorReading,
  Site,
  Vendor,
  WorkOrder,
  type ProposalStatus,
  type SignalInput,
  type WorkOrderDraftPatch,
  type WorkOrderStatus,
} from '@fia/shared';

/** Empty in dev (Vite proxies /api); the Render URL in production. */
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the server. It may be waking up; try again in a minute.', 0);
  }
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
        ? json.error
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return schema.parse(json);
}

const SensorReadingRow = SensorReading;

export const SignalAccepted = z.object({
  signalId: z.string(),
  status: z.string(),
  reference: z.string().nullable().optional(),
  safetyRuleId: z.string().nullable().optional(),
  language: z.enum(['en', 'es']).nullable().optional(),
});
export const AutonomyResponse = z.object({ mode: AutonomyMode, available: z.array(AutonomyMode) });
export const ApprovalResponse = z.object({
  proposal: Proposal,
  workOrder: WorkOrder,
  created: z.boolean(),
});

export const api = {
  health: () => call('/health', HealthResponse),
  sites: () => call('/sites', z.array(Site)),
  site: (id: string) => call(`/sites/${encodeURIComponent(id)}`, Site),
  assets: (siteId?: string) =>
    call(siteId ? `/assets?siteId=${encodeURIComponent(siteId)}` : '/assets', z.array(Asset)),
  vendors: () => call('/vendors', z.array(Vendor)),
  budgets: () => call('/budgets', z.array(Budget)),
  sensorReadings: (assetId: string, hours = 48) =>
    call(
      `/sensor-readings?assetId=${encodeURIComponent(assetId)}&hours=${hours}`,
      z.array(SensorReadingRow),
    ),

  submitSignal: (input: SignalInput) =>
    call('/signals', SignalAccepted, { method: 'POST', body: input }),
  pushSensor: (input: { assetId: string; metric: string; value: number; unit: string }) =>
    call('/demo/sensor', SignalAccepted, { method: 'POST', body: input }),

  proposals: (status?: ProposalStatus) =>
    call(status ? `/proposals?status=${status}` : '/proposals', z.array(Proposal)),
  proposal: (id: string) => call(`/proposals/${id}`, Proposal),
  editProposal: (id: string, patch: WorkOrderDraftPatch) =>
    call(`/proposals/${id}`, Proposal, { method: 'PATCH', body: patch }),
  approve: (id: string, patch: WorkOrderDraftPatch = {}) =>
    call(`/proposals/${id}/approve`, ApprovalResponse, { method: 'POST', body: patch }),
  reject: (id: string, reason: string) =>
    call(`/proposals/${id}/reject`, Proposal, { method: 'POST', body: { reason } }),

  workOrders: (filter: { status?: WorkOrderStatus; siteId?: string } = {}) => {
    const q = new URLSearchParams(
      Object.entries(filter).filter((e): e is [string, string] => Boolean(e[1])),
    ).toString();
    return call(`/work-orders${q ? `?${q}` : ''}`, z.array(WorkOrder));
  },
  workOrder: (id: string) => call(`/work-orders/${id}`, WorkOrder),

  activity: (filter: { proposalId?: string; workOrderId?: string } = {}) => {
    const q = new URLSearchParams(
      Object.entries(filter).filter((e): e is [string, string] => Boolean(e[1])),
    ).toString();
    return call(`/activity${q ? `?${q}` : ''}`, z.array(ActivityEntry));
  },

  autonomy: () => call('/settings/autonomy', AutonomyResponse),
  setAutonomy: (mode: z.infer<typeof AutonomyMode>) =>
    call('/settings/autonomy', AutonomyResponse, { method: 'PUT', body: { mode } }),
  resetDemo: () =>
    call('/demo/reset', z.object({ ok: z.boolean() }).passthrough(), { method: 'POST' }),
};
