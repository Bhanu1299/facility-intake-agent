import { Link } from 'react-router-dom';
import { formatEstimate, type DispatchChain } from '@fia/shared';
import { CHAIN_PHASE_LABEL, CHAIN_VENDOR_STATE_LABEL, siteTime } from '../format';
import { Tag } from './ui';

const PHASE_TONE: Record<DispatchChain['phase'], 'slate' | 'amber' | 'teal' | 'violet' | 'red'> = {
  quoting: 'teal',
  quotes_ready: 'amber',
  booking: 'teal',
  awaiting_approval: 'amber',
  booked: 'violet',
  needs_human: 'red',
  closed: 'slate',
};

const STATE_TONE = {
  unused: 'slate',
  waiting: 'teal',
  quoted: 'violet',
  dropped: 'slate',
  booked: 'violet',
} as const;

/** What the agent is doing for this work order: mode, phase, each vendor, scheduled calls. */
export function ChainPanel({ chain }: { chain: DispatchChain }) {
  const next =
    chain.nextCallAt && new Date(chain.nextCallAt) > new Date() ? chain.nextCallAt : null;
  return (
    <div className="mt-3 overflow-hidden rounded-lg bg-white ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Agent calls · {chain.mode === 'quote' ? 'Quote mode' : 'Book mode'}
          {chain.autoBackup && ' · auto-backup'}
          <Tag tone={PHASE_TONE[chain.phase]}>{CHAIN_PHASE_LABEL[chain.phase]}</Tag>
        </div>
        {chain.proposalId && (
          <Link to={`/?p=${chain.proposalId}`} className="text-sm text-teal-800 underline">
            {chain.phase === 'quotes_ready' ? 'Compare quotes' : 'Open proposal'}
          </Link>
        )}
      </div>
      <div className="space-y-2 px-3 py-2 text-sm">
        {chain.phase === 'needs_human' && (
          <p role="alert" className="rounded-md bg-red-600 px-3 py-2 font-semibold text-white">
            No vendor reached. Choose a vendor manually from the proposal.
          </p>
        )}
        {next && <p className="text-slate-600">Next call {siteTime(next)}</p>}
        <ol className="space-y-1">
          {chain.vendors.map((v, i) => (
            <li key={v.vendorId} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">
                {i + 1}. {v.name}
              </span>
              <Tag tone={STATE_TONE[v.state]}>
                {chain.bookingVendorId === v.vendorId && v.state === 'waiting'
                  ? 'Booking'
                  : CHAIN_VENDOR_STATE_LABEL[v.state]}
              </Tag>
              {v.quote && (
                <span className="tabular-nums">
                  {formatEstimate(v.quote)} <span className="text-slate-500">(approximate)</span>
                </span>
              )}
              {v.note && <span className="text-slate-500">{v.note}</span>}
            </li>
          ))}
        </ol>
        {chain.emails.map((e) => (
          <details key={`${e.kind}-${e.vendorId}`} className="rounded-md ring-1 ring-slate-200">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-1.5">
              <span>
                {e.kind === 'rfq' ? 'Request-for-quote email' : 'Decline email'} to {e.vendorName}
              </span>
              <Tag tone="amber">Draft — not sent</Tag>
            </summary>
            <p className="border-t border-slate-200 px-3 py-1.5 font-medium">{e.email.subject}</p>
            <pre className="whitespace-pre-wrap px-3 pb-2 font-sans text-slate-800">
              {e.email.body}
            </pre>
          </details>
        ))}
      </div>
    </div>
  );
}
