import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CallRecord, WorkOrder } from '@fia/shared';
import { api } from '../api';
import { useAdminKey } from '../adminKey';
import { CALL_OUTCOME_LABEL, CALL_STATUS_LABEL, dateTime, siteTime } from '../format';
import { useAsync } from '../hooks';
import { Button, ErrorBanner, Tag } from './ui';

const STATUS_TONE: Record<CallRecord['status'], 'slate' | 'amber' | 'teal' | 'violet'> = {
  queued: 'slate',
  ringing: 'amber',
  in_call: 'teal',
  ended: 'violet',
};

/**
 * "Call vendor" for a dispatched work order. Admin only: the button shows once the admin key is
 * entered in Settings and the server has calls enabled. Everyone else sees the most recent
 * stored call, labeled "Recorded demo call", or nothing if there isn't one.
 */
export function VendorCallPanel({ wo, onChanged }: { wo: WorkOrder; onChanged: () => void }) {
  const adminKey = useAdminKey();
  const config = useAsync(() => api.callConfig(), []);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const admin = Boolean(adminKey && config.data?.enabled);

  // Poll quickly only while a call is running.
  const calls = useAsync(
    () =>
      api.workOrderCalls(wo.id).then((list) => {
        const running = list[0] ? list[0].status !== 'ended' : false;
        if (running !== active) setActive(running);
        if (active && !running) onChanged();
        return list;
      }),
    [wo.id],
    active ? 2000 : 15000,
  );
  const latest = useAsync(() => (admin ? Promise.resolve(null) : api.latestCall()), [admin]);

  const own = calls.data?.[0] ?? null;
  const shown = own ?? (admin ? null : (latest.data ?? null));
  const canCall = admin && wo.status === 'dispatched' && !active;

  const start = async () => {
    if (!adminKey) return;
    setStarting(true);
    setError(null);
    try {
      await api.startCall(wo.id, adminKey);
      setActive(true);
      calls.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Call failed to start');
    } finally {
      setStarting(false);
    }
  };

  if (!shown && !canCall && !error) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-lg bg-white ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          {own || canCall ? 'Vendor call' : 'Recorded demo call'}
          {shown && <Tag tone={STATUS_TONE[shown.status]}>{CALL_STATUS_LABEL[shown.status]}</Tag>}
        </div>
        {canCall && (
          <Button variant="primary" onClick={start} disabled={starting}>
            {starting ? 'Starting…' : own ? 'Call vendor again' : 'Call vendor'}
          </Button>
        )}
      </div>
      <div className="space-y-2 px-3 py-2">
        {error && <ErrorBanner message={error} />}
        {canCall && !own && (
          <p className="text-xs text-slate-500">
            An AI voice agent calls the demo phone (never the vendor number on file) to confirm the
            job and arrival time. The email draft stays the record.
          </p>
        )}
        {shown && <CallDetails call={shown} showWorkOrder={!own} />}
      </div>
    </div>
  );
}

function CallDetails({ call, showWorkOrder }: { call: CallRecord; showWorkOrder: boolean }) {
  const vendorSpoke = call.transcript.some((t) => t.speaker === 'vendor');
  return (
    <div className="space-y-2 text-sm">
      <p className="text-slate-600">
        {showWorkOrder && (
          <>
            {call.workOrderNumber} · {call.workOrderTitle} ·{' '}
          </>
        )}
        {call.vendorName} · {dateTime(call.createdAt)}
        {call.durationSec !== null && ` · ${call.durationSec}s`}
      </p>
      {(call.status === 'ringing' || call.status === 'in_call') && !vendorSpoke && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900 ring-1 ring-amber-200">
          Trial notice: press any key to connect. Twilio trial accounts play a short message first;
          the agent starts after a key press.
        </p>
      )}
      {call.outcome && (
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={call.outcome === 'confirmed' ? 'teal' : 'amber'}>
            {CALL_OUTCOME_LABEL[call.outcome]}
          </Tag>
          {call.eta && <span className="font-medium">ETA {siteTime(call.eta)}</span>}
          {call.callbackAt && <span>Call back {siteTime(call.callbackAt)}</span>}
          {call.reassignProposalId && !showWorkOrder && (
            <Link to={`/?p=${call.reassignProposalId}`} className="text-teal-800 underline">
              Review next-vendor proposal
            </Link>
          )}
        </div>
      )}
      {call.summary && <p className="text-slate-700">{call.summary}</p>}
      {call.transcript.length > 0 && (
        <details open={!call.outcome || showWorkOrder}>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-slate-500">
            Transcript ({call.transcript.length} lines)
          </summary>
          <ol className="mt-2 space-y-1.5">
            {call.transcript.map((t, i) => (
              <li key={i} className="flex gap-2">
                <span
                  className={`w-14 shrink-0 text-xs font-semibold uppercase ${
                    t.speaker === 'agent' ? 'text-teal-800' : 'text-slate-500'
                  }`}
                >
                  {t.speaker === 'agent' ? 'Agent' : 'Vendor'}
                </span>
                <span className="flex-1 text-slate-800">
                  {t.text}
                  {t.latencyMs !== null && (
                    <span className="ml-1 text-xs text-slate-400">
                      ({(t.latencyMs / 1000).toFixed(1)}s{t.model ? ` · ${t.model}` : ''})
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
