import type { CallMode, Urgency } from '@fia/shared';
import { defaultCallMode } from '@fia/shared';

export type PlanChoice = CallMode | 'email';

export interface CallPlanState {
  choice: PlanChoice;
  autoBackup: boolean;
}

export const defaultPlan = (urgency: Urgency): CallPlanState => ({
  choice: defaultCallMode(urgency),
  autoBackup: urgency === 'emergency',
});

const OPTIONS: { value: PlanChoice; title: string; body: string }[] = [
  {
    value: 'quote',
    title: 'Collect quotes',
    body: 'Call the top 2 vendors for a rough estimate and arrival time. You compare and pick.',
  },
  {
    value: 'book',
    title: 'Call to book',
    body: 'Call vendor #1 now to book the job and an arrival time.',
  },
  {
    value: 'email',
    title: 'Email only',
    body: 'Dispatch by email draft to the chosen vendor. No calls.',
  },
];

/** Admin-only choice of how the agent contacts vendors after approval. */
export function CallPlanPicker({
  urgency,
  value,
  onChange,
}: {
  urgency: Urgency;
  value: CallPlanState;
  onChange: (v: CallPlanState) => void;
}) {
  const suggested = defaultCallMode(urgency);
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        After approval
      </legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {OPTIONS.map((o) => (
          <label
            key={o.value}
            className={`flex cursor-pointer gap-2 rounded-lg px-3 py-2 text-sm ring-1 ${
              value.choice === o.value ? 'bg-teal-50 ring-teal-400' : 'ring-slate-200'
            }`}
          >
            <input
              type="radio"
              name="call-plan"
              className="mt-1"
              checked={value.choice === o.value}
              onChange={() => onChange({ ...value, choice: o.value })}
            />
            <span>
              <span className="font-medium">
                {o.title}
                {o.value === suggested && <span className="text-slate-500"> (default)</span>}
              </span>
              <span className="block text-xs text-slate-600">{o.body}</span>
            </span>
          </label>
        ))}
      </div>
      {value.choice === 'book' && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.autoBackup}
            onChange={(e) => onChange({ ...value, autoBackup: e.target.checked })}
          />
          If no answer or declined, auto-call backup vendors
        </label>
      )}
    </fieldset>
  );
}
