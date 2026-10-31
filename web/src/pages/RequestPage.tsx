import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { GENERIC_SAFETY_NOTE, safetyGuidance } from '@fia/shared';
import { api, ApiError } from '../api';
import { useAsync } from '../hooks';

/** The page a QR code opens. No login: one text box and Send. */
export function RequestPage() {
  const { siteId = '' } = useParams();
  const site = useAsync(() => api.site(siteId), [siteId]);
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim().length < 3) {
      setError('Please describe the problem in a few words.');
      return;
    }
    setState('sending');
    setError(null);
    try {
      const res = await api.submitSignal({ type: 'request', siteId, text: text.trim() });
      setGuidance(safetyGuidance(res.safetyRuleId));
      setState('sent');
      setText('');
    } catch (err) {
      setState('idle');
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many requests from this device. Please try again later, or tell your manager directly.'
          : err instanceof Error
            ? err.message
            : 'Could not send. Please try again.',
      );
    }
  };

  return (
    <div className="min-h-dvh bg-slate-100 px-4 py-8 text-slate-900">
      <main className="mx-auto w-full max-w-md">
        <div className="mb-6 flex items-center gap-2 text-slate-600">
          <img src="/favicon.svg" alt="" className="h-6 w-6" />
          <span className="text-sm font-medium">Maintenance request</span>
        </div>

        {site.error && !site.data && (
          <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
            <h1 className="text-xl font-semibold">Location not found</h1>
            <p className="mt-2 text-slate-600">
              This QR code doesn't match a known location. Please let your manager know.
            </p>
          </div>
        )}

        {site.data && (
          <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-medium text-teal-800">{site.data.name}</p>
            {state === 'sent' ? (
              <div className="py-6 text-center" role="status">
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-2xl text-emerald-700">
                  ✓
                </div>
                <h1 className="mt-4 text-2xl font-semibold">Thanks, it's been sent</h1>
                {guidance && (
                  <div
                    role="alert"
                    className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-left text-lg font-semibold text-red-900 ring-1 ring-red-200"
                  >
                    {guidance}
                  </div>
                )}
                <p className="mt-2 text-lg text-slate-600">
                  The facilities manager will review it.{guidance ? '' : ` ${GENERIC_SAFETY_NOTE}`}
                </p>
                <button
                  type="button"
                  onClick={() => setState('idle')}
                  className="mt-6 w-full rounded-xl bg-slate-100 px-4 py-3 text-lg font-semibold text-slate-800 hover:bg-slate-200"
                >
                  Report something else
                </button>
              </div>
            ) : (
              <form onSubmit={submit} className="mt-2">
                <h1 className="text-2xl font-semibold">What needs fixing?</h1>
                <p className="mt-1 text-slate-600">
                  Say what's wrong and where. Any language is fine.
                </p>
                <label htmlFor="request-text" className="sr-only">
                  Describe the problem
                </label>
                <textarea
                  id="request-text"
                  rows={5}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={2000}
                  placeholder="e.g. The toilet in the women's restroom keeps running"
                  className="mt-4 block w-full rounded-xl border-0 px-4 py-3 text-lg ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-teal-600"
                />
                {error && (
                  <p role="alert" className="mt-3 text-base text-red-700">
                    {error}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={state === 'sending'}
                  className="mt-4 w-full rounded-xl bg-teal-700 px-4 py-3.5 text-lg font-semibold text-white hover:bg-teal-800 disabled:bg-teal-700/50"
                >
                  {state === 'sending' ? 'Sending…' : 'Send'}
                </button>
                <p className="mt-3 text-center text-sm text-slate-500">No login needed.</p>
              </form>
            )}
          </div>
        )}

        {!site.data && !site.error && <p className="text-slate-500">Loading…</p>}
      </main>
    </div>
  );
}
