import mongoose, { type Model } from 'mongoose';
import type { Document } from 'mongodb';
import type { AutonomyMode } from '@fia/shared';
import {
  AssetModel,
  BudgetModel,
  SensorReadingModel,
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
  timingsMs: { wipe: number; insert: number; indexes: number; total: number };
}

// The seed is generated in code and already valid, so it goes straight to the driver: no
// per-document validation, batches applied in any order, and acknowledged by the primary alone
// (waiting for a replica majority roughly doubles the time on a shared cluster, and this is
// throwaway demo data).
const FAST = { writeConcern: { w: 1 } } as const;
const BULK = { ...FAST, ordered: false } as const;
/** Sensor readings go in as parallel chunks so the server can apply them concurrently. */
const READING_CHUNK = 1000;

/** Driver insertMany for a model. The driver's types assume ObjectId ids; ours are strings. */
const load = (model: Pick<Model<unknown>, 'collection'>, docs: readonly object[]) =>
  model.collection.insertMany(docs as unknown as Document[], BULK);

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/**
 * Wipes every collection (including proposals, signals and the activity log) and reloads the
 * demo dataset anchored to `now`. Tuned for a shared hosted cluster, where per-document deletes
 * and index builds are the slow parts:
 *  - sensor readings (~8k docs) are dropped, bulk-loaded in parallel chunks, then get their one
 *    index rebuilt;
 *  - every other collection is small, so it is emptied in place and keeps its indexes.
 */
export async function resetDemoData(
  autonomyMode: AutonomyMode,
  now: Date = new Date(),
): Promise<ResetSummary> {
  const started = Date.now();
  const data = generateSeedData(now);
  // Creates collections and indexes on a fresh database; a no-op after the first call.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const readings = SensorReadingModel.collection.collectionName;
  await Promise.all(
    Object.values(mongoose.connection.collections).map((c) =>
      c.collectionName === readings
        ? c.drop().catch(() => undefined) // already gone
        : c.deleteMany({}, FAST),
    ),
  );
  const wiped = Date.now();

  await Promise.all([
    load(SiteModel, data.sites),
    load(AssetModel, data.assets),
    load(VendorModel, data.vendors),
    load(BudgetModel, data.budgets),
    load(WorkOrderModel, data.workOrders),
    load(CounterModel, [{ _id: 'workOrder', seq: data.nextWorkOrderSeq }]),
    load(SettingsModel, [{ _id: 'global', autonomyMode }]),
    ...chunks(data.sensorReadings, READING_CHUNK).map((batch) => load(SensorReadingModel, batch)),
  ]);
  const inserted = Date.now();

  // The drop removed the readings index; build it once over the loaded data.
  await SensorReadingModel.createIndexes();
  const indexed = Date.now();

  return {
    sites: data.sites.length,
    assets: data.assets.length,
    vendors: data.vendors.length,
    workOrders: data.workOrders.length,
    sensorReadings: data.sensorReadings.length,
    timingsMs: {
      wipe: wiped - started,
      insert: inserted - wiped,
      indexes: indexed - inserted,
      total: indexed - started,
    },
  };
}

/** Seeds only if the database is empty (first boot of a fresh deploy or in-memory dev DB). */
export async function ensureSeeded(autonomyMode: AutonomyMode): Promise<boolean> {
  if ((await SiteModel.estimatedDocumentCount()) > 0) return false;
  await resetDemoData(autonomyMode);
  return true;
}
