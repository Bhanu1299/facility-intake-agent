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
}

/**
 * Wipes every collection (including proposals, signals and the activity log) and reloads the
 * demo dataset anchored to `now`.
 */
export async function resetDemoData(
  autonomyMode: AutonomyMode,
  now: Date = new Date(),
): Promise<ResetSummary> {
  const data = generateSeedData(now);

  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  // Make sure indexes exist (e.g. after a fresh database).
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  await SiteModel.insertMany(data.sites);
  await AssetModel.insertMany(data.assets);
  await VendorModel.insertMany(data.vendors);
  await BudgetModel.insertMany(data.budgets);
  await WorkOrderModel.insertMany(data.workOrders);
  await SensorReadingModel.insertMany(data.sensorReadings, { lean: true });
  await CounterModel.create({ _id: 'workOrder', seq: data.nextWorkOrderSeq });
  await SettingsModel.create({ _id: 'global', autonomyMode });

  return {
    sites: data.sites.length,
    assets: data.assets.length,
    vendors: data.vendors.length,
    workOrders: data.workOrders.length,
    sensorReadings: data.sensorReadings.length,
  };
}

/** Seeds only if the database is empty (first boot of a fresh deploy or in-memory dev DB). */
export async function ensureSeeded(autonomyMode: AutonomyMode): Promise<boolean> {
  if ((await SiteModel.estimatedDocumentCount()) > 0) return false;
  await resetDemoData(autonomyMode);
  return true;
}
