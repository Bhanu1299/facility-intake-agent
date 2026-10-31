import { Router, type Response } from 'express';
import {
  ProposalStatus,
  RejectProposalInput,
  WorkOrderDraftPatch,
  compareForInbox,
} from '@fia/shared';
import { ActivityModel, ProposalModel } from '../models/pipeline';
import { ApprovalError, approveProposal, editProposal, rejectProposal } from '../workflow/approval';

function sendError(res: Response, err: unknown): void {
  if (err instanceof ApprovalError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

/** Re-wraps lean docs so the JSON shape matches the hydrated documents (id instead of _id). */
const toJson = <T extends { _id: string }>(doc: T): Omit<T, '_id'> & { id: string } => {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
};

export function proposalsRouter(): Router {
  const router = Router();

  router.get('/proposals', async (req, res) => {
    const status = ProposalStatus.safeParse(req.query.status);
    const filter = status.success ? { status: status.data } : {};
    const proposals = await ProposalModel.find(filter).sort({ createdAt: -1 }).limit(200);
    res.json(proposals.sort(compareForInbox));
  });

  router.get('/proposals/:id', async (req, res) => {
    const proposal = await ProposalModel.findById(req.params.id);
    if (!proposal) {
      res.status(404).json({ error: 'Proposal not found' });
      return;
    }
    res.json(proposal);
  });

  router.patch('/proposals/:id', async (req, res) => {
    const patch = WorkOrderDraftPatch.safeParse(req.body);
    if (!patch.success) {
      res.status(400).json({ error: 'Invalid edit', details: patch.error.issues });
      return;
    }
    try {
      res.json(toJson(await editProposal(req.params.id, patch.data)));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/proposals/:id/approve', async (req, res) => {
    const body: unknown = req.body ?? {};
    const patch = WorkOrderDraftPatch.safeParse(body);
    if (!patch.success) {
      res.status(400).json({ error: 'Invalid edit', details: patch.error.issues });
      return;
    }
    try {
      const result = await approveProposal(req.params.id, patch.data);
      res.status(result.created ? 201 : 200).json({
        proposal: toJson(result.proposal),
        workOrder: toJson(result.workOrder),
        created: result.created,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/proposals/:id/reject', async (req, res) => {
    const body = RejectProposalInput.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'A rejection reason is required', details: body.error.issues });
      return;
    }
    try {
      res.json(toJson(await rejectProposal(req.params.id, body.data.reason)));
    } catch (err) {
      sendError(res, err);
    }
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
    // A work order's log includes the proposals that created or merged into it.
    let query: Record<string, unknown> = filter;
    if (filter.workOrderId && !filter.proposalId) {
      const proposals = await ProposalModel.find({ workOrderId: filter.workOrderId }).lean();
      if (proposals.length) {
        query = {
          $or: [
            { workOrderId: filter.workOrderId },
            { proposalId: { $in: proposals.map((p) => p._id) } },
          ],
        };
      }
    }
    const scoped = Object.keys(filter).length > 0;
    const entries = await ActivityModel.find(query)
      .sort({ timestamp: scoped ? 1 : -1 })
      .limit(scoped ? 500 : 300);
    res.json(entries);
  });

  return router;
}
