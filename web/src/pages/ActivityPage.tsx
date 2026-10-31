import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ActivityEntry } from '@fia/shared';
import { api } from '../api';
import { useApp } from '../context';
import { dateTime } from '../format';
import { useAsync } from '../hooks';
import { Button, Empty, ErrorBanner, inputBase, PageHeader, Spinner } from '../components/ui';

const STEP_STYLE: Record<string, string> = {
  normalize: 'bg-slate-100 text-slate-700',
  understand: 'bg-violet-100 text-violet-800',
  safety: 'bg-red-100 text-red-800',
  ground: 'bg-sky-100 text-sky-800',
  plan: 'bg-indigo-100 text-indigo-800',
  verify: 'bg-amber-100 text-amber-900',
  propose: 'bg-teal-100 text-teal-800',
  edit: 'bg-slate-200 text-slate-800',
  approve: 'bg-emerald-100 text-emerald-800',
  dispatch: 'bg-indigo-100 text-indigo-800',
  call: 'bg-fuchsia-100 text-fuchsia-800',
  reject: 'bg-red-100 text-red-800',
  settings: 'bg-slate-200 text-slate-800',
  reset: 'bg-slate-200 text-slate-800',
};

function Actor({ actor }: { actor: string }) {
  if (actor === 'manager') return <span className="font-semibold text-emerald-800">Manager</span>;
  if (actor.startsWith('model:'))
    return <code className="rounded bg-violet-50 px-1 text-violet-800">{actor.slice(6)}</code>;
  return <span className="text-slate-500">System</span>;
}

export function ActivityPage() {
  const { version } = useApp();
  const [params, setParams] = useSearchParams();
  const proposalId = params.get('proposalId') ?? '';
  const workOrderId = params.get('workOrderId') ?? '';
  const [draft, setDraft] = useState({ proposalId, workOrderId });
  const log = useAsync(
    () =>
      api.activity({ proposalId: proposalId || undefined, workOrderId: workOrderId || undefined }),
    [proposalId, workOrderId, version],
    proposalId || workOrderId ? undefined : 5000,
  );

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams();
    if (draft.proposalId.trim()) next.set('proposalId', draft.proposalId.trim());
    if (draft.workOrderId.trim()) next.set('workOrderId', draft.workOrderId.trim());
    setParams(next);
  };

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Activity Log"
        description="Every pipeline step and every human action, with who did it and why."
      />
      <form onSubmit={apply} className="mb-5 flex flex-wrap items-end gap-2">
        <input
          aria-label="Proposal id"
          className={`${inputBase} w-56`}
          placeholder="Proposal id"
          value={draft.proposalId}
          onChange={(e) => setDraft({ ...draft, proposalId: e.target.value })}
        />
        <input
          aria-label="Work order id"
          className={`${inputBase} w-56`}
          placeholder="Work order id"
          value={draft.workOrderId}
          onChange={(e) => setDraft({ ...draft, workOrderId: e.target.value })}
        />
        <Button type="submit">Filter</Button>
        {(proposalId || workOrderId) && (
          <Button
            variant="ghost"
            onClick={() => {
              setDraft({ proposalId: '', workOrderId: '' });
              setParams(new URLSearchParams());
            }}
          >
            Clear
          </Button>
        )}
      </form>

      {log.error && !log.data && <ErrorBanner message={log.error} onRetry={log.reload} />}
      {!log.data && !log.error && <Spinner />}
      {log.data && log.data.length === 0 && <Empty title="No activity yet" />}
      {log.data && log.data.length > 0 && (
        <ol className="relative space-y-3 border-l-2 border-slate-200 pl-5">
          {log.data.map((a) => (
            <Entry key={a.id} a={a} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Entry({ a }: { a: ActivityEntry }) {
  return (
    <li className="relative">
      <span className="absolute -left-[1.72rem] top-3 h-3 w-3 rounded-full border-2 border-white bg-slate-400" />
      <div className="rounded-lg bg-white px-4 py-3 ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span
            className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase ${STEP_STYLE[a.step] ?? ''}`}
          >
            {a.step}
          </span>
          <Actor actor={a.actor} />
          <span className="text-slate-400">·</span>
          <span className="text-slate-500">{dateTime(a.timestamp)}</span>
          {a.latencyMs !== null && <span className="text-slate-400">{a.latencyMs} ms</span>}
          <span className="ml-auto flex gap-2 text-xs">
            {a.proposalId && (
              <Link className="text-teal-800 underline" to={`/activity?proposalId=${a.proposalId}`}>
                proposal
              </Link>
            )}
            {a.workOrderId && (
              <Link
                className="text-teal-800 underline"
                to={`/activity?workOrderId=${a.workOrderId}`}
              >
                work order
              </Link>
            )}
          </span>
        </div>
        {a.inputSummary && <p className="mt-1 text-sm text-slate-600">{a.inputSummary}</p>}
        {a.outputSummary && (
          <p className="mt-1 text-[0.95rem] text-slate-900">→ {a.outputSummary}</p>
        )}
        {a.reason && <p className="mt-1 text-sm italic text-slate-600">{a.reason}</p>}
      </div>
    </li>
  );
}
