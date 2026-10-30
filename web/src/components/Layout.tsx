import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import type { AutonomyMode } from '@fia/shared';
import { useApp } from '../context';
import { ApiStatus } from './ApiStatus';

const NAV = [
  { to: '/', label: 'Inbox' },
  { to: '/work-orders', label: 'Work Orders' },
  { to: '/activity', label: 'Activity Log' },
  { to: '/simulator', label: 'Sensor simulator' },
];

const MODES: {
  mode: AutonomyMode;
  label: string;
  phase: string;
  help: string;
  enabled: boolean;
}[] = [
  {
    mode: 'advise',
    label: 'Advise',
    phase: 'Phase 1',
    help: 'Analysis only. Nothing can be approved.',
    enabled: true,
  },
  {
    mode: 'propose',
    label: 'Propose',
    phase: 'Phase 2',
    help: 'Drafts work orders. A manager approves every action.',
    enabled: true,
  },
  {
    mode: 'auto',
    label: 'Auto',
    phase: 'Phase 3',
    help: 'Not built in this prototype.',
    enabled: false,
  },
];

function AutonomyDial() {
  const { mode, setMode } = useApp();
  const [error, setError] = useState<string | null>(null);
  const current = MODES.find((m) => m.mode === mode);

  return (
    <div className="flex flex-col items-start gap-1">
      <div
        role="radiogroup"
        aria-label="Autonomy"
        className="inline-flex rounded-lg bg-slate-100 p-0.5 ring-1 ring-inset ring-slate-200"
      >
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            role="radio"
            aria-checked={mode === m.mode}
            disabled={!m.enabled}
            title={`${m.phase}: ${m.help}`}
            onClick={() => {
              setError(null);
              setMode(m.mode).catch((e: unknown) =>
                setError(e instanceof Error ? e.message : 'Failed'),
              );
            }}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === m.mode
                ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
                : m.enabled
                  ? 'text-slate-600 hover:text-slate-900'
                  : 'cursor-not-allowed text-slate-400'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <span className="text-xs text-slate-500">
        {error ?? (current ? `${current.phase}: ${current.help}` : 'Loading autonomy…')}
      </span>
    </div>
  );
}

/** Two-step reset (no browser confirm dialog). */
function ResetButton() {
  const { resetDemo } = useApp();
  const [state, setState] = useState<'idle' | 'confirm' | 'busy' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    if (state !== 'confirm' && state !== 'done') return;
    const id = setTimeout(() => setState('idle'), state === 'confirm' ? 5000 : 2500);
    return () => clearTimeout(id);
  }, [state]);

  const onClick = () => {
    if (state === 'idle' || state === 'done' || state === 'error') {
      setState('confirm');
      return;
    }
    if (state !== 'confirm') return;
    setState('busy');
    resetDemo()
      .then(() => setState('done'))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Reset failed');
        setState('error');
      });
  };

  const label = {
    idle: 'Reset demo',
    confirm: 'Click again to reset',
    busy: 'Resetting…',
    done: 'Demo reset ✓',
    error: 'Reset failed',
  }[state];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === 'busy'}
      title={
        state === 'error'
          ? error
          : 'Reload the fake demo data (clears proposals and new work orders)'
      }
      className={`rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset transition-colors ${
        state === 'confirm'
          ? 'bg-amber-50 text-amber-900 ring-amber-300'
          : state === 'error'
            ? 'bg-red-50 text-red-800 ring-red-300'
            : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );
}

export function Layout() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span className="text-lg font-semibold tracking-tight">Intake Agent</span>
          </div>
          <nav className="order-last -mx-1 flex w-full flex-wrap gap-1 px-1 md:order-none md:w-auto md:flex-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${
                    isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex flex-wrap items-center gap-4">
            <AutonomyDial />
            <ResetButton />
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-4 pb-2">
          <ApiStatus />
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-slate-500">
        Prototype with fake data (Harbor &amp; Hearth Kitchen is fictional). Dispatch emails are
        drafted, never sent.
      </footer>
    </div>
  );
}
