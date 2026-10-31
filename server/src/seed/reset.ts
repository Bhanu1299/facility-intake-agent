import mongoose, { type Model } from 'mongoose';
import type { Document } from 'mongodb';
import type { AutonomyMode } from '@fia/shared';
import {
  AssetModel,
  BudgetModel,
  bucketReadings,
  SensorBucketModel,
  SiteModel,
  VendorModel,
} from '../models/catalog';
import { CounterModel, WorkOrderModel } from '../models/workOrder';
import { SettingsModel } from '../models/settings';
import { generateSeedData } from './generate';

export interface ResetSummary {
  sites: number;
  assets: number;
  vendors: number;
  workOrders: number;
  sensorReadings: number;
  /** Phase timings, so a slow reset on the hosted database can be diagnosed. */
  timingsMs: { wipe: number; insert: number; total: number };
}

/** Readings were stored one per document before the bucket pattern; drop that collection. */
const LEGACY_READINGS_COLLECTION = 'sensor_readings';

/**
 * Bulk load straight through the driver: the seed is generated in code and already valid, so it
 * skips per-document validation, and `ordered: false` lets the server apply it in any order.
 * The driver's types assume ObjectId ids; ours are strings.
 */
const load = (model: Pick<Model<unknown>, 'collection'>, docs: readonly object[]) =>
  model.collection.insertMany(docs as unknown as Document[], { ordered: false });

/**
 * Empties every collection (including proposals, signals and the activity log) and reloads the
 * demo dataset anchored to `now`. Every collection is small (sensor readings are bucketed per
 * asset per day), so collections are emptied in place and keep their indexes, and all of them
 * load in parallel.
 */
export async function resetDemoData(
  autonomyMode: AutonomyMode,
  now: Date = new Date(),
): Promise<ResetSummary> {
  const started = Date.now();
  const data = generateSeedData(now);
  // Creates collections and indexes on a fresh database; a no-op after the first call.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  await Promise.all([
    ...Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})),
    mongoose.connection.db!.dropCollection(LEGACY_READINGS_COLLECTION).catch(() => undefined),
  ]);
  const wiped = Date.now();

  await Promise.all([
    load(SiteModel, data.sites),
    load(AssetModel, data.assets),
    load(VendorModel, data.vendors),
    load(BudgetModel, data.budgets),
    load(WorkOrderModel, data.workOrders),
    load(SensorBucketModel, bucketReadings(data.sensorReadings)),
    load(CounterModel, [{ _id: 'workOrder', seq: data.nextWorkOrderSeq }]),
    load(SettingsModel, [{ _id: 'global', autonomyMode }]),
  ]);
  const inserted = Date.now();

  return {
    sites: data.sites.length,
    assets: data.assets.length,
    vendors: data.vendors.length,
    workOrders: data.workOrders.length,
    sensorReadings: data.sensorReadings.length,
    timingsMs: { wipe: wiped - started, insert: inserted - wiped, total: inserted - started },
  };
}

/** Seeds only if the database is empty (first boot of a fresh deploy or in-memory dev DB). */
export async function ensureSeeded(autonomyMode: AutonomyMode): Promise<boolean> {
  if ((await SiteModel.estimatedDocumentCount()) > 0) return false;
  await resetDemoData(autonomyMode);
  return true;
}
