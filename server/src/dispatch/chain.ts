import {
  ACTIVE_CHAIN_PHASES,
  estimateCeiling,
  formatEstimate,
  type CallOutcome,
  type CallPlanInput,
  type QuoteCard,
  type QuotesInfo,
  type Urgency,
  type VendorRecommendation,
} from '@fia/shared';
import { logActivity } from '../activity';
import { CallError, MAX_CALLS_PER_WORK_ORDER, type CallService } from '../calls/service';
import type { Env } from '../env';
import { newId } from '../ids';
import { CallModel, type CallDoc } from '../models/call';
import { AssetModel, BudgetModel, SiteModel, VendorModel } from '../models/catalog';
import { ProposalModel, type ProposalDoc } from '../models/pipeline';
import { SettingsModel } from '../models/settings';
import { WorkOrderModel, type WorkOrderDoc } from '../models/workOrder';
import { rankVendors, SITE_TIME_ZONE } from '../pipeline/plan';
import { buildDispatchEmail } from '../workflow/dispatchEmail';
import { proposeNextVendor } from '../workflow/reassign';
import { buildDeclineEmail, buildRfqEmail } from './emails';
import {
  ChainModel,
  ScheduledCallModel,
  type ChainDoc,
  type ChainVendorDoc,
  type ScheduledCallDoc,
} from './models';

/** Quote mode collects this many quotes before the manager compares them. */
export const QUOTES_WANTED = 2;
/** A job claimed this long ago without finishing (crash mid-run) is picked up again. */
const STUCK_JOB_MS = 2 * 60_000;
/** Wait after hitting the hourly call cap. */
const CAP_BACKOFF_MS = 10 * 60_000;

/** Routine and low jobs can wait for a retry; urgent and emergency move on at once. */
const canWait = (u: Urgency): boolean => u === 'routine' || u === 'low';
const isDecline = (o: CallOutcome | null): boolean => o === 'declined' || o === 'opted_out';

const timeText = (d: Date): string =>
  d.toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: SITE_TIME_ZONE,
  });

const missReason = (call: CallDoc): string =>
  call.reason ?? (call.outcome === 'ended' ? 'no decision' : (call.outcome ?? 'no answer'));

export interface ChainServiceDeps {
  env: Env;
  calls: CallService;
  now?: () => Date;
}

type JobResult = 'placed' | 'skipped' | 'stop';

/**
 * Works through vendors after an admin approves a job: quote calls (Quote mode) or booking calls
 * (Book mode), retries, backups and the proposals the manager acts on. Calls run one at a time
 * (they all ring DEMO_VENDOR_PHONE): the next one is scheduled when the previous call reaches a
 * final status, and the scheduler only dials when the line is free.
 */
export class ChainService {
  private readonly env: Env;
  private readonly calls: CallService;
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<unknown>>();
  private running: Promise<number> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: ChainServiceDeps) {
    this.env = deps.env;
    this.calls = deps.calls;
    this.now = deps.now ?? (() => new Date());
    this.calls.deps.onChainCallEnded = (call) => this.onCallEnded(call);
    this.calls.deps.chainActive = (workOrderId) => this.isActive(workOrderId);
  }

  /** One state change per chain at a time (single server process). */
  private withLock<T>(chainId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(chainId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const settled = next.catch(() => undefined);
    this.locks.set(chainId, settled);
    void settled.then(() => {
      if (this.locks.get(chainId) === settled) this.locks.delete(chainId);
    });
    return next;
  }

  private retryDelayMs(): number {
    return this.env.DEMO_RETRY_MINUTES * 60_000;
  }

  async isActive(workOrderId: string): Promise<boolean> {
    return Boolean(
      await ChainModel.exists({ workOrderId, phase: { $in: [...ACTIVE_CHAIN_PHASES] } }),
    );
  }

  async forWorkOrder(
    workOrderId: string,
  ): Promise<{ chain: ChainDoc; nextCallAt: Date | null } | null> {
    const chain = await ChainModel.findOne({ workOrderId }).sort({ createdAt: -1 }).lean();
    if (!chain) return null;
    const next = await ScheduledCallModel.findOne({ chainId: chain._id, status: 'pending' })
      .sort({ dueAt: 1 })
      .lean();
    return { chain, nextCallAt: next?.dueAt ?? null };
  }

  private async save(chain: ChainDoc): Promise<void> {
    chain.updatedAt = this.now();
    await ChainModel.replaceOne({ _id: chain._id }, chain);
  }

  private log(
    chain: ChainDoc,
    input: string,
    output: string,
    extra: { reason?: string | null; proposalId?: string | null; actor?: string } = {},
  ) {
    return logActivity({
      step: 'call',
      actor: extra.actor ?? 'system',
      workOrderId: chain.workOrderId,
      proposalId: extra.proposalId ?? null,
      inputSummary: input,
      outputSummary: output,
      reason: extra.reason ?? null,
    });
  }

  /**
   * Starts a chain for a just-approved work order. `ranked` is the proposal's vendor ranking;
   * the approved vendor goes first. The caller has checked the admin key and CALLS_ENABLED.
   */
  async start(
    workOrderId: string,
    plan: CallPlanInput,
    ranked: VendorRecommendation[],
    firstVendorId: string,
  ): Promise<ChainDoc> {
    const wo = await WorkOrderModel.findById(workOrderId).lean();
    if (!wo) throw new CallError('Work order not found', 404);
    if (await this.isActive(workOrderId)) {
      throw new CallError('The agent is already working through vendors for this job', 409);
    }
    const vendorDocs = await VendorModel.find({
      _id: { $in: [firstVendorId, ...ranked.map((r) => r.vendorId)] },
    }).lean();
    const ids = [...new Set([firstVendorId, ...ranked.map((r) => r.vendorId)])].filter((id) =>
      vendorDocs.some((v) => v._id === id),
    );
    const vendors: ChainVendorDoc[] = ids.map((id) => {
      const rec = ranked.find((r) => r.vendorId === id);
      return {
        vendorId: id,
        name: vendorDocs.find((v) => v._id === id)!.name,
        state: 'unused',
        quoteAttempts: 0,
        bookAttempts: 0,
        quote: null,
        quoteCallId: null,
        note: null,
        distanceMiles: rec?.distanceMiles ?? null,
        rating: rec?.rating ?? null,
        performanceScore: rec?.performanceScore ?? null,
      };
    });
    const now = this.now();
    const chain: ChainDoc = {
      _id: newId('chain'),
      workOrderId,
      workOrderNumber: wo.number,
      urgency: wo.urgency,
      mode: plan.mode,
      autoBackup: plan.mode === 'book' && plan.autoBackup,
      phase: plan.mode === 'quote' ? 'quoting' : 'booking',
      vendors,
      bookingVendorId: plan.mode === 'book' ? vendors[0]!.vendorId : null,
      proposalId: null,
      round: 0,
      emails: [],
      createdAt: now,
      updatedAt: now,
    };
    await ChainModel.create(chain);
    await this.log(
      chain,
      `Call chain for ${wo.number}: ${plan.mode === 'quote' ? 'Quote' : 'Book'} mode`,
      plan.mode === 'quote'
        ? `Collect ${QUOTES_WANTED} quotes, one call at a time, from ${vendors.map((v) => v.name).join(', ')}; the manager picks`
        : `Book ${vendors[0]!.name} now${
            chain.autoBackup
              ? `; auto-call backups (${
                  vendors
                    .slice(1)
                    .map((v) => v.name)
                    .join(', ') || 'none'
                }) on a miss or decline`
              : '; propose the next vendor on a miss or decline'
          }`,
      { actor: 'manager' },
    );
    await this.withLock(chain._id, async () => {
      const c = (await ChainModel.findById(chain._id).lean())!;
      if (c.mode === 'quote') {
        await this.advanceQuoting(c);
      } else {
        c.vendors[0]!.state = 'waiting';
        await this.enqueue(c, c.vendors[0]!, 'book', null, now);
      }
      await this.save(c);
    });
    this.kick();
    return (await ChainModel.findById(chain._id).lean())!;
  }

  private async enqueue(
    chain: ChainDoc,
    v: ChainVendorDoc,
    purpose: 'quote' | 'book' | 'retry',
    retryOf: 'quote' | 'book' | null,
    dueAt: Date,
  ): Promise<void> {
    const kind = retryOf ?? (purpose as 'quote' | 'book');
    const attempt = (kind === 'quote' ? v.quoteAttempts : v.bookAttempts) + 1;
    const now = this.now();
    try {
      await ScheduledCallModel.create({
        _id: `job_${chain._id}_${v.vendorId}_${kind}_${attempt}_r${chain.round}`,
        dueAt,
        workOrderId: chain.workOrderId,
        chainId: chain._id,
        vendorIndex: chain.vendors.indexOf(v),
        vendorId: v.vendorId,
        purpose,
        retryOf,
        attempt,
        status: 'pending',
        claimedAt: null,
        callId: null,
        result: null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  /** Quote mode: keep two vendors in play until two quotes are in or nobody is left. */
  private async advanceQuoting(chain: ChainDoc): Promise<void> {
    if (chain.phase !== 'quoting') return;
    const quoted = chain.vendors.filter((v) => v.state === 'quoted');
    if (quoted.length >= QUOTES_WANTED) {
      await this.raiseQuotes(chain);
      return;
    }
    const open = chain.vendors.filter((v) => v.state === 'waiting');
    const started = chain.vendors.some((v) => v.state !== 'unused');
    while (open.length < QUOTES_WANTED - quoted.length) {
      const next = chain.vendors.find((v) => v.state === 'unused');
      if (!next) break;
      next.state = 'waiting';
      await this.enqueue(chain, next, 'quote', null, this.now());
      open.push(next);
      if (started) {
        await this.log(
          chain,
          `Chain advanced on ${chain.workOrderNumber}`,
          `Calling ${next.name} for a quote next`,
        );
      }
    }
    if (open.length > 0) return;
    if (quoted.length > 0) await this.raiseQuotes(chain);
    else await this.exhaust(chain, 'No vendor reached');
  }

  /** "Quotes ready": a proposal with side-by-side cards; the manager picks (no auto-pick). */
  private async raiseQuotes(chain: ChainDoc): Promise<void> {
    const wo = await WorkOrderModel.findById(chain.workOrderId).lean();
    if (!wo) return;
    const quoted = chain.vendors.filter((v) => v.state === 'quoted' && v.quote);
    const calls = await CallModel.find({ _id: { $in: quoted.map((v) => v.quoteCallId) } }).lean();
    const cards: QuoteCard[] = quoted.map((v) => ({
      vendorId: v.vendorId,
      vendorName: v.name,
      callId: v.quoteCallId,
      quote: v.quote!,
      distanceMiles: v.distanceMiles,
      rating: v.rating,
      performanceScore: v.performanceScore,
      summary: calls.find((c) => c._id === v.quoteCallId)?.summary ?? null,
    }));
    const best = (score: (c: QuoteCard) => number | null): string | null => {
      const scored = cards
        .map((c) => ({ id: c.vendorId, s: score(c) }))
        .filter((x): x is { id: string; s: number } => x.s !== null);
      if (cards.length < 2 || scored.length === 0) return null;
      const min = Math.min(...scored.map((x) => x.s));
      const at = scored.filter((x) => x.s === min);
      return at.length === 1 ? at[0]!.id : null;
    };
    const quotes: QuotesInfo = {
      workOrderId: wo._id,
      workOrderNumber: wo.number,
      chainId: chain._id,
      cards,
      cheapestVendorId: best((c) => estimateCeiling(c.quote)),
      soonestVendorId: best((c) =>
        c.quote.earliestArrival ? new Date(c.quote.earliestArrival).getTime() : null,
      ),
    };
    const id = `prop_quotes_${chain._id}_${chain.round}`;
    chain.round += 1;
    await this.createProposal(
      wo,
      id,
      'quotes',
      { quotes },
      quoted.map((v) => v.vendorId),
    );
    chain.phase = 'quotes_ready';
    chain.proposalId = id;
    await this.log(
      chain,
      `Quotes ready for ${wo.number}`,
      cards
        .map((c) => `${c.vendorName}: ${formatEstimate(c.quote)} (approximate)`)
        .join('; ')
        .concat('. Waiting on the manager to pick.'),
      { proposalId: id },
    );
  }

  private async createProposal(
    wo: WorkOrderDoc,
    id: string,
    action: 'quotes',
    extra: { quotes: QuotesInfo },
    vendorIds: string[],
  ): Promise<void> {
    if (await ProposalModel.exists({ _id: id })) return;
    const now = this.now();
    const [site, vendors, budget, original] = await Promise.all([
      SiteModel.findById(wo.siteId).lean(),
      VendorModel.find().lean(),
      BudgetModel.findById(wo.siteId).lean(),
      wo.proposalId ? ProposalModel.findById(wo.proposalId).lean() : null,
    ]);
    const ranking = site ? rankVendors(vendors, site, wo.trade, wo.urgency, now) : { top: [] };
    const available = budget ? budget.total - budget.committed - budget.spent : 0;
    try {
      await ProposalModel.create({
        _id: id,
        signalId: original?.signalId ?? `wo:${wo._id}`,
        signalType: original?.signalType ?? 'request',
        reference: original?.reference ?? null,
        inputText: original?.inputText ?? `${wo.title}. ${wo.description}`.trim(),
        status: 'proposed',
        action,
        draft: {
          siteId: wo.siteId,
          assetId: wo.assetId,
          trade: wo.trade,
          title: wo.title,
          description: wo.description,
          locationText: wo.locationText,
          urgency: wo.urgency,
          nte: wo.nte,
          // No auto-pick: the manager chooses from the cards.
          vendorId: null,
        },
        urgencyReason: `Unchanged from ${wo.number}`,
        safetyRule: original?.safetyRule ?? null,
        vendors: ranking.top.filter((v) => vendorIds.includes(v.vendorId)),
        budget: { tableNte: wo.nte, available, needsBudgetIncrease: false, shortfall: 0 },
        duplicate: null,
        reassign: null,
        quotes: extra.quotes,
        repeatIssueNote: null,
        trendNote: null,
        needsHuman: false,
        needsHumanReason: null,
        clarifyingQuestion: null,
        confidence: 1,
        checks: [
          {
            name: 'Quotes are approximate',
            passed: true,
            detail: 'Rough estimates from phone calls; the vendor confirms on site',
          },
        ],
        excludedVendors: [],
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
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  /** Nobody left to call: a needs-human proposal on the work order, red banner in the Inbox. */
  private async exhaust(chain: ChainDoc, reason: string, last?: CallDoc): Promise<void> {
    const wo = await WorkOrderModel.findById(chain.workOrderId).lean();
    const lastVendor = last
      ? { vendorId: last.vendorId, vendorName: last.vendorName }
      : {
          vendorId: wo?.vendorId ?? chain.vendors[0]!.vendorId,
          vendorName: chain.vendors[0]!.name,
        };
    const id = `prop_nohuman_${chain._id}_${chain.round}`;
    chain.round += 1;
    await proposeNextVendor(
      { _id: `${chain._id}_${chain.round}`, workOrderId: chain.workOrderId, ...lastVendor, reason },
      this.now(),
      {
        vendorId: null,
        declined: last ? isDecline(last.outcome) : false,
        needsHumanReason: reason,
        proposalId: id,
      },
    );
    chain.phase = 'needs_human';
    chain.proposalId = id;
    await ScheduledCallModel.updateMany(
      { chainId: chain._id, status: 'pending' },
      { status: 'cancelled', result: reason, updatedAt: this.now() },
    );
    await this.log(
      chain,
      `${reason} for ${chain.workOrderNumber}`,
      'Needs a human: choose a vendor manually',
      {
        proposalId: id,
        reason,
      },
    );
  }

  /** Hook from CallService: a chain call reached its final status. */
  async onCallEnded(call: CallDoc): Promise<void> {
    if (!call.chainId) return;
    await this.withLock(call.chainId, () => this.handleEnded(call));
    this.kick();
  }

  private async handleEnded(call: CallDoc): Promise<void> {
    const chain = await ChainModel.findById(call.chainId).lean();
    if (!chain || !(ACTIVE_CHAIN_PHASES as readonly string[]).includes(chain.phase)) return;
    const v = chain.vendors.find((x) => x.vendorId === call.vendorId);
    if (!v) return;
    if (call.purpose === 'quote') await this.quoteEnded(chain, v, call);
    else await this.bookEnded(chain, v, call);
    await this.save(chain);
  }

  private async quoteEnded(chain: ChainDoc, v: ChainVendorDoc, call: CallDoc): Promise<void> {
    if (chain.phase !== 'quoting' || v.state !== 'waiting') return;
    if (call.outcome === 'quoted' && call.quote) {
      v.state = 'quoted';
      v.quote = call.quote;
      v.quoteCallId = call._id;
      v.note = null;
      await this.log(
        chain,
        `Quote captured from ${v.name}`,
        call.summary ?? formatEstimate(call.quote),
      );
    } else if (isDecline(call.outcome)) {
      v.state = 'dropped';
      v.note =
        call.outcome === 'opted_out' ? 'Asked not to be called' : `Declined: ${missReason(call)}`;
      await this.log(
        chain,
        `${v.name} won't quote ${chain.workOrderNumber}`,
        'Moving to the next vendor',
        {
          reason: v.note,
        },
      );
    } else if (canWait(chain.urgency) && v.quoteAttempts < 2) {
      const at = new Date(this.now().getTime() + this.retryDelayMs());
      await this.enqueue(chain, v, 'retry', 'quote', at);
      v.note = `Missed (${missReason(call)}); retry ${timeText(at)}`;
      const emailed = await this.draftEmail(chain, v, 'rfq');
      await this.log(
        chain,
        `Missed ${v.name} for a quote`,
        `Retry scheduled for ${timeText(at)}${emailed ? '; request-for-quote email drafted (not sent)' : ''}`,
        { reason: missReason(call) },
      );
    } else {
      v.state = 'dropped';
      v.note = `Missed: ${missReason(call)}`;
      await this.log(chain, `Missed ${v.name} for a quote`, 'Moving to the next vendor', {
        reason: missReason(call),
      });
    }
    await this.advanceQuoting(chain);
  }

  private async bookEnded(chain: ChainDoc, v: ChainVendorDoc, call: CallDoc): Promise<void> {
    if (chain.phase !== 'booking' || chain.bookingVendorId !== v.vendorId) return;
    if (call.outcome === 'confirmed') {
      v.state = 'booked';
      chain.phase = 'booked';
      await ScheduledCallModel.updateMany(
        { chainId: chain._id, status: 'pending' },
        { status: 'cancelled', result: 'Booked', updatedAt: this.now() },
      );
      await this.log(
        chain,
        `${v.name} booked for ${chain.workOrderNumber}`,
        call.summary ?? 'Confirmed',
      );
      if (chain.mode === 'quote') {
        for (const other of chain.vendors.filter((x) => x.state === 'quoted' && x !== v)) {
          await this.draftEmail(chain, other, 'decline');
        }
      }
      return;
    }

    const declined = isDecline(call.outcome);
    const reason = missReason(call);
    const autoBackup = chain.mode === 'book' && chain.autoBackup;
    if (!declined && !autoBackup && canWait(chain.urgency) && v.bookAttempts < 2) {
      const at = new Date(this.now().getTime() + this.retryDelayMs());
      await this.enqueue(chain, v, 'retry', 'book', at);
      v.note = `Missed (${reason}); retry ${timeText(at)}`;
      await this.log(
        chain,
        `Missed ${v.name} for the booking`,
        `Retry scheduled for ${timeText(at)}`,
        {
          reason,
        },
      );
      return;
    }

    v.state = 'dropped';
    v.note = declined ? `Declined: ${reason}` : `Missed: ${reason}`;
    if (autoBackup) {
      const next = chain.vendors.find((x) => x.state === 'unused');
      if (!next) {
        await this.exhaust(chain, 'No vendor reached', call);
        return;
      }
      await this.switchVendor(chain, v, next, declined);
      next.state = 'waiting';
      chain.bookingVendorId = next.vendorId;
      await this.enqueue(chain, next, 'book', null, this.now());
      await this.log(
        chain,
        `Auto-backup on ${chain.workOrderNumber}: ${v.name} ${declined ? 'declined' : 'missed'}`,
        `Calling ${next.name} now`,
        { reason },
      );
      return;
    }

    // Ask the manager: the runner-up quote (Quote mode) or the next ranked vendor (Book mode).
    const candidate =
      chain.mode === 'quote'
        ? chain.vendors.find((x) => x.state === 'quoted' && x !== v)
        : chain.vendors.find((x) => x.state === 'unused');
    if (!candidate) {
      await this.exhaust(chain, 'No vendor reached', call);
      return;
    }
    const id = `prop_next_${chain._id}_${chain.round}`;
    chain.round += 1;
    await proposeNextVendor(call, this.now(), {
      vendorId: candidate.vendorId,
      declined,
      excludeVendorIds: chain.vendors.filter((x) => x.state === 'dropped').map((x) => x.vendorId),
      proposalId: id,
    });
    chain.phase = 'awaiting_approval';
    chain.proposalId = id;
    chain.bookingVendorId = null;
    await this.log(
      chain,
      `${v.name} ${declined ? 'declined' : 'not reached'} for ${chain.workOrderNumber}`,
      chain.mode === 'quote'
        ? `Runner-up ${candidate.name} offered as a one-click proposal`
        : `Next vendor ${candidate.name} proposed for approval`,
      { proposalId: id, reason },
    );
  }

  /** Book mode auto-backup: the dispatched work order moves to the next vendor. */
  private async switchVendor(
    chain: ChainDoc,
    from: ChainVendorDoc,
    to: ChainVendorDoc,
    declined: boolean,
  ): Promise<void> {
    const wo = await WorkOrderModel.findById(chain.workOrderId).lean();
    const [vendor, site] = await Promise.all([
      VendorModel.findById(to.vendorId).lean(),
      wo ? SiteModel.findById(wo.siteId).lean() : null,
    ]);
    if (!wo || !vendor || !site) return;
    const asset = wo.assetId ? await AssetModel.findById(wo.assetId).lean() : null;
    const email = buildDispatchEmail({
      vendor,
      site,
      workOrder: wo,
      assetName: asset?.name ?? null,
    });
    await WorkOrderModel.updateOne(
      { _id: wo._id, status: 'dispatched', vendorId: from.vendorId },
      {
        $set: { vendorId: to.vendorId, dispatchEmail: email, updatedAt: this.now() },
        ...(declined ? { $addToSet: { declinedVendorIds: from.vendorId } } : {}),
      },
    );
    await logActivity({
      step: 'dispatch',
      actor: 'system',
      workOrderId: wo._id,
      inputSummary: `Auto-backup: ${wo.number} ${from.name} → ${to.name}`,
      outputSummary: `Email to ${vendor.email} drafted (not sent)`,
    });
  }

  /** Stores an email draft on the chain (never sent). False if one already exists. */
  private async draftEmail(
    chain: ChainDoc,
    v: ChainVendorDoc,
    kind: 'rfq' | 'decline',
  ): Promise<boolean> {
    if (chain.emails.some((e) => e.kind === kind && e.vendorId === v.vendorId)) return false;
    const wo = await WorkOrderModel.findById(chain.workOrderId).lean();
    const [vendor, site] = await Promise.all([
      VendorModel.findById(v.vendorId).lean(),
      wo ? SiteModel.findById(wo.siteId).lean() : null,
    ]);
    if (!wo || !vendor || !site) return false;
    const input = { vendor, site, workOrder: wo };
    chain.emails.push({
      kind,
      vendorId: v.vendorId,
      vendorName: v.name,
      email: kind === 'rfq' ? buildRfqEmail(input) : buildDeclineEmail(input),
      createdAt: this.now(),
    });
    if (kind === 'decline') {
      await this.log(
        chain,
        `Decline email for ${v.name}`,
        `"We've gone with another provider" drafted to ${vendor.email} (not sent)`,
      );
    }
    return true;
  }

  /**
   * After the manager approves a chain proposal: picking a quote or the runner-up / next vendor
   * queues the booking call. Approving a needs-human proposal hands the job to the manager.
   */
  async afterApproval(proposal: ProposalDoc, workOrder: WorkOrderDoc): Promise<void> {
    const chain = await ChainModel.findOne({ proposalId: proposal._id }).lean();
    if (!chain) return;
    await this.withLock(chain._id, async () => {
      const c = (await ChainModel.findById(chain._id).lean())!;
      if (c.proposalId !== proposal._id) return;
      const vendorId = workOrder.vendorId;
      if (c.phase === 'needs_human' || !vendorId) {
        c.phase = 'closed';
        c.proposalId = null;
        await this.log(
          c,
          `Manager took over ${c.workOrderNumber}`,
          'Dispatched by email; the agent makes no more calls',
          {
            actor: 'manager',
          },
        );
        await this.save(c);
        return;
      }
      if (c.phase !== 'quotes_ready' && c.phase !== 'awaiting_approval') return;
      let v = c.vendors.find((x) => x.vendorId === vendorId);
      if (!v) {
        const vendor = await VendorModel.findById(vendorId).lean();
        v = {
          vendorId,
          name: vendor?.name ?? vendorId,
          state: 'unused',
          quoteAttempts: 0,
          bookAttempts: 0,
          quote: null,
          quoteCallId: null,
          note: null,
          distanceMiles: null,
          rating: null,
          performanceScore: null,
        };
        c.vendors.push(v);
      }
      v.state = 'waiting';
      c.phase = 'booking';
      c.bookingVendorId = vendorId;
      c.proposalId = null;
      await this.enqueue(c, v, 'book', null, this.now());
      await this.log(
        c,
        `Manager picked ${v.name} for ${c.workOrderNumber}`,
        `Booking call queued${v.quote ? `; quoted ${formatEstimate(v.quote)} (approximate)` : ''}`,
        { actor: 'manager', proposalId: proposal._id },
      );
      await this.save(c);
    });
    this.kick();
  }

  /**
   * After the manager rejects a chain proposal. Rejecting the quotes calls the next unused
   * vendor for a quote (or flags a human); rejecting a next-vendor proposal stops the agent.
   */
  async afterRejection(proposal: ProposalDoc): Promise<void> {
    const chain = await ChainModel.findOne({ proposalId: proposal._id }).lean();
    if (!chain) return;
    await this.withLock(chain._id, async () => {
      const c = (await ChainModel.findById(chain._id).lean())!;
      if (c.proposalId !== proposal._id) return;
      c.proposalId = null;
      if (c.phase === 'quotes_ready') {
        for (const v of c.vendors.filter((x) => x.state === 'quoted')) {
          v.state = 'dropped';
          v.note = 'Quote rejected by the manager';
        }
        c.phase = 'quoting';
        await this.log(
          c,
          `Manager rejected all quotes for ${c.workOrderNumber}`,
          'Looking for the next unused vendor',
          {
            actor: 'manager',
            reason: proposal.rejectionReason,
          },
        );
        await this.advanceQuoting(c);
      } else {
        c.phase = 'closed';
        await this.log(
          c,
          `Manager rejected the proposal for ${c.workOrderNumber}`,
          'The agent makes no more calls on this job',
          {
            actor: 'manager',
            reason: proposal.rejectionReason,
          },
        );
      }
      await this.save(c);
    });
    this.kick();
  }

  // ---- Scheduler ----

  /** Runs due jobs now (or again once the current run finishes). Never throws. */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      let placed = 0;
      do {
        this.again = false;
        try {
          placed += await this.runDueOnce();
        } catch (err) {
          console.error('[chains] run-due failed', err);
        }
      } while (this.again);
      return placed;
    })().finally(() => {
      this.running = null;
    });
  }

  /** POST /api/jobs/run-due, startup and the 2-minute timer. Returns calls placed. */
  async runDue(): Promise<number> {
    this.kick();
    return (await this.running) ?? 0;
  }

  /** Resolves once no scheduler run is in progress (tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  startTimer(intervalMs: number): void {
    this.stopTimer();
    this.timer = setInterval(() => this.kick(), intervalMs);
    this.timer.unref();
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runDueOnce(): Promise<number> {
    await this.calls.sweepStaleCalls();
    if (!this.calls.enabled()) return 0;
    const settings = await SettingsModel.findById('global').lean();
    if (settings?.autonomyMode === 'advise') return 0;
    const now = this.now();
    await ScheduledCallModel.updateMany(
      { status: 'running', claimedAt: { $lt: new Date(now.getTime() - STUCK_JOB_MS) } },
      { status: 'pending', claimedAt: null, updatedAt: now },
    );
    let placed = 0;
    while (!(await this.calls.lineBusy())) {
      const job = await ScheduledCallModel.findOneAndUpdate(
        { status: 'pending', dueAt: { $lte: this.now() } },
        { status: 'running', claimedAt: this.now(), updatedAt: this.now() },
        { sort: { dueAt: 1, vendorIndex: 1 }, new: true },
      ).lean();
      if (!job) break;
      const r = await this.runJob(job);
      if (r === 'placed') placed += 1;
      if (r === 'stop') break;
    }
    return placed;
  }

  private async finishJob(
    job: ScheduledCallDoc,
    status: 'pending' | 'done' | 'cancelled',
    result: string | null,
    extra: { callId?: string; dueAt?: Date } = {},
  ): Promise<void> {
    await ScheduledCallModel.updateOne(
      { _id: job._id },
      {
        status,
        result,
        claimedAt: null,
        ...(extra.callId ? { callId: extra.callId } : {}),
        ...(extra.dueAt ? { dueAt: extra.dueAt } : {}),
        updatedAt: this.now(),
      },
    );
  }

  /** Adds (or with -1 takes back) one call attempt on the chain's vendor entry. */
  private bumpAttempt(job: ScheduledCallDoc, by: 1 | -1): Promise<void> {
    const field = (job.retryOf ?? job.purpose) === 'quote' ? 'quoteAttempts' : 'bookAttempts';
    return this.withLock(job.chainId, async () => {
      const c = await ChainModel.findById(job.chainId).lean();
      const v = c?.vendors.find((x) => x.vendorId === job.vendorId);
      if (!c || !v) return;
      v[field] = Math.max(0, v[field] + by);
      await this.save(c);
    });
  }

  private async runJob(job: ScheduledCallDoc): Promise<JobResult> {
    const chain = await ChainModel.findById(job.chainId).lean();
    const v = chain?.vendors.find((x) => x.vendorId === job.vendorId);
    const kind = job.retryOf ?? (job.purpose as 'quote' | 'book');
    const relevant =
      chain &&
      v &&
      v.state === 'waiting' &&
      (kind === 'quote'
        ? chain.phase === 'quoting'
        : chain.phase === 'booking' && chain.bookingVendorId === v.vendorId);
    if (!relevant) {
      await this.finishJob(job, 'cancelled', 'No longer needed');
      return 'skipped';
    }
    await this.bumpAttempt(job, 1);
    try {
      const call = await this.calls.place({
        workOrderId: job.workOrderId,
        vendorId: job.vendorId,
        purpose: kind,
        chainId: job.chainId,
        actor: 'system',
        callId: `call_${job._id}`,
        bookingQuote: kind === 'book' && chain.mode === 'quote' ? v.quote : null,
      });
      await this.finishJob(job, 'done', null, { callId: call._id });
      return 'placed';
    } catch (err) {
      if (!(err instanceof CallError)) {
        await this.bumpAttempt(job, -1);
        await this.finishJob(job, 'pending', String(err).slice(0, 300), {
          dueAt: new Date(this.now().getTime() + STUCK_JOB_MS),
        });
        throw err;
      }
      if (err.code === 'busy') {
        await this.bumpAttempt(job, -1);
        await this.finishJob(job, 'pending', null);
        return 'stop';
      }
      if (err.code === 'hourly_cap') {
        await this.bumpAttempt(job, -1);
        const at = new Date(this.now().getTime() + CAP_BACKOFF_MS);
        await this.finishJob(job, 'pending', err.message, { dueAt: at });
        await this.log(
          chain,
          `Hourly call limit reached`,
          `Next call for ${chain.workOrderNumber} postponed to ${timeText(at)}`,
        );
        return 'stop';
      }
      if (err.code === 'work_order_cap') {
        await this.finishJob(job, 'done', err.message);
        await this.withLock(chain._id, async () => {
          const c = (await ChainModel.findById(chain._id).lean())!;
          await this.exhaust(
            c,
            `Call limit reached (${MAX_CALLS_PER_WORK_ORDER} calls for this work order)`,
          );
          await this.save(c);
        });
        return 'skipped';
      }
      if (err.status === 502) {
        // Twilio refused the placement; the call record and the chain hook already handled it.
        await this.finishJob(job, 'done', err.message, { callId: `call_${job._id}` });
        return 'skipped';
      }
      await this.finishJob(job, 'cancelled', err.message);
      await this.log(chain, `Scheduled call for ${chain.workOrderNumber} skipped`, err.message);
      return 'skipped';
    }
  }
}
