import { Router } from 'express';
import type { Budget } from '@fia/shared';
import {
  AssetModel,
  BudgetModel,
  SensorReadingModel,
  SiteModel,
  VendorModel,
} from '../models/catalog';

export function toBudget(doc: {
  _id: string;
  label: string;
  total: number;
  committed: number;
  spent: number;
}): Budget {
  return {
    siteId: doc._id,
    label: doc.label,
    total: doc.total,
    committed: doc.committed,
    spent: doc.spent,
    available: doc.total - doc.committed - doc.spent,
  };
}

export function catalogRouter(): Router {
  const router = Router();

  router.get('/sites', async (_req, res) => {
    res.json(await SiteModel.find().sort({ _id: 1 }));
  });

  router.get('/sites/:id', async (req, res) => {
    const site = await SiteModel.findById(req.params.id);
    if (!site) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }
    res.json(site);
  });

  router.get('/assets', async (req, res) => {
    const filter = typeof req.query.siteId === 'string' ? { siteId: req.query.siteId } : {};
    res.json(await AssetModel.find(filter).sort({ siteId: 1, _id: 1 }));
  });

  router.get('/vendors', async (_req, res) => {
    res.json(await VendorModel.find().sort({ name: 1 }));
  });

  // Recent readings for one sensor (simulator sparkline). Default 48h, max 14 days.
  router.get('/sensor-readings', async (req, res) => {
    const assetId = typeof req.query.assetId === 'string' ? req.query.assetId : '';
    if (!assetId) {
      res.status(400).json({ error: 'assetId is required' });
      return;
    }
    const hours = Math.min(Math.max(Number(req.query.hours) || 48, 1), 14 * 24);
    const since = new Date(Date.now() - hours * 3_600_000);
    const readings = await SensorReadingModel.find({ assetId, readingAt: { $gte: since } })
      .sort({ readingAt: 1 })
      .select({ _id: 0, assetId: 1, metric: 1, value: 1, unit: 1, readingAt: 1 })
      .lean();
    res.json(readings);
  });

  router.get('/budgets', async (_req, res) => {
    const budgets = await BudgetModel.find().sort({ _id: 1 }).lean();
    res.json(budgets.map(toBudget));
  });

  return router;
}
