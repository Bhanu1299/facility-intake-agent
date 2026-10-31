import { logActivity } from '../activity';
import type { CallDoc } from '../models/call';
import { BudgetModel, SiteModel, VendorModel } from '../models/catalog';
import { ProposalModel } from '../models/pipeline';
import { SettingsModel } from '../models/settings';
import { WorkOrderModel } from '../models/workOrder';
import { rankVendors } from '../pipeline/plan';
import { assertTransition } from './lifecycle';

/**
 * A vendor declined on the dispatch call: the work order goes back to approved (its budget
 * commitment stays), and a `reassign` proposal suggests the next ranked vendor. The manager
 * approves it like any other proposal. Idempotent: the proposal id is derived from the call.
 */
export async function proposeNextVendor(
  call: Pick<CallDoc, '_id' | 'workOrderId' | 'vendorId' | 'vendorName' | 'reason'>,
  now: Date,
): Promise<string | null> {
  const wo = await WorkOrderModel.findById(call.workOrderId).lean();
  if (!wo) return null;

  if (wo.status === 'dispatched' && wo.vendorId === call.vendorId) {
    assertTransition('dispatched', 'approved');
    const res = await WorkOrderModel.updateOne(
      { _id: wo._id, status: 'dispatched', vendorId: call.vendorId },
      {
        $set: { status: 'approved', vendorId: null, updatedAt: now },
        $addToSet: { declinedVendorIds: call.vendorId },
      },
    );
    if (res.modifiedCount === 1) {
      await logActivity({
        step: 'call',
        actor: 'system',
        workOrderId: wo._id,
        inputSummary: `${call.vendorName} declined ${wo.number}`,
        outputSummary: 'Status dispatched → approved; budget commitment kept',
        reason: call.reason,
      });
    }
  }

  const id = `prop_reassign_${call._id}`;
  if (await ProposalModel.exists({ _id: id })) return id;

  const [site, vendors, budget, original, settings] = await Promise.all([
    SiteModel.findById(wo.siteId).lean(),
    VendorModel.find().lean(),
    BudgetModel.findById(wo.siteId).lean(),
    wo.proposalId ? ProposalModel.findById(wo.proposalId).lean() : null,
    SettingsModel.findById('global').lean(),
  ]);
  if (!site) return null;
  const declined = new Set([...(wo.declinedVendorIds ?? []), call.vendorId]);
  const ranking = rankVendors(vendors, site, wo.trade, wo.urgency, now);
  const top = ranking.top.filter((v) => !declined.has(v.vendorId));
  const next = top[0] ?? null;
  const available = budget ? budget.total - budget.committed - budget.spent : 0;

  try {
    await ProposalModel.create({
      _id: id,
      signalId: original?.signalId ?? `wo:${wo._id}`,
      signalType: original?.signalType ?? 'request',
      reference: original?.reference ?? null,
      inputText: original?.inputText ?? `${wo.title}. ${wo.description}`.trim(),
      status: settings?.autonomyMode === 'advise' ? 'advisory' : 'proposed',
      action: 'reassign',
      draft: {
        siteId: wo.siteId,
        assetId: wo.assetId,
        trade: wo.trade,
        title: wo.title,
        description: wo.description,
        locationText: wo.locationText,
        urgency: wo.urgency,
        nte: wo.nte,
        vendorId: next?.vendorId ?? null,
      },
      urgencyReason: `Unchanged from ${wo.number}`,
      safetyRule: original?.safetyRule ?? null,
      vendors: top,
      // The NTE is already committed, so no new budget is needed.
      budget: { tableNte: wo.nte, available, needsBudgetIncrease: false, shortfall: 0 },
      duplicate: null,
      reassign: {
        workOrderId: wo._id,
        workOrderNumber: wo.number,
        previousVendorId: call.vendorId,
        previousVendorName: call.vendorName,
        reason: call.reason ?? 'Declined on the dispatch call',
        callId: call._id,
      },
      repeatIssueNote: null,
      trendNote: null,
      needsHuman: !next,
      needsHumanReason: next ? null : 'No other eligible vendor; choose one manually',
      clarifyingQuestion: null,
      confidence: 1,
      checks: [
        {
          name: 'Previous vendor declined',
          passed: true,
          detail: `${call.vendorName} declined on the call; excluded from this proposal`,
        },
      ],
      excludedVendors: ranking.excluded.map(({ name, reason }) => ({ name, reason })),
      modelUsed: null,
      escalated: false,
      latencyMs: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      workOrderId: null,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return id;
    throw err;
  }
  await logActivity({
    step: 'propose',
    actor: 'system',
    proposalId: id,
    workOrderId: wo._id,
    inputSummary: `Reassign ${wo.number} after ${call.vendorName} declined`,
    outputSummary: next
      ? `Proposed next vendor: ${next.name} (${next.reason})`
      : 'No other eligible vendor; needs a human',
    reason: call.reason,
  });
  return id;
}
