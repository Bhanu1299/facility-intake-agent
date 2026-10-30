import { Router } from 'express';
import { ProposalStatus } from '@fia/shared';
import { ActivityModel, ProposalModel } from '../models/pipeline';

export function proposalsRouter(): Router {
  const router = Router();

  router.get('/proposals', async (req, res) => {
    const status = ProposalStatus.safeParse(req.query.status);
    const filter = status.success ? { status: status.data } : {};
    res.json(await ProposalModel.find(filter).sort({ createdAt: -1 }).limit(200));
  });

  router.get('/proposals/:id', async (req, res) => {
    const proposal = await ProposalModel.findById(req.params.id);
    if (!proposal) {
      res.status(404).json({ error: 'Proposal not found' });
      return;
    }
    res.json(proposal);
  });

  return router;
}

export function activityRouter(): Router {
  const router = Router();

  router.get('/activity', async (req, res) => {
    const filter: Record<string, string> = {};
    for (const key of ['proposalId', 'workOrderId', 'signalId'] as const) {
      const v = req.query[key];
      if (typeof v === 'string' && v) filter[key] = v;
    }
    // A work order's log includes the proposal that created it.
    let query: Record<string, unknown> = filter;
    if (filter.workOrderId && !filter.proposalId) {
      const p = await ProposalModel.findOne({ workOrderId: filter.workOrderId }).lean();
      if (p) query = { $or: [{ workOrderId: filter.workOrderId }, { proposalId: p._id }] };
    }
    const scoped = Object.keys(filter).length > 0;
    const entries = await ActivityModel.find(query)
      .sort({ timestamp: scoped ? 1 : -1 })
      .limit(scoped ? 500 : 300);
    res.json(entries);
  });

  return router;
}
