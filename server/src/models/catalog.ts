import { Schema, model } from 'mongoose';
import {
  ASSET_TYPES,
  SENSOR_METRICS,
  SENSOR_UNITS,
  TRADES,
  type AssetType,
  type SensorSpec,
  type Trade,
} from '@fia/shared';
import { baseOptions } from './common';

export interface SiteDoc {
  _id: string;
  name: string;
  shortName: string;
  address: string;
  lat: number;
  lng: number;
  hours: string;
}

export const SiteModel = model<SiteDoc>(
  'Site',
  new Schema<SiteDoc>(
    {
      _id: { type: String, required: true },
      name: { type: String, required: true },
      shortName: { type: String, required: true },
      address: { type: String, required: true },
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
      hours: { type: String, required: true },
    },
    baseOptions<SiteDoc>('sites'),
  ),
);

export interface AssetDoc {
  _id: string;
  siteId: string;
  name: string;
  type: AssetType;
  trade: Trade;
  location: string;
  installYear: number;
  sensor: SensorSpec | null;
}

const SensorSpecSchema = new Schema<SensorSpec>(
  {
    metric: { type: String, enum: SENSOR_METRICS, required: true },
    unit: { type: String, enum: SENSOR_UNITS, required: true },
    normalMin: { type: Number, required: true },
    normalMax: { type: Number, required: true },
    alertAbove: { type: Number, default: null },
    alertBelow: { type: Number, default: null },
  },
  { _id: false },
);

export const AssetModel = model<AssetDoc>(
  'Asset',
  new Schema<AssetDoc>(
    {
      _id: { type: String, required: true },
      siteId: { type: String, required: true, index: true },
      name: { type: String, required: true },
      type: { type: String, enum: ASSET_TYPES, required: true },
      trade: { type: String, enum: TRADES, required: true },
      location: { type: String, required: true },
      installYear: { type: Number, required: true },
      sensor: { type: SensorSpecSchema, default: null },
    },
    baseOptions<AssetDoc>('assets'),
  ),
);

export interface VendorDoc {
  _id: string;
  name: string;
  trades: Trade[];
  lat: number;
  lng: number;
  rating: number;
  performanceScore: number;
  hourlyRate: number;
  email: string;
  phone: string;
  insuranceExpiry: Date;
  emergency24x7: boolean;
  windows: { days: number[]; start: string; end: string }[];
  bookedUntil: Date | null;
}

export const VendorModel = model<VendorDoc>(
  'Vendor',
  new Schema<VendorDoc>(
    {
      _id: { type: String, required: true },
      name: { type: String, required: true },
      trades: [{ type: String, enum: TRADES, required: true }],
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
      rating: { type: Number, required: true, min: 1, max: 5 },
      performanceScore: { type: Number, required: true, min: 0, max: 100 },
      hourlyRate: { type: Number, required: true },
      email: { type: String, required: true },
      phone: { type: String, required: true },
      insuranceExpiry: { type: Date, required: true },
      emergency24x7: { type: Boolean, required: true },
      windows: [
        new Schema(
          { days: [Number], start: String, end: String },
          { _id: false, versionKey: false },
        ),
      ],
      bookedUntil: { type: Date, default: null },
    },
    baseOptions<VendorDoc>('vendors'),
  ),
);

/** One budget per site. `_id` is the site id. Available is derived, never stored. */
export interface BudgetDoc {
  _id: string;
  label: string;
  total: number;
  committed: number;
  spent: number;
  /** Commitment keys already applied (e.g. "create:wo_x"), so approvals never double-commit. */
  appliedCommits: string[];
}

export const BudgetModel = model<BudgetDoc>(
  'Budget',
  new Schema<BudgetDoc>(
    {
      _id: { type: String, required: true },
      label: { type: String, required: true },
      total: { type: Number, required: true },
      committed: { type: Number, required: true, min: 0 },
      spent: { type: Number, required: true, min: 0 },
      appliedCommits: { type: [String], default: [] },
    },
    { collection: 'budgets', versionKey: false },
  ),
);

/** One reading, as callers see it. Stored inside per-asset, per-day buckets (below). */
export interface SensorReadingDoc {
  assetId: string;
  siteId: string;
  metric: SensorSpec['metric'];
  unit: SensorSpec['unit'];
  value: number;
  readingAt: Date;
}

/**
 * Bucket pattern: one document per asset per UTC day holding that day's readings. 14 days of
 * hourly readings for 25 sensors is ~375 documents instead of ~8,400, which keeps the demo
 * reset fast on a shared cluster.
 */
export interface SensorBucketDoc {
  assetId: string;
  siteId: string;
  metric: SensorSpec['metric'];
  unit: SensorSpec['unit'];
  /** UTC midnight of the day the readings belong to. */
  day: Date;
  readings: { at: Date; value: number }[];
}

const SensorBucketSchema = new Schema<SensorBucketDoc>(
  {
    assetId: { type: String, required: true },
    siteId: { type: String, required: true },
    metric: { type: String, enum: SENSOR_METRICS, required: true },
    unit: { type: String, enum: SENSOR_UNITS, required: true },
    day: { type: Date, required: true },
    readings: { type: [{ _id: false, at: Date, value: Number }], default: [] },
  },
  { collection: 'sensor_buckets', versionKey: false },
);
SensorBucketSchema.index({ assetId: 1, day: 1 }, { unique: true });

export const SensorBucketModel = model<SensorBucketDoc>('SensorBucket', SensorBucketSchema);

const DAY_MS = 86_400_000;
const utcDay = (d: Date): Date => new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);

/** Groups flat readings into day buckets (used by the seed). */
export function bucketReadings(readings: readonly SensorReadingDoc[]): SensorBucketDoc[] {
  const buckets = new Map<string, SensorBucketDoc>();
  for (const r of readings) {
    const day = utcDay(r.readingAt);
    const key = `${r.assetId}|${day.getTime()}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        assetId: r.assetId,
        siteId: r.siteId,
        metric: r.metric,
        unit: r.unit,
        day,
        readings: [],
      };
      buckets.set(key, b);
    }
    b.readings.push({ at: r.readingAt, value: r.value });
  }
  return [...buckets.values()];
}

/** Appends one reading to its day's bucket, creating the bucket if needed. */
export async function addSensorReading(r: SensorReadingDoc): Promise<void> {
  await SensorBucketModel.updateOne(
    { assetId: r.assetId, day: utcDay(r.readingAt) },
    {
      $push: { readings: { at: r.readingAt, value: r.value } },
      $setOnInsert: { siteId: r.siteId, metric: r.metric, unit: r.unit },
    },
    { upsert: true },
  );
}

/** Readings for one asset with `from <= readingAt <= to`, oldest first. */
export async function findSensorReadings(
  assetId: string,
  from: Date,
  to: Date = new Date(8.64e15),
): Promise<SensorReadingDoc[]> {
  const buckets = await SensorBucketModel.find({
    assetId,
    day: { $gte: utcDay(from), $lte: to },
  }).lean();
  return buckets
    .flatMap((b) =>
      b.readings.map((r) => ({
        assetId: b.assetId,
        siteId: b.siteId,
        metric: b.metric,
        unit: b.unit,
        value: r.value,
        readingAt: r.at,
      })),
    )
    .filter((r) => r.readingAt >= from && r.readingAt <= to)
    .sort((a, b) => a.readingAt.getTime() - b.readingAt.getTime());
}
