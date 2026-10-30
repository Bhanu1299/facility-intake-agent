import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Asset, SensorReading } from '@fia/shared';
import { api } from '../api';
import { useApp } from '../context';
import { useAsync } from '../hooks';
import {
  Button,
  ErrorBanner,
  Field,
  inputBase,
  inputClass,
  PageHeader,
  Spinner,
} from '../components/ui';

const unitLabel = (u: string): string => (u === 'F' ? '°F' : 'mm/s');

function thresholdText(a: Asset): string {
  const s = a.sensor!;
  const u = unitLabel(s.unit);
  return `Normal ${s.normalMin} to ${s.normalMax}${u} · alert ${
    s.alertAbove !== null ? `above ${s.alertAbove}` : `below ${s.alertBelow}`
  }${u}`;
}

/** Simple SVG line of the last 48h with the alert threshold drawn as a dashed line. */
function Sparkline({ readings, asset }: { readings: SensorReading[]; asset: Asset }) {
  const s = asset.sensor!;
  const threshold = (s.alertAbove ?? s.alertBelow) as number;
  if (readings.length < 2) return <p className="text-sm text-slate-500">No recent readings.</p>;
  const values = readings.map((r) => r.value);
  const lo = Math.min(...values, threshold, s.normalMin);
  const hi = Math.max(...values, threshold, s.normalMax);
  const W = 600;
  const H = 120;
  const pad = 6;
  const x = (i: number) => pad + (i / (readings.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const d = readings
    .map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r.value).toFixed(1)}`)
    .join(' ');
  const last = readings[readings.length - 1]!;
  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-28 w-full"
        role="img"
        aria-label={`Last 48 hours, latest ${last.value}${unitLabel(s.unit)}`}
      >
        <rect
          x={0}
          y={y(s.normalMax)}
          width={W}
          height={Math.max(0, y(s.normalMin) - y(s.normalMax))}
          className="fill-emerald-50"
        />
        <line
          x1={0}
          x2={W}
          y1={y(threshold)}
          y2={y(threshold)}
          className="stroke-red-500"
          strokeDasharray="6 4"
          strokeWidth={1.5}
        />
        <path d={d} fill="none" className="stroke-teal-700" strokeWidth={2} />
        <circle cx={x(readings.length - 1)} cy={y(last.value)} r={4} className="fill-teal-700" />
      </svg>
      <figcaption className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-slate-500">
        <span>Last 48 hours · green = normal range · red dashed = alert threshold</span>
        <span className="font-medium text-slate-700">
          Latest: {last.value}
          {unitLabel(s.unit)}
        </span>
      </figcaption>
    </figure>
  );
}

export function SimulatorPage() {
  const { assets, sites, siteName, version } = useApp();
  const sensorAssets = useMemo(() => assets.filter((a) => a.sensor), [assets]);
  const [assetId, setAssetId] = useState('amherst-walkin-cooler');
  const asset = sensorAssets.find((a) => a.id === assetId) ?? sensorAssets[0];
  const [value, setValue] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const readings = useAsync(
    () => (asset ? api.sensorReadings(asset.id, 48) : Promise.resolve([])),
    [asset?.id, version, sent],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!asset?.sensor) return;
    const v = Number(value);
    if (value.trim() === '' || !Number.isFinite(v)) {
      setError('Enter a number.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.pushSensor({
        assetId: asset.id,
        metric: asset.sensor.metric,
        value: v,
        unit: asset.sensor.unit,
      });
      setSent(r.signalId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Sensor simulator"
        description={
          <>
            <span className="mr-2 inline-flex items-center rounded bg-amber-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-amber-900">
              Demo tool
            </span>
            Pretend to be a device: push one reading through the same pipeline a real sensor would
            use.
          </>
        }
      />

      {!asset && <Spinner />}
      {asset?.sensor && (
        <form onSubmit={submit} className="space-y-4 rounded-xl bg-white p-5 ring-1 ring-slate-200">
          <Field label="Asset">
            <select
              className={inputClass}
              value={asset.id}
              onChange={(e) => {
                setAssetId(e.target.value);
                setSent(null);
              }}
            >
              {sites.map((s) => (
                <optgroup key={s.id} label={s.shortName}>
                  {sensorAssets
                    .filter((a) => a.siteId === s.id)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.sensor!.metric})
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <p className="text-sm text-slate-600">
            {siteName(asset.siteId)} · {asset.location} · {thresholdText(asset)}
          </p>
          {readings.data ? <Sparkline readings={readings.data} asset={asset} /> : <Spinner />}
          <div className="flex flex-wrap items-end gap-3">
            <Field label={`Reading (${unitLabel(asset.sensor.unit)})`}>
              <input
                className={`${inputBase} w-40`}
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={String(asset.sensor.alertAbove ?? asset.sensor.alertBelow)}
              />
            </Field>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Pushing…' : 'Push reading'}
            </Button>
          </div>
          {error && <ErrorBanner message={error} />}
          {sent && (
            <p
              role="status"
              className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-900 ring-1 ring-emerald-200"
            >
              Reading accepted and being processed.{' '}
              <Link to="/" className="font-semibold underline">
                Open the Inbox
              </Link>{' '}
              to see the proposal.
            </p>
          )}
          <p className="text-xs text-slate-500">
            Try: Amherst walk-in cooler at 40.4 (below the alert, but trending up), Hertel freezer
            at 12, or Elmwood AC unit 2 at 9.4.
          </p>
        </form>
      )}

      <div className="mt-6 rounded-xl bg-white p-5 ring-1 ring-slate-200">
        <h2 className="font-semibold">QR request pages</h2>
        <p className="mt-1 text-sm text-slate-600">
          Each site's QR code opens one of these (no login):
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {sites.map((s) => (
            <li key={s.id}>
              <Link
                to={`/r/${s.id}`}
                className="block rounded-lg px-3 py-2 text-teal-800 ring-1 ring-slate-200 hover:bg-slate-50"
              >
                {s.shortName} <span className="text-sm text-slate-500">/r/{s.id}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
