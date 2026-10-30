import { useEffect, useState } from 'react';
import type { HealthResponse } from '@fia/shared';
import { getHealth } from '../api';

type State = { kind: 'loading' } | { kind: 'ok'; health: HealthResponse } | { kind: 'error' };

/** Small connection indicator. Free hosts may sleep, so the first check can take ~1 minute. */
export function ApiStatus() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((health) => !cancelled && setState({ kind: 'ok', health }))
      .catch(() => !cancelled && setState({ kind: 'error' }));
    return () => {
      cancelled = true;
    };
  }, []);

  const [dot, label] =
    state.kind === 'loading'
      ? ['bg-amber-400', 'Connecting… (server may be waking up)']
      : state.kind === 'error'
        ? ['bg-red-500', 'API unreachable']
        : state.health.db === 'connected'
          ? ['bg-emerald-500', 'API connected']
          : ['bg-amber-400', `API up, database ${state.health.db}`];

  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-600">
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}
