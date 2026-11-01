import { Link } from 'react-router-dom';
import { formatEstimate, type QuoteCard, type QuotesInfo } from '@fia/shared';
import { siteTime, WITHIN_NTE_LABEL } from '../format';
import { Button, Tag } from './ui';

const LIMIT_TONE = { yes: 'teal', no: 'red', maybe: 'amber', unknown: 'slate' } as const;

/** Side-by-side quote cards. Highlights cheaper and sooner; the manager picks (no auto-pick). */
export function QuotesReady({
  quotes,
  nte,
  canPick,
  busyVendorId,
  onPick,
}: {
  quotes: QuotesInfo;
  nte: number;
  canPick: boolean;
  busyVendorId: string | null;
  onPick: (vendorId: string) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Rough phone estimates, not bids: the vendor confirms on site. NTE ${nte.toLocaleString()}.
        Picking a vendor dispatches the job and the agent calls them to book.
      </p>
      <div className={`grid gap-3 ${quotes.cards.length > 1 ? 'sm:grid-cols-2' : ''}`}>
        {quotes.cards.map((c) => (
          <Card
            key={c.vendorId}
            card={c}
            workOrderId={quotes.workOrderId}
            cheapest={quotes.cheapestVendorId === c.vendorId}
            soonest={quotes.soonestVendorId === c.vendorId}
            canPick={canPick}
            busy={busyVendorId === c.vendorId}
            disabled={busyVendorId !== null}
            onPick={() => onPick(c.vendorId)}
          />
        ))}
      </div>
    </div>
  );
}

function Card({
  card: c,
  workOrderId,
  cheapest,
  soonest,
  canPick,
  busy,
  disabled,
  onPick,
}: {
  card: QuoteCard;
  workOrderId: string;
  cheapest: boolean;
  soonest: boolean;
  canPick: boolean;
  busy: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const q = c.quote;
  return (
    <div
      className={`flex flex-col rounded-lg p-3 ring-1 ${
        cheapest || soonest ? 'bg-teal-50/50 ring-teal-300' : 'ring-slate-200'
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="font-semibold text-slate-900">{c.vendorName}</p>
        {cheapest && <Tag tone="teal">Cheaper</Tag>}
        {soonest && <Tag tone="teal">Sooner</Tag>}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">{formatEstimate(q)}</p>
      <p className="text-xs text-slate-500">
        {q.quoteType === 'none' ? 'Vendor would not estimate by phone' : 'approximate'}
      </p>
      <dl className="mt-2 grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1 text-sm">
        <dt className="text-slate-500">Limit</dt>
        <dd>
          <Tag tone={LIMIT_TONE[q.withinNte]}>{WITHIN_NTE_LABEL[q.withinNte]}</Tag>
        </dd>
        <dt className="text-slate-500">Earliest</dt>
        <dd>{q.earliestArrival ? siteTime(q.earliestArrival) : 'Not given'}</dd>
        <dt className="text-slate-500">Distance</dt>
        <dd>{c.distanceMiles !== null ? `${c.distanceMiles} mi` : '—'}</dd>
        <dt className="text-slate-500">Rating</dt>
        <dd>
          {c.rating !== null ? c.rating.toFixed(1) : '—'}
          {c.performanceScore !== null && (
            <span className="text-slate-500"> · performance {c.performanceScore}</span>
          )}
        </dd>
      </dl>
      {q.notes && <p className="mt-2 text-sm text-slate-700">Notes: {q.notes}</p>}
      <p className="mt-1 text-xs text-slate-500">
        Speech confidence {Math.round(q.confidence * 100)}% ·{' '}
        <Link to={`/work-orders?wo=${workOrderId}`} className="text-teal-800 underline">
          transcript
        </Link>
      </p>
      {canPick && (
        <Button variant="primary" className="mt-3" onClick={onPick} disabled={disabled}>
          {busy ? 'Picking…' : `Pick ${c.vendorName}`}
        </Button>
      )}
    </div>
  );
}
