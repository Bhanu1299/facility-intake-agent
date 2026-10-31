import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAdminKey, writeAdminKey } from '../adminKey';
import { useAsync } from '../hooks';
import { Button, ErrorBanner, Field, inputClass, PageHeader, Tag } from '../components/ui';

export function SettingsPage() {
  const adminKey = useAdminKey();
  const config = useAsync(() => api.callConfig(), []);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const key = draft.trim();
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      await api.verifyAdminKey(key);
      writeAdminKey(key);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check the key');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-xl">
      <PageHeader title="Settings" />
      <section className="rounded-xl bg-white p-5 ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-900">Vendor call admin key</h2>
          {config.data && (
            <Tag tone={config.data.enabled ? 'teal' : 'slate'}>
              Calls {config.data.enabled ? 'enabled on the server' : 'disabled on the server'}
            </Tag>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-600">
          With the key, dispatched work orders show a “Call vendor” button. The key stays in this
          browser tab only (session storage). Calls only ever go to the demo phone number, at most{' '}
          {config.data?.maxPerHour ?? 3} per hour.
        </p>
        {adminKey ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Tag tone="teal">Admin key saved for this tab</Tag>
            <Button variant="secondary" onClick={() => writeAdminKey(null)}>
              Forget key
            </Button>
          </div>
        ) : (
          <form onSubmit={save} className="mt-4 grid gap-3">
            <Field label="Admin key">
              <input
                type="password"
                autoComplete="off"
                className={inputClass}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </Field>
            {error && <ErrorBanner message={error} />}
            <div>
              <Button type="submit" variant="primary" disabled={busy || !draft.trim()}>
                {busy ? 'Checking…' : 'Save key'}
              </Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
