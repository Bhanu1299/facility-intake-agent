import {
  URGENCY_RANK,
  WorkOrderDraft,
  formatEstimate,
  type Trade,
  type WorkOrderDraftPatch,
} from '@fia/shared';
import { logActivity } from '../activity';
import { AssetModel, BudgetModel, SiteModel, VendorModel } from '../models/catalog';
import { ProposalModel, type ProposalDoc } from '../models/pipeline';
import { SettingsModel } from '../models/settings';
import { nextWorkOrderNumber, WorkOrderModel, type WorkOrderDoc } from '../models/workOrder';
import { buildDispatchEmail } from './dispatchEmail';
import { assertTransition } from './lifecycle';

/** Business-rule failure; the route maps `status` to the HTTP code. */
export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

const APPROVABLE = ['proposed', 'advisory'] as const;

async function loadProposal(id: string): Promise<ProposalDoc> {
  const p = await ProposalModel.findById(id).lean();
  if (!p) throw new ApprovalError('Proposal not found', 404);
  return p;
}

/** Field-level checks the zod schema can't do: references must exist and fit the site. */
async function validateDraftRefs(draft: WorkOrderDraft): Promise<void> {
  if (draft.assetId) {
    const asset = await AssetModel.findById(draft.assetId).lean();
    if (!asset || asset.siteId !== draft.siteId) {
      throw new ApprovalError(`Asset ${draft.assetId} is not at site ${draft.siteId}`, 400);
    }
  }
  if (draft.vendorId) {
    const vendor = await VendorModel.findById(draft.vendorId).lean();
    if (!vendor) throw new ApprovalError(`Unknown vendor ${draft.vendorId}`, 400);
    if (draft.trade !== 'unknown' && !vendor.trades.includes(draft.trade)) {
      throw new ApprovalError(`${vendor.name} does not do ${draft.trade} work`, 400);
    }
  }
}

/** Quotes proposals: the manager picks one of the vendors who quoted. */
function assertQuoted(p: ProposalDoc, vendorId: string): void {
  if (!p.quotes?.cards.some((c) => c.vendorId === vendorId)) {
    throw new ApprovalError('Pick one of the vendors who quoted', 400);
  }
}

/** A vendor who declined a work order on the dispatch call is never assigned it again. */
async function assertNotDeclined(p: ProposalDoc, vendorId: string): Promise<void> {
  const targetId = p.reassign?.workOrderId ?? p.quotes?.workOrderId;
  const wo = targetId ? await WorkOrderModel.findById(targetId).lean() : null;
  if (wo?.declinedVendorIds?.includes(vendorId)) {
    const name = (await VendorModel.findById(vendorId).lean())?.name ?? vendorId;
    throw new ApprovalError(`${name} already declined this job; choose another vendor`, 409);
  }
}

function changedFields(before: WorkOrderDraft, after: WorkOrderDraft): (keyof WorkOrderDraft)[] {
  return (Object.keys(after) as (keyof WorkOrderDraft)[]).filter((k) => before[k] !== after[k]);
}

/** PATCH /api/proposals/:id — manager edits before approving. */
export async function editProposal(id: string, patch: WorkOrderDraftPatch): Promise<ProposalDoc> {
  const p = await loadProposal(id);
  if (!APPROVABLE.includes(p.status as (typeof APPROVABLE)[number])) {
    throw new ApprovalError(`Proposal is ${p.status}; it can no longer be edited`, 409);
  }
  if (p.action === 'reassign' || p.action === 'quotes') {
    if (Object.keys(patch).some((k) => k !== 'vendorId')) {
      throw new ApprovalError(
        p.action === 'quotes'
          ? 'Picking a quote only sets the vendor'
          : 'A reassignment only changes the vendor',
        400,
      );
    }
    if (patch.vendorId) await assertNotDeclined(p, patch.vendorId);
    if (patch.vendorId && p.action === 'quotes') assertQuoted(p, patch.vendorId);
  }
  const draft = WorkOrderDraft.parse({ ...p.draft, ...patch });
  await validateDraftRefs(draft);
  const changed = changedFields(p.draft, draft);
  const updated = await ProposalModel.findOneAndUpdate(
    { _id: id, status: p.status },
    { draft, updatedAt: new Date() },
    { new: true },
  ).lean();
  if (!updated) throw new ApprovalError('Proposal changed while editing; reload and retry', 409);
  if (changed.length) {
    await logActivity({
      step: 'edit',
      actor: 'manager',
      signalId: p.signalId,
      proposalId: id,
      inputSummary: changed.map((k) => `${k}: ${JSON.stringify(p.draft[k])}`).join(', '),
      outputSummary: changed.map((k) => `${k}: ${JSON.stringify(draft[k])}`).join(', '),
    });
  }
  return updated;
}

/** Atomically commits `amount` to a site's budget once per `key`, never past Available. */
async function commitBudget(
  siteId: string,
  key: string,
  amount: number,
): Promise<'applied' | 'already' | 'insufficient'> {
  if (amount <= 0) return 'applied';
  const res = await BudgetModel.updateOne(
    {
      _id: siteId,
      appliedCommits: { $ne: key },
      $expr: { $gte: [{ $subtract: ['$total', { $add: ['$committed', '$spent'] }] }, amount] },
    },
    { $inc: { committed: amount }, $push: { appliedCommits: key } },
  );
  if (res.modifiedCount === 1) return 'applied';
  const budget = await BudgetModel.findById(siteId).lean();
  return budget?.appliedCommits.includes(key) ? 'already' : 'insufficient';
}

async function releaseClaim(id: string, previousStatus: string): Promise<void> {
  await ProposalModel.updateOne(
    { _id: id, status: 'approved' },
    { status: previousStatus, workOrderId: null, updatedAt: new Date() },
  );
}

export interface ApprovalResult {
  proposal: ProposalDoc;
  workOrder: WorkOrderDoc;
  /** False when this call found the proposal already approved (idempotent replay). */
  created: boolean;
}

/** Result of an approval that another call already made (waits briefly if it is mid-flight). */
async function existingResult(id: string): Promise<ApprovalResult> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const proposal = await loadProposal(id);
    if (proposal.status !== 'approved') {
      throw new ApprovalError(`Proposal is ${proposal.status}`, 409);
    }
    const workOrder = proposal.workOrderId
      ? await WorkOrderModel.findById(proposal.workOrderId).lean()
      : null;
    // Quote mode leaves a new work order at approved with no vendor while quotes come in.
    if (
      workOrder &&
      (workOrder.status !== 'approved' || proposal.action === 'merge' || !workOrder.vendorId)
    ) {
      return { proposal, workOrder, created: false };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new ApprovalError('Approval is still in progress; retry shortly', 409);
}

/**
 * POST /api/proposals/:id/approve. Idempotent: a second (or concurrent) approve returns the same
 * work order and never commits budget twice.
 */
export interface ApproveOptions {
  /**
   * False for Quote mode: create the work order (NTE committed) but don't dispatch it; the call
   * chain collects quotes first. Default true.
   */
  dispatch?: boolean;
}

export async function approveProposal(
  id: string,
  patch: WorkOrderDraftPatch | undefined,
  opts: ApproveOptions = {},
): Promise<ApprovalResult> {
  const settings = await SettingsModel.findById('global').lean();
  if (settings?.autonomyMode === 'advise') {
    throw new ApprovalError(
      'Advise mode is on: proposals are analysis only and cannot be approved',
      409,
    );
  }

  let p = await loadProposal(id);
  if (p.status === 'approved') return existingResult(id);
  if (p.status === 'rejected') throw new ApprovalError('Proposal was rejected', 409);
  if (patch && Object.keys(patch).length) p = await editProposal(id, patch);

  const draft = WorkOrderDraft.parse(p.draft);
  if (draft.trade === 'unknown') {
    throw new ApprovalError('Set the trade before approving (the agent could not tell)', 409);
  }
  if (!draft.vendorId) {
    throw new ApprovalError(
      p.action === 'quotes' ? 'Pick one of the quotes first' : 'Choose a vendor before approving',
      409,
    );
  }
  await validateDraftRefs(draft);
  const trade: Trade = draft.trade;

  const vendor = await VendorModel.findById(draft.vendorId).lean();
  if (!vendor) throw new ApprovalError('Vendor not found', 400);
  if (vendor.insuranceExpiry <= new Date()) {
    throw new ApprovalError(`${vendor.name}'s insurance has expired; choose another vendor`, 409);
  }
  const site = await SiteModel.findById(draft.siteId).lean();
  if (!site) throw new ApprovalError('Site not found', 400);

  const targetId =
    p.action === 'merge'
      ? p.duplicate?.workOrderId
      : p.action === 'reassign'
        ? p.reassign?.workOrderId
        : p.action === 'quotes'
          ? p.quotes?.workOrderId
          : undefined;
  const target = targetId ? await WorkOrderModel.findById(targetId).lean() : null;
  if (p.action !== 'create' && !target) {
    throw new ApprovalError(
      `The work order to ${p.action === 'merge' ? 'merge into' : 'update'} no longer exists`,
      409,
    );
  }
  if (p.action === 'reassign' || p.action === 'quotes') await assertNotDeclined(p, vendor._id);
  if (p.action === 'quotes') assertQuoted(p, vendor._id);
  const workOrderId = target?._id ?? `wo_${id}`;

  // 1. Claim the proposal atomically. Only one caller gets past this line.
  const previousStatus = p.status;
  const claimed = await ProposalModel.findOneAndUpdate(
    { _id: id, status: { $in: APPROVABLE } },
    { status: 'approved', workOrderId, updatedAt: new Date() },
    { new: true },
  ).lean();
  if (!claimed) return existingResult(id);

  try {
    if (target && (p.action === 'reassign' || p.action === 'quotes'))
      return await applyReassign(claimed, target, vendor, site);
    return target
      ? await applyMerge(claimed, target, draft, vendor, site)
      : await applyCreate(
          claimed,
          workOrderId,
          { ...draft, trade },
          vendor,
          site,
          opts.dispatch ?? true,
        );
  } catch (err) {
    await releaseClaim(id, previousStatus);
    throw err;
  }
}

type Site = { _id: string; name: string; address: string; hours: string };
type Vendor = { _id: string; name: string; email: string };

async function assetName(assetId: string | null): Promise<string | null> {
  return assetId ? ((await AssetModel.findById(assetId).lean())?.name ?? null) : null;
}

async function applyCreate(
  p: ProposalDoc,
  workOrderId: string,
  draft: WorkOrderDraft & { trade: Trade },
  vendor: Vendor,
  site: Site,
  dispatch: boolean,
): Promise<ApprovalResult> {
  // 2. Commit NTE: Available -> Committed (once per work order, never past Available).
  const commit = await commitBudget(draft.siteId, `create:${workOrderId}`, draft.nte);
  if (commit === 'insufficient') {
    throw new ApprovalError(
      `NTE $${draft.nte} is more than the site's Available budget. Lower the NTE or increase the budget first.`,
      409,
    );
  }

  // 3. Create the work order (idempotent by id).
  const now = new Date();
  let wo = await WorkOrderModel.findById(workOrderId).lean();
  if (!wo) {
    assertTransition('proposed', 'approved');
    await WorkOrderModel.create({
      _id: workOrderId,
      number: await nextWorkOrderNumber(),
      ...draft,
      // Quote mode: no vendor until the manager picks one from the quotes.
      vendorId: dispatch ? draft.vendorId : null,
      status: 'approved',
      proposalId: p._id,
      notes: [],
      dispatchEmail: null,
      actualCost: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    });
    wo = (await WorkOrderModel.findById(workOrderId).lean())!;
    await logActivity({
      step: 'approve',
      actor: 'manager',
      signalId: p.signalId,
      proposalId: p._id,
      workOrderId,
      inputSummary: `Approved proposal: ${draft.title}`,
      outputSummary: `Created ${wo.number} [${draft.urgency}], committed $${draft.nte} to ${site.name} budget${dispatch ? '' : '; collecting quotes before dispatch'}`,
    });
  }

  // 4. Dispatch: draft the vendor email (stored, never sent) and move to dispatched.
  if (wo.status === 'approved' && wo.vendorId) {
    assertTransition('approved', 'dispatched');
    const email = buildDispatchEmail({
      vendor,
      site,
      workOrder: wo,
      assetName: await assetName(wo.assetId),
    });
    await WorkOrderModel.updateOne(
      { _id: workOrderId, status: 'approved' },
      { status: 'dispatched', dispatchEmail: email, updatedAt: new Date() },
    );
    await logActivity({
      step: 'dispatch',
      actor: 'system',
      proposalId: p._id,
      workOrderId,
      inputSummary: `Dispatch ${wo.number} to ${vendor.name}`,
      outputSummary: `Status dispatched. Email to ${vendor.email} drafted (not sent).`,
    });
  }

  return {
    proposal: (await ProposalModel.findById(p._id).lean())!,
    workOrder: (await WorkOrderModel.findById(workOrderId).lean())!,
    created: true,
  };
}

async function applyMerge(
  p: ProposalDoc,
  target: WorkOrderDoc,
  draft: WorkOrderDraft,
  vendor: Vendor,
  site: Site,
): Promise<ApprovalResult> {
  const raise = URGENCY_RANK[draft.urgency] > URGENCY_RANK[target.urgency];
  const newUrgency = raise ? draft.urgency : target.urgency;
  const newNte = Math.max(target.nte, draft.nte);
  const delta = newNte - target.nte;

  const commit = await commitBudget(target.siteId, `merge:${p._id}`, delta);
  if (commit === 'insufficient') {
    throw new ApprovalError(
      `Raising NTE by $${delta} exceeds the site's Available budget. Lower the NTE first.`,
      409,
    );
  }

  const note = `[${p._id}] ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC: ${p.inputText}`;
  // $addToSet on the note keeps this idempotent; nte/urgency only move up.
  await WorkOrderModel.updateOne(
    { _id: target._id },
    {
      $addToSet: { notes: note },
      $max: { nte: newNte },
      $set: { urgency: newUrgency, updatedAt: new Date() },
    },
  );
  const updated = (await WorkOrderModel.findById(target._id).lean())!;
  const email = buildDispatchEmail({
    vendor,
    site,
    workOrder: updated,
    assetName: await assetName(updated.assetId),
    update: { note: p.inputText, urgencyRaised: raise },
  });
  await WorkOrderModel.updateOne({ _id: target._id }, { dispatchEmail: email });
  await logActivity({
    step: 'approve',
    actor: 'manager',
    signalId: p.signalId,
    proposalId: p._id,
    workOrderId: target._id,
    inputSummary: `Approved merge into ${target.number}`,
    outputSummary: [
      'Report added to work order notes',
      raise ? `urgency raised ${target.urgency} → ${newUrgency}` : null,
      delta > 0 ? `NTE raised to $${newNte} (+$${delta} committed)` : null,
      `update email to ${vendor.email} drafted (not sent)`,
    ]
      .filter(Boolean)
      .join('; '),
  });
  return {
    proposal: (await ProposalModel.findById(p._id).lean())!,
    workOrder: (await WorkOrderModel.findById(target._id).lean())!,
    created: true,
  };
}

/**
 * Reassign after a declined dispatch call: the work order (back at approved, budget still
 * committed) gets the new vendor, a fresh dispatch email, and moves to dispatched again.
 */
async function applyReassign(
  p: ProposalDoc,
  target: WorkOrderDoc,
  vendor: Vendor,
  site: Site,
): Promise<ApprovalResult> {
  if (target.status !== 'approved') {
    if (target.status === 'dispatched' && target.vendorId === vendor._id) {
      return {
        proposal: (await ProposalModel.findById(p._id).lean())!,
        workOrder: target,
        created: false,
      };
    }
    throw new ApprovalError(`${target.number} is ${target.status}; it can't be reassigned`, 409);
  }
  await logActivity({
    step: 'approve',
    actor: 'manager',
    signalId: p.signalId,
    proposalId: p._id,
    workOrderId: target._id,
    inputSummary:
      p.action === 'quotes'
        ? `Picked ${vendor.name} from ${p.quotes?.cards.length ?? 0} quotes for ${target.number}`
        : `Approved reassignment of ${target.number}`,
    outputSummary:
      p.action === 'quotes'
        ? `Quoted ${quotedText(p, vendor._id)} (approximate); NTE $${target.nte} stays committed`
        : `Vendor ${p.reassign?.previousVendorName ?? 'previous vendor'} → ${vendor.name}; NTE $${target.nte} stays committed`,
  });
  assertTransition('approved', 'dispatched');
  const email = buildDispatchEmail({
    vendor,
    site,
    workOrder: target,
    assetName: await assetName(target.assetId),
  });
  await WorkOrderModel.updateOne(
    { _id: target._id, status: 'approved' },
    { status: 'dispatched', vendorId: vendor._id, dispatchEmail: email, updatedAt: new Date() },
  );
  await logActivity({
    step: 'dispatch',
    actor: 'system',
    proposalId: p._id,
    workOrderId: target._id,
    inputSummary: `Dispatch ${target.number} to ${vendor.name}`,
    outputSummary: `Status dispatched. Email to ${vendor.email} drafted (not sent).`,
  });
  return {
    proposal: (await ProposalModel.findById(p._id).lean())!,
    workOrder: (await WorkOrderModel.findById(target._id).lean())!,
    created: true,
  };
}

function quotedText(p: ProposalDoc, vendorId: string): string {
  const card = p.quotes?.cards.find((c) => c.vendorId === vendorId);
  return card ? formatEstimate(card.quote) : 'no estimate';
}

/** POST /api/proposals/:id/reject — reason required, logged. Idempotent. */
export async function rejectProposal(id: string, reason: string): Promise<ProposalDoc> {
  const p = await loadProposal(id);
  if (p.status === 'rejected') return p;
  if (p.status === 'approved') throw new ApprovalError('Proposal is already approved', 409);
  const updated = await ProposalModel.findOneAndUpdate(
    { _id: id, status: { $in: APPROVABLE } },
    { status: 'rejected', rejectionReason: reason, updatedAt: new Date() },
    { new: true },
  ).lean();
  if (!updated) return loadProposal(id);
  await logActivity({
    step: 'reject',
    actor: 'manager',
    signalId: p.signalId,
    proposalId: id,
    inputSummary: `Rejected: ${p.draft.title}`,
    outputSummary: 'No work order created; budget unchanged',
    reason,
  });
  return updated;
}
