import { Router } from 'express';
import { AutonomySetting, WorkOrderStatus } from '@fia/shared';
import { logActivity } from '../activity';
import { SettingsModel } from '../models/settings';
import { WorkOrderModel } from '../models/workOrder';

export function workOrdersRouter(): Router {
  const router = Router();

  router.get('/work-orders', async (req, res) => {
    const filter: Record<string, string> = {};
    const status = WorkOrderStatus.safeParse(req.query.status);
    if (status.success) filter.status = status.data;
    if (typeof req.query.siteId === 'string' && req.query.siteId) filter.siteId = req.query.siteId;
    res.json(await WorkOrderModel.find(filter).sort({ createdAt: -1 }).limit(300));
  });

  router.get('/work-orders/:id', async (req, res) => {
    const wo = await WorkOrderModel.findById(req.params.id);
    if (!wo) {
      res.status(404).json({ error: 'Work order not found' });
      return;
    }
    res.json(wo);
  });

  return router;
}

/** Auto (Phase 3) is a stretch goal and is not built; the API refuses it. */
export const AVAILABLE_MODES = ['advise', 'propose'] as const;

export async function getAutonomyMode(): Promise<AutonomySetting['mode']> {
  return (await SettingsModel.findById('global').lean())?.autonomyMode ?? 'propose';
}

export function settingsRouter(): Router {
  const router = Router();

  router.get('/settings/autonomy', async (_req, res) => {
    res.json({ mode: await getAutonomyMode(), available: AVAILABLE_MODES });
  });

  router.put('/settings/autonomy', async (req, res) => {
    const body = AutonomySetting.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'mode must be advise, propose or auto' });
      return;
    }
    if (!(AVAILABLE_MODES as readonly string[]).includes(body.data.mode)) {
      res.status(409).json({ error: 'Auto mode is not available in this prototype' });
      return;
    }
    const before = await getAutonomyMode();
    await SettingsModel.updateOne(
      { _id: 'global' },
      { autonomyMode: body.data.mode },
      { upsert: true },
    );
    if (before !== body.data.mode) {
      await logActivity({
        step: 'settings',
        actor: 'manager',
        inputSummary: `Autonomy ${before}`,
        outputSummary: `Autonomy ${body.data.mode}`,
        reason:
          body.data.mode === 'advise'
            ? 'Advise (Phase 1): analysis only, nothing can be approved'
            : 'Propose (Phase 2): manager approves every action',
      });
    }
    res.json({ mode: body.data.mode, available: AVAILABLE_MODES });
  });

  return router;
}
