import type { Budget } from '@fia/shared';
import { money } from '../format';

/**
 * Site budget as a stacked bar (Spent | Committed | Available) with this proposal's NTE drawn
 * inside Available. If NTE exceeds Available, the overflow is shown in red.
 */
export function BudgetBar({ budget, nte }: { budget: Budget; nte: number }) {
  const total = Math.max(budget.total, 1);
  const pct = (n: number): string => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;
  const available = Math.max(0, budget.available);
  const nteInside = Math.min(nte, available);
  const over = Math.max(0, nte - available);

  return (
    <div>
      <div
        className="relative flex h-4 w-full overflow-hidden rounded-full bg-emerald-100"
        role="img"
        aria-label={`Spent ${money(budget.spent)}, committed ${money(budget.committed)}, available ${money(budget.available)}, this NTE ${money(nte)}`}
      >
        <div className="h-full bg-slate-500" style={{ width: pct(budget.spent) }} />
        <div className="h-full bg-slate-300" style={{ width: pct(budget.committed) }} />
        <div
          className="h-full bg-teal-600"
          style={{ width: pct(nteInside) }}
          title={`This NTE: ${money(nte)}`}
        />
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Stat label="Total" value={money(budget.total)} />
        <Stat label="Spent" value={money(budget.spent)} swatch="bg-slate-500" />
        <Stat label="Committed" value={money(budget.committed)} swatch="bg-slate-300" />
        <Stat
          label="Available"
          value={money(budget.available)}
          swatch="bg-emerald-100 ring-1 ring-emerald-300"
        />
      </dl>
      <p className="mt-2 text-sm text-slate-700">
        <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-teal-600 align-middle" />
        This NTE <strong>{money(nte)}</strong> of {money(budget.available)} available
        {over > 0 && <span className="ml-1 font-semibold text-red-700">({money(over)} over)</span>}
      </p>
    </div>
  );
}

function Stat({ label, value, swatch }: { label: string; value: string; swatch?: string }) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs text-slate-500">
        {swatch && <span className={`inline-block h-2.5 w-2.5 rounded-sm ${swatch}`} />}
        {label}
      </dt>
      <dd className="font-medium tabular-nums text-slate-900">{value}</dd>
    </div>
  );
}
