import mongoose from 'mongoose';
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

// The seed is generated in code and already valid: skip per-document validation and hydration,
// and let the server apply each batch in any order.
const BULK = { ordered: false, lean: true } as const;

/**
 * Wipes every collection (including proposals, signals and the activity log) and reloads the
 * demo dataset anchored to `now`. Collections are dropped rather than emptied (deleting ~8k
 * sensor readings one by one is slow on a shared cluster), loaded in parallel, and indexed
 * after the data is in.
 */
export async function resetDemoData(
  autonomyMode: AutonomyMode,
  now: Date = new Date(),
): Promise<ResetSummary> {
  const started = Date.now();
  const data = generateSeedData(now);

  const collections = await mongoose.connection
    .db!.listCollections({}, { nameOnly: true })
    .toArray();
  await Promise.all(collections.map((c) => mongoose.connection.db!.dropCollection(c.name)));
  const wiped = Date.now();

  await Promise.all([
    SiteModel.insertMany(data.sites, BULK),
    AssetModel.insertMany(data.assets, BULK),
    VendorModel.insertMany(data.vendors, BULK),
    BudgetModel.insertMany(data.budgets, BULK),
    WorkOrderModel.insertMany(data.workOrders, BULK),
    SensorReadingModel.insertMany(data.sensorReadings, BULK),
    CounterModel.insertMany([{ _id: 'workOrder', seq: data.nextWorkOrderSeq }], BULK),
    SettingsModel.insertMany([{ _id: 'global', autonomyMode }], BULK),
  ]);
  const inserted = Date.now();

  // Dropping removed the indexes; rebuild them (this also creates the empty collections).
  await Promise.all(Object.values(mongoose.models).map((m) => m.createIndexes()));
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
