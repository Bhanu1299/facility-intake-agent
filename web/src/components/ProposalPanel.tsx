import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  URGENCIES,
  type Proposal,
  type WorkOrder,
  type WorkOrderDraft,
  type WorkOrderDraftPatch,
} from '@fia/shared';
import { api } from '../api';
import { useApp } from '../context';
import { dateTime, money, TRADE_LABEL, TRADE_OPTIONS, URGENCY_LABEL } from '../format';
import { useAsync } from '../hooks';
import { BudgetBar } from './BudgetBar';
import { Button, ErrorBanner, Field, inputClass, Section, Spinner, Tag, UrgencyBadge } from './ui';

interface Props {
  proposalId: string;
  onClose: () => void;
  onChanged: () => void;
}

function statusLine(p: Proposal | undefined): string {
  switch (p?.status) {
    case undefined:
      return 'Loading…';
    case 'proposed':
      return 'Draft work order · waiting on you';
    case 'advisory':
      return 'Advice only · switch to Propose to act on it';
    case 'approved':
      return p.action === 'merge' ? 'Merged · approved by you' : 'Approved · work order created';
    case 'rejected':
      return 'Rejected';
  }
}

/** Right-side panel styled like an in-app assistant: everything the agent proposes, editable. */
export function ProposalPanel({ proposalId, onClose, onChanged }: Props) {
  const { version } = useApp();
  const proposal = useAsync(() => api.proposal(proposalId), [proposalId, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Proposal"
    >
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/20 sm:bg-slate-900/10"
      />
      <aside className="relative flex h-full w-full flex-col bg-white shadow-2xl ring-1 ring-slate-200 sm:max-w-xl">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-gradient-to-r from-teal-50 to-white px-5 py-3">
          <span
            className="grid h-8 w-8 place-items-center rounded-lg bg-teal-700 text-white"
            aria-hidden
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
              <path d="M10 1l2.2 5.3L17.5 8.5l-5.3 2.2L10 16l-2.2-5.3L2.5 8.5l5.3-2.2z" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-slate-900">Intake Agent</p>
            <p className="text-xs text-slate-500">{statusLine(proposal.data)}</p>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto">
          {proposal.error && !proposal.data && (
            <div className="p-5">
              <ErrorBanner message={proposal.error} onRetry={proposal.reload} />
            </div>
          )}
          {!proposal.data && !proposal.error && (
            <div className="px-5">
              <Spinner />
            </div>
          )}
          {proposal.data && (
            <ProposalBody
              // Remount on any server-side change so the edit form starts from the saved draft.
              key={proposal.data.updatedAt}
              proposal={proposal.data}
              onChanged={() => {
                proposal.reload();
                onChanged();
              }}
            />
          )}
        </div>
      </aside>
    </div>
  );
}

function ProposalBody({ proposal: p, onChanged }: { proposal: Proposal; onChanged: () => void }) {
  const { mode, assets, vendors, budgets, siteName, vendorName, refreshCatalog } = useApp();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<WorkOrderDraft>(p.draft);
  const [busy, setBusy] = useState<null | 'save' | 'approve' | 'reject'>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [approved, setApproved] = useState<WorkOrder | null>(null);

  const open = p.status === 'proposed' || p.status === 'advisory';
  const adviseMode = mode === 'advise';
  const siteAssets = assets.filter((a) => a.siteId === p.draft.siteId);
  const budget = budgets.find((b) => b.siteId === p.draft.siteId);
  const asset = assets.find((a) => a.id === form.assetId);

  const vendorOptions = useMemo(() => {
    const top = p.vendors.map((v) => v.vendorId);
    const others = vendors
      .filter(
        (v) => !top.includes(v.id) && (form.trade === 'unknown' || v.trades.includes(form.trade)),
      )
      .map((v) => v.id);
    return [...top, ...others];
  }, [p.vendors, vendors, form.trade]);

  const patch = (): WorkOrderDraftPatch => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(form) as (keyof WorkOrderDraft)[]) {
      if (k !== 'siteId' && form[k] !== p.draft[k]) out[k] = form[k];
    }
    return out as WorkOrderDraftPatch;
  };

  const run = async (kind: 'save' | 'approve' | 'reject', fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run('save', async () => {
      await api.editProposal(p.id, patch());
      setEditing(false);
      onChanged();
    });

  const approve = () =>
    run('approve', async () => {
      const res = await api.approve(p.id, patch());
      setApproved(res.workOrder);
      setEditing(false);
      refreshCatalog();
      onChanged();
    });

  const reject = () =>
    run('reject', async () => {
      await api.reject(p.id, reason);
      setRejecting(false);
      onChanged();
    });

  const set = <K extends keyof WorkOrderDraft>(k: K, v: WorkOrderDraft[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="pb-28">
      {/* Banners */}
      <div className="space-y-3 px-5 pt-4">
        {p.safetyRule && (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-900 ring-1 ring-red-200">
            <p className="font-semibold">Safety rule: {p.safetyRule.label}</p>
            <p>
              Matched “{p.safetyRule.matchedText}”. Forced to Emergency by a code rule; the model
              cannot override it.
            </p>
          </div>
        )}
        {p.needsHuman && (
          <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-950 ring-1 ring-amber-200">
            <p className="font-semibold">Needs a human: the agent won't guess</p>
            {p.clarifyingQuestion && (
              <p className="mt-1">Ask the requester: “{p.clarifyingQuestion}”</p>
            )}
            {p.needsHumanReason && <p className="mt-1 text-amber-800">Why: {p.needsHumanReason}</p>}
          </div>
        )}
        {p.status === 'advisory' && (
          <div className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700">
            Made in Advise mode: analysis only.{' '}
            {adviseMode ? 'Switch the dial to Propose to act on it.' : 'You can approve it now.'}
          </div>
        )}
        {p.status === 'rejected' && (
          <div className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700">
            Rejected: {p.rejectionReason}
          </div>
        )}
        {error && <ErrorBanner message={error} />}
      </div>

      {/* What came in */}
      <div className="px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          {p.signalType === 'sensor' ? 'Sensor alert' : 'Request'} · {siteName(p.draft.siteId)} ·{' '}
          {dateTime(p.createdAt)}
        </p>
        <blockquote className="mt-2 rounded-lg bg-slate-50 px-4 py-3 text-slate-800 ring-1 ring-slate-200">
          {p.inputText}
        </blockquote>
      </div>

      {/* Draft work order */}
      <Section
        title={p.action === 'merge' ? 'Proposed update to existing work order' : 'Draft work order'}
        aside={
          open && !editing ? (
            <Button variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null
        }
      >
        {editing ? (
          <div className="grid gap-3">
            <Field label="Title">
              <input
                className={inputClass}
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Trade">
                <select
                  className={inputClass}
                  value={form.trade}
                  onChange={(e) => set('trade', e.target.value as WorkOrderDraft['trade'])}
                >
                  {form.trade === 'unknown' && <option value="unknown">Unknown</option>}
                  {TRADE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {TRADE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Urgency">
                <select
                  className={inputClass}
                  value={form.urgency}
                  onChange={(e) => set('urgency', e.target.value as WorkOrderDraft['urgency'])}
                >
                  {URGENCIES.map((u) => (
                    <option key={u} value={u}>
                      {URGENCY_LABEL[u]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Asset">
              <select
                className={inputClass}
                value={form.assetId ?? ''}
                onChange={(e) => set('assetId', e.target.value || null)}
              >
                <option value="">No specific asset</option>
                {siteAssets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {a.location}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Location">
              <input
                className={inputClass}
                value={form.locationText}
                onChange={(e) => set('locationText', e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="NTE (USD)" hint="Not-to-exceed spending limit">
                <input
                  type="number"
                  min={0}
                  step={25}
                  className={inputClass}
                  value={form.nte}
                  onChange={(e) => set('nte', Math.max(0, Number(e.target.value) || 0))}
                />
              </Field>
              <Field label="Vendor">
                <select
                  className={inputClass}
                  value={form.vendorId ?? ''}
                  onChange={(e) => set('vendorId', e.target.value || null)}
                >
                  <option value="">Choose a vendor</option>
                  {vendorOptions.map((id) => (
                    <option key={id} value={id}>
                      {vendorName(id)}
                      {p.vendors[0]?.vendorId === id ? ' (recommended)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Description">
              <textarea
                rows={3}
                className={inputClass}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button variant="primary" onClick={save} disabled={busy !== null}>
                {busy === 'save' ? 'Saving…' : 'Save changes'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setForm(p.draft);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-[0.95rem]">
            <dt className="text-slate-500">Title</dt>
            <dd className="font-medium">{form.title}</dd>
            <dt className="text-slate-500">Trade</dt>
            <dd>
              {form.trade === 'unknown' ? <Tag tone="amber">Unknown</Tag> : TRADE_LABEL[form.trade]}
            </dd>
            <dt className="text-slate-500">Asset</dt>
            <dd>
              {asset ? `${asset.name} (${asset.id})` : <span className="text-slate-500">None</span>}
            </dd>
            <dt className="text-slate-500">Location</dt>
            <dd>{form.locationText || '—'}</dd>
            <dt className="text-slate-500">NTE</dt>
            <dd className="font-medium tabular-nums">{money(form.nte)}</dd>
            <dt className="text-slate-500">Vendor</dt>
            <dd>
              {form.vendorId ? vendorName(form.vendorId) : <Tag tone="amber">None chosen</Tag>}
            </dd>
          </dl>
        )}
      </Section>

      <Section title="Urgency">
        <div className="flex items-start gap-3">
          <UrgencyBadge urgency={form.urgency} />
          <p className="text-[0.95rem] text-slate-800">{p.urgencyReason}</p>
        </div>
        {p.trendNote && <p className="mt-2 text-sm font-medium text-slate-800">{p.trendNote}</p>}
      </Section>

      {(p.duplicate || p.repeatIssueNote) && (
        <Section title="History">
          {p.duplicate && (
            <div className="rounded-lg bg-violet-50 px-4 py-3 text-sm text-violet-950 ring-1 ring-violet-200">
              <p className="font-semibold">
                Looks like a duplicate of {p.duplicate.workOrderNumber}. Proposing a merge instead
                of a new work order.
              </p>
              <p className="mt-1">{p.duplicate.reason}</p>
              {p.duplicate.urgencyRaised && (
                <p className="mt-1 font-medium">
                  This report is more urgent: approving raises its urgency.
                </p>
              )}
            </div>
          )}
          {p.repeatIssueNote && (
            <p className="mt-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-950 ring-1 ring-amber-200">
              {p.repeatIssueNote}
            </p>
          )}
        </Section>
      )}

      <Section title="Recommended vendors">
        {p.vendors.length === 0 ? (
          <p className="text-sm text-slate-600">
            No vendor passed the filters (trade, insurance, availability).
          </p>
        ) : (
          <ol className="space-y-2">
            {p.vendors.map((v, i) => (
              <li
                key={v.vendorId}
                className={`rounded-lg px-3 py-2 ring-1 ${
                  form.vendorId === v.vendorId ? 'bg-teal-50 ring-teal-300' : 'ring-slate-200'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {i + 1}. {v.name}
                  </p>
                  <span className="text-xs tabular-nums text-slate-500">
                    score {v.score.toFixed(2)}
                  </span>
                </div>
                <p className="text-sm text-slate-700">{v.reason}</p>
              </li>
            ))}
          </ol>
        )}
        {p.excludedVendors.length > 0 && (
          <details className="mt-2 text-sm text-slate-600">
            <summary className="cursor-pointer">Excluded ({p.excludedVendors.length})</summary>
            <ul className="mt-1 list-disc pl-5">
              {p.excludedVendors.map((e) => (
                <li key={e.name}>
                  {e.name}: {e.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      <Section title={`Budget · ${siteName(p.draft.siteId)}`}>
        {budget ? <BudgetBar budget={budget} nte={form.nte} /> : <Spinner />}
        {p.budget.needsBudgetIncrease && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950 ring-1 ring-amber-200">
            Needs a budget increase: the standard NTE for this job is {money(p.budget.tableNte)}, so
            the NTE was capped at the {money(p.budget.available)} available (
            {money(p.budget.shortfall)} short).
          </p>
        )}
      </Section>

      <Section title="Checks">
        <ul className="space-y-1 text-sm">
          {p.checks.map((c) => (
            <li key={c.name} className="flex gap-2">
              <span className={c.passed ? 'text-emerald-700' : 'text-red-700'} aria-hidden>
                {c.passed ? '✓' : '✗'}
              </span>
              <span>
                <span className="font-medium">{c.name}</span>
                <span className="text-slate-600"> — {c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-500">
          Answered by {p.modelUsed ? <code>{p.modelUsed}</code> : 'no model'}
          {p.escalated && ' (escalated from the small model)'} · confidence{' '}
          {p.confidence.toFixed(2)} · {(p.latencyMs / 1000).toFixed(1)}s ·{' '}
          {p.usage.totalTokens.toLocaleString()} tokens ·{' '}
          <Link to={`/activity?proposalId=${p.id}`} className="text-teal-800 underline">
            activity log
          </Link>
        </p>
      </Section>

      {(approved || (p.status === 'approved' && p.workOrderId)) && (
        <ApprovedWorkOrder workOrder={approved} workOrderId={p.workOrderId ?? approved?.id ?? ''} />
      )}

      {/* Actions */}
      {open && (
        <div className="fixed bottom-0 right-0 w-full border-t border-slate-200 bg-white/95 px-5 py-3 backdrop-blur sm:max-w-xl">
          {rejecting ? (
            <div className="space-y-2">
              <Field label="Why are you rejecting this?">
                <input
                  className={inputClass}
                  value={reason}
                  autoFocus
                  placeholder="e.g. Already fixed by staff"
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  onClick={reject}
                  disabled={reason.trim().length < 3 || busy !== null}
                >
                  {busy === 'reject' ? 'Rejecting…' : 'Reject proposal'}
                </Button>
                <Button variant="ghost" onClick={() => setRejecting(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={approve}
                disabled={adviseMode || busy !== null}
                title={adviseMode ? 'Advise mode: approvals are off' : undefined}
              >
                {busy === 'approve'
                  ? 'Approving…'
                  : p.action === 'merge'
                    ? `Approve merge into ${p.duplicate?.workOrderNumber}`
                    : 'Approve & dispatch'}
              </Button>
              {!editing && (
                <Button onClick={() => setEditing(true)} disabled={busy !== null}>
                  Edit
                </Button>
              )}
              <Button variant="danger" onClick={() => setRejecting(true)} disabled={busy !== null}>
                Reject
              </Button>
              {adviseMode && (
                <span className="text-xs text-slate-500">Advise mode: approvals are off.</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovedWorkOrder({
  workOrder,
  workOrderId,
}: {
  workOrder: WorkOrder | null;
  workOrderId: string;
}) {
  const { vendorName } = useApp();
  const wo = useAsync(
    () => (workOrder ? Promise.resolve(workOrder) : api.workOrder(workOrderId)),
    [workOrderId, workOrder],
  );
  if (!wo.data) return wo.error ? <ErrorBanner message={wo.error} /> : null;
  const w = wo.data;
  return (
    <Section title="Approved">
      <p className="text-[0.95rem]">
        <span className="font-semibold">{w.number}</span> is <strong>{w.status}</strong> to{' '}
        {vendorName(w.vendorId)} · NTE {money(w.nte)} committed.
      </p>
      {w.dispatchEmail && (
        <div className="mt-3 overflow-hidden rounded-lg ring-1 ring-slate-200">
          <div className="flex items-center justify-between bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span>To: {w.dispatchEmail.to}</span>
            <Tag tone="amber">Draft — not sent</Tag>
          </div>
          <p className="border-b border-slate-200 px-3 py-2 text-sm font-medium">
            {w.dispatchEmail.subject}
          </p>
          <pre className="whitespace-pre-wrap px-3 py-2 font-sans text-sm text-slate-800">
            {w.dispatchEmail.body}
          </pre>
        </div>
      )}
    </Section>
  );
}
