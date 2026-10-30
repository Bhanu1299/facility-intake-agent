import { z } from 'zod';
import { SensorMetric, SensorUnit, Trade } from './enums';

export const Site = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string(),
  address: z.string(),
  lat: z.number(),
  lng: z.number(),
  hours: z.string(),
});
export type Site = z.infer<typeof Site>;

export const ASSET_TYPES = [
  'walkin_cooler',
  'walkin_freezer',
  'rooftop_ac',
  'fryer',
  'dishwasher',
  'ice_machine',
  'water_heater',
  'restroom',
  'front_door',
] as const;
export const AssetType = z.enum(ASSET_TYPES);
export type AssetType = z.infer<typeof AssetType>;

/** Normal band and alert threshold for an asset's sensor. One of alertAbove/alertBelow is set. */
export const SensorSpec = z.object({
  metric: SensorMetric,
  unit: SensorUnit,
  normalMin: z.number(),
  normalMax: z.number(),
  alertAbove: z.number().nullable(),
  alertBelow: z.number().nullable(),
});
export type SensorSpec = z.infer<typeof SensorSpec>;

export const Asset = z.object({
  id: z.string(),
  siteId: z.string(),
  name: z.string(),
  type: AssetType,
  trade: Trade,
  location: z.string(),
  installYear: z.number().int(),
  sensor: SensorSpec.nullable(),
});
export type Asset = z.infer<typeof Asset>;

export const AvailabilityWindow = z.object({
  /** 0 = Sunday ... 6 = Saturday. */
  days: z.array(z.number().int().min(0).max(6)),
  /** Local site time, "HH:MM". */
  start: z.string(),
  end: z.string(),
});
export type AvailabilityWindow = z.infer<typeof AvailabilityWindow>;

export const Vendor = z.object({
  id: z.string(),
  name: z.string(),
  trades: z.array(Trade),
  lat: z.number(),
  lng: z.number(),
  rating: z.number().min(1).max(5),
  performanceScore: z.number().min(0).max(100),
  hourlyRate: z.number().positive(),
  email: z.string(),
  phone: z.string(),
  insuranceExpiry: z.string(),
  emergency24x7: z.boolean(),
  windows: z.array(AvailabilityWindow),
  /** Fully booked until this time (null = open). */
  bookedUntil: z.string().nullable(),
});
export type Vendor = z.infer<typeof Vendor>;

/** Budget states as used in the FM portal: Available = Total - Committed - Spent. */
export const Budget = z.object({
  siteId: z.string(),
  label: z.string(),
  total: z.number(),
  committed: z.number(),
  spent: z.number(),
  available: z.number(),
});
export type Budget = z.infer<typeof Budget>;

export const SensorReading = z.object({
  assetId: z.string(),
  metric: SensorMetric,
  value: z.number(),
  unit: SensorUnit,
  readingAt: z.string(),
});
export type SensorReading = z.infer<typeof SensorReading>;
