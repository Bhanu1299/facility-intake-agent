import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Proposal } from '@fia/shared';
import { api } from '../api';
import { useApp } from '../context';
import { timeAgo } from '../format';
import { useAsync } from '../hooks';
import { ProposalPanel } from '../components/ProposalPanel';
import { Empty, ErrorBanner, PageHeader, Spinner, Tag, UrgencyBadge } from '../components/ui';

const FILTERS = [
  { key: 'open', label: 'Needs review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

const matches = (p: Proposal, f: FilterKey): boolean =>
  f === 'all' ||
  (f === 'open' ? p.status === 'proposed' || p.status === 'advisory' : p.status === f);

export function InboxPage() {
  const { version, siteName, sites, mode } = useApp();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<FilterKey>('open');
  const selectedId = params.get('p');
  const proposals = useAsync(() => api.proposals(), [version], 4000);

  const list = useMemo(
    () => (proposals.data ?? []).filter((p) => matches(p, filter)),
    [proposals.data, filter],
  );
  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((f) => [f.key, (proposals.data ?? []).filter((p) => matches(p, f.key)).length]),
      ) as Record<FilterKey, number>,
    [proposals.data],
  );

  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('p', id);
    else next.delete('p');
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        title="Inbox"
        description={
          mode === 'advise'
            ? 'Requests and sensor alerts, analyzed by the agent. Advise mode: nothing can be approved or dispatched.'
            : 'Requests and sensor alerts, turned into draft work orders. Nothing happens until you approve.'
        }
      />

      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset ${
              filter === f.key
                ? 'bg-slate-900 text-white ring-slate-900'
                : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'
            }`}
          >
            {f.label}
            <span className="ml-1.5 tabular-nums opacity-70">{counts[f.key]}</span>
          </button>
        ))}
      </div>

      {proposals.error && !proposals.data && (
        <ErrorBanner message={proposals.error} onRetry={proposals.reload} />
      )}
      {!proposals.data && !proposals.error && <Spinner />}

      {proposals.data && list.length === 0 && (
        <Empty title={filter === 'open' ? 'Nothing waiting for review' : 'No proposals here'}>
          <p>
            Submit a request from a site's QR page, or push a reading from the sensor simulator:
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {sites.map((s) => (
              <Link
                key={s.id}
                to={`/r/${s.id}`}
                className="rounded-md bg-slate-100 px-2.5 py-1 text-sm font-medium text-teal-800 hover:bg-slate-200"
              >
                /r/{s.id}
              </Link>
            ))}
            <Link
              to="/simulator"
              className="rounded-md bg-slate-100 px-2.5 py-1 text-sm font-medium text-teal-800 hover:bg-slate-200"
            >
              Sensor simulator
            </Link>
          </div>
        </Empty>
      )}

      {list.length > 0 && (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
          {list.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => select(p.id)}
                className={`flex w-full flex-col gap-1.5 px-4 py-3 text-left hover:bg-slate-50 sm:flex-row sm:items-center sm:gap-4 ${
                  selectedId === p.id ? 'bg-teal-50/60' : ''
                }`}
              >
                <div className="flex items-center gap-2 sm:w-28">
                  <UrgencyBadge urgency={p.draft.urgency} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-900">{p.draft.title}</p>
                  <p className="truncate text-sm text-slate-500">
                    {siteName(p.draft.siteId)} ·{' '}
                    {p.signalType === 'sensor' ? 'Sensor alert' : 'Request'}
                    {' · '}
                    {p.inputText}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {p.safetyRule && <Tag tone="red">Safety rule</Tag>}
                  {p.needsHuman && <Tag tone="amber">Needs human</Tag>}
                  {p.action === 'merge' && (
                    <Tag tone="violet">Merge · {p.duplicate?.workOrderNumber}</Tag>
                  )}
                  {p.budget.needsBudgetIncrease && <Tag tone="amber">Over budget</Tag>}
                  {p.status !== 'proposed' && <Tag>{p.status}</Tag>}
                  <span className="whitespace-nowrap text-sm text-slate-500">
                    {timeAgo(p.createdAt)}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selectedId && (
        <ProposalPanel
          key={selectedId}
          proposalId={selectedId}
          onClose={() => select(null)}
          onChanged={proposals.reload}
        />
      )}
    </div>
  );
}
