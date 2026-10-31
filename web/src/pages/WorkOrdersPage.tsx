import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { WORK_ORDER_STATUSES, type WorkOrder, type WorkOrderStatus } from '@fia/shared';
import { api } from '../api';
import { useApp } from '../context';
import { dateTime, money, STATUS_LABEL, TRADE_LABEL } from '../format';
import { useAsync } from '../hooks';
import {
  Empty,
  ErrorBanner,
  inputBase,
  PageHeader,
  Spinner,
  StatusBadge,
  Tag,
  UrgencyBadge,
} from '../components/ui';

const PAGE_SIZE = 25;

/** `open` = anything not completed (the default view); '' = everything. */
type StatusFilter = WorkOrderStatus | 'open' | '';

export function WorkOrdersPage() {
  const { version, sites, siteName, vendorName } = useApp();
  const [status, setStatus] = useState<StatusFilter>('open');
  const [siteId, setSiteId] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const wos = useAsync(
    () =>
      api.workOrders({
        status: status && status !== 'open' ? status : undefined,
        siteId: siteId || undefined,
      }),
    [status, siteId, version],
    8000,
  );
  const rows = useMemo(
    () => (wos.data ?? []).filter((w) => status !== 'open' || w.status !== 'completed'),
    [wos.data, status],
  );

  return (
    <div>
      <PageHeader
        title="Work Orders"
        description="Includes the seeded history. New ones appear here after you approve a proposal."
        actions={
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="Filter by status"
              className={`${inputBase} w-auto`}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as StatusFilter);
                setShown(PAGE_SIZE);
              }}
            >
              <option value="open">Open</option>
              <option value="">All statuses</option>
              {WORK_ORDER_STATUSES.filter((s) => s !== 'proposed').map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by site"
              className={`${inputBase} w-auto`}
              value={siteId}
              onChange={(e) => {
                setSiteId(e.target.value);
                setShown(PAGE_SIZE);
              }}
            >
              <option value="">All sites</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.shortName}
                </option>
              ))}
            </select>
          </div>
        }
      />

      {wos.error && !wos.data && <ErrorBanner message={wos.error} onRetry={wos.reload} />}
      {!wos.data && !wos.error && <Spinner />}
      {wos.data && rows.length === 0 && <Empty title="No work orders match these filters" />}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
          <table className="w-full text-left text-[0.95rem]">
            <thead className="hidden bg-slate-50 text-xs uppercase tracking-wider text-slate-500 md:table-header-group">
              <tr>
                <th className="px-4 py-2 font-semibold">Work order</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Site</th>
                <th className="px-4 py-2 font-semibold">Vendor</th>
                <th className="px-4 py-2 text-right font-semibold">NTE</th>
                <th className="px-4 py-2 font-semibold">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {rows.slice(0, shown).map((w) => (
                <Row
                  key={w.id}
                  wo={w}
                  open={openId === w.id}
                  onToggle={() => setOpenId(openId === w.id ? null : w.id)}
                  siteName={siteName(w.siteId)}
                  vendorName={vendorName(w.vendorId)}
                />
              ))}
            </tbody>
          </table>
          {rows.length > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE_SIZE)}
              className="w-full border-t border-slate-200 px-4 py-2.5 text-sm font-medium text-teal-800 hover:bg-slate-50"
            >
              Show more ({rows.length - shown} left)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  wo,
  open,
  onToggle,
  siteName,
  vendorName,
}: {
  wo: WorkOrder;
  open: boolean;
  onToggle: () => void;
  siteName: string;
  vendorName: string;
}) {
  return (
    <>
      <tr
        className="flex cursor-pointer flex-col gap-1 px-4 py-3 hover:bg-slate-50 md:table-row md:p-0"
        onClick={onToggle}
        aria-expanded={open}
      >
        <td className="md:px-4 md:py-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-slate-500">{wo.number}</span>
            <UrgencyBadge urgency={wo.urgency} />
            {wo.proposalId && <Tag tone="teal">via Intake Agent</Tag>}
          </div>
          <p className="mt-0.5 font-medium text-slate-900">{wo.title}</p>
          <p className="text-sm text-slate-500">{TRADE_LABEL[wo.trade]}</p>
        </td>
        <td className="md:px-4 md:py-3">
          <StatusBadge status={wo.status} />
        </td>
        <td className="text-sm md:px-4 md:py-3">{siteName}</td>
        <td className="text-sm md:px-4 md:py-3">{vendorName}</td>
        <td className="text-sm font-medium tabular-nums md:px-4 md:py-3 md:text-right">
          {money(wo.nte)}
          {wo.actualCost !== null && (
            <span className="block text-xs font-normal text-slate-500">
              spent {money(wo.actualCost)}
            </span>
          )}
        </td>
        <td className="text-sm text-slate-500 md:px-4 md:py-3">{dateTime(wo.createdAt)}</td>
      </tr>
      {open && (
        <tr className="block bg-slate-50 md:table-row">
          <td colSpan={6} className="block px-4 py-3 md:table-cell">
            <p className="text-sm text-slate-700">{wo.description}</p>
            <p className="mt-1 text-sm text-slate-500">Location: {wo.locationText || '—'}</p>
            {wo.notes.length > 0 && (
              <div className="mt-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Merged reports
                </p>
                <ul className="mt-1 list-disc pl-5 text-sm">
                  {wo.notes.map((n) => (
                    <li key={n}>{n.replace(/^\[[^\]]+\]\s*/, '')}</li>
                  ))}
                </ul>
              </div>
            )}
            {wo.dispatchEmail && (
              <div className="mt-3 overflow-hidden rounded-lg bg-white ring-1 ring-slate-200">
                <div className="flex items-center justify-between bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <span>To: {wo.dispatchEmail.to}</span>
                  <Tag tone="amber">Draft — not sent</Tag>
                </div>
                <p className="border-b border-slate-200 px-3 py-2 text-sm font-medium">
                  {wo.dispatchEmail.subject}
                </p>
                <pre className="whitespace-pre-wrap px-3 py-2 font-sans text-sm">
                  {wo.dispatchEmail.body}
                </pre>
              </div>
            )}
            <Link
              to={`/activity?workOrderId=${wo.id}`}
              className="mt-2 inline-block text-sm text-teal-800 underline"
            >
              Activity for {wo.number}
            </Link>
          </td>
        </tr>
      )}
    </>
  );
}
