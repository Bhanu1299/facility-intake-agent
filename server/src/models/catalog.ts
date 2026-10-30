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

export interface SensorReadingDoc {
  assetId: string;
  siteId: string;
  metric: SensorSpec['metric'];
  unit: SensorSpec['unit'];
  value: number;
  readingAt: Date;
}

const SensorReadingSchema = new Schema<SensorReadingDoc>(
  {
    assetId: { type: String, required: true },
    siteId: { type: String, required: true },
    metric: { type: String, enum: SENSOR_METRICS, required: true },
    unit: { type: String, enum: SENSOR_UNITS, required: true },
    value: { type: Number, required: true },
    readingAt: { type: Date, required: true },
  },
  { collection: 'sensor_readings', versionKey: false },
);
SensorReadingSchema.index({ assetId: 1, readingAt: -1 });

export const SensorReadingModel = model<SensorReadingDoc>('SensorReading', SensorReadingSchema);
