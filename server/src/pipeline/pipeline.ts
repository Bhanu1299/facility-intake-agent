import {
  DuplicateVerdict,
  URGENCY_RANK,
  Understanding,
  type AutonomyMode,
  type DuplicateInfo,
  type SafetyRuleHit,
  type SignalInput,
  type TokenUsage,
  type Trade,
  type VerifyCheck,
  type WorkOrderDraft,
} from '@fia/shared';
import { logActivity } from '../activity';
import { newId } from '../ids';
import type { LlmClient } from '../llm/client';
import {
  AssetModel,
  BudgetModel,
  SensorReadingModel,
  SiteModel,
  VendorModel,
  type AssetDoc,
  type SiteDoc,
} from '../models/catalog';
import { ProposalModel, SignalModel, type ProposalDoc } from '../models/pipeline';
import { SettingsModel } from '../models/settings';
import { nextRequestReference, type WorkOrderDoc } from '../models/workOrder';
import { findDuplicateCandidates, recentRepairCount, repeatIssueNote } from './ground';
import { planNte, rankVendors, type VendorRanking } from './plan';
import {
  DUPLICATE_SYSTEM,
  UNDERSTAND_SYSTEM,
  duplicateUserPrompt,
  understandUserPrompt,
} from './prompts';
import { checkSafety } from './safety';
import { assessSensor, formatValue, type SensorAssessment } from './sensor';

export const ESCALATE_BELOW_CONFIDENCE = 0.7;
export const NEEDS_HUMAN_BELOW_CONFIDENCE = 0.6;
const SENSOR_HISTORY_HOURS = 48;
const MAX_DUPLICATE_CHECKS = 3;

export interface PipelineDeps {
  llm: LlmClient;
  models: { small: string; big: string };
  now?: () => Date;
}

/** Thrown for inputs that reference unknown sites/assets (the route turns these into 400s). */
export class SignalInputError extends Error {}

interface Normalized {
  signalId: string;
  reference: string | null;
  type: SignalInput['type'];
  site: SiteDoc;
  assets: AssetDoc[];
  /** Request text, or the sensor reading in words. */
  text: string;
  sensorAsset: AssetDoc | null;
  sensor: SensorAssessment | null;
}

interface Pass {
  model: string;
  understanding: Understanding | null;
  llmError: string | null;
  usage: TokenUsage;
  latencyMs: number;
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  totalTokens: a.totalTokens + b.totalTokens,
});

/** Resolves the site for an input, or throws SignalInputError. Used by the route before 202. */
export async function resolveSiteId(input: SignalInput): Promise<string> {
  if (input.type === 'request') {
    if (!(await SiteModel.exists({ _id: input.siteId }))) {
      throw new SignalInputError(`Unknown site: ${input.siteId}`);
    }
    return input.siteId;
  }
  const asset = await AssetModel.findById(input.assetId).lean();
  if (!asset) throw new SignalInputError(`Unknown asset: ${input.assetId}`);
  if (!asset.sensor) throw new SignalInputError(`Asset ${input.assetId} has no sensor`);
  if (asset.sensor.metric !== input.metric || asset.sensor.unit !== input.unit) {
    throw new SignalInputError(
      `Asset ${input.assetId} reports ${asset.sensor.metric} in ${asset.sensor.unit}`,
    );
  }
  return asset.siteId;
}

/** Creates the Signal record. The pipeline then runs on it (in the background for the API). */
export async function createSignal(
  input: SignalInput,
  now = new Date(),
): Promise<{ id: string; reference: string | null }> {
  const siteId = await resolveSiteId(input);
  const id = newId('sig');
  const reference = input.type === 'request' ? await nextRequestReference() : null;
  await SignalModel.create({
    _id: id,
    type: input.type,
    siteId,
    input,
    reference,
    receivedAt: now,
    status: 'processing',
    proposalId: null,
    error: null,
  });
  return { id, reference };
}

/** Runs steps 1-7 for a stored signal and returns the saved proposal. */
export async function runPipeline(signalId: string, deps: PipelineDeps): Promise<ProposalDoc> {
  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  const proposalId = newId('prop');
  const ids = { signalId, proposalId };
  try {
    const n = await normalize(signalId, now, ids);

    // Step 2: understand (small model).
    let pass = await understand(n, deps.models.small, deps.llm, 'low', ids);
    let usage = pass.usage;
    let escalated = false;

    let result = await groundAndPlan(n, pass, deps, now, ids);
    usage = addUsage(usage, result.usage);

    // Step 6: verify; escalate once to the big model if anything is off.
    let verdict = verify(n, pass, result);
    await logActivity({
      ...ids,
      step: 'verify',
      actor: 'system',
      inputSummary: `model ${pass.model}, confidence ${pass.understanding?.confidence ?? 'n/a'}`,
      outputSummary: verdict.checks.map((c) => `${c.passed ? '✓' : '✗'} ${c.name}`).join(', '),
      reason: verdict.escalate
        ? `Escalating to ${deps.models.big}: ${verdict.why}`
        : 'All checks passed',
    });

    if (verdict.escalate) {
      escalated = true;
      pass = await understand(n, deps.models.big, deps.llm, 'medium', ids);
      usage = addUsage(usage, pass.usage);
      result = await groundAndPlan(n, pass, deps, now, ids);
      usage = addUsage(usage, result.usage);
      verdict = verify(n, pass, result);
      await logActivity({
        ...ids,
        step: 'verify',
        actor: 'system',
        inputSummary: `model ${pass.model}, confidence ${pass.understanding?.confidence ?? 'n/a'}`,
        outputSummary: verdict.checks.map((c) => `${c.passed ? '✓' : '✗'} ${c.name}`).join(', '),
        reason: verdict.needsHuman
          ? `Needs a human: ${verdict.needsHumanReason}`
          : 'Checks passed after escalation',
      });
    }

    // Step 7: propose.
    const autonomy = await currentAutonomy();
    const u = pass.understanding;
    const proposal = await ProposalModel.create({
      _id: proposalId,
      signalId,
      signalType: n.type,
      reference: n.reference,
      inputText: n.text,
      status: autonomy === 'advise' ? 'advisory' : 'proposed',
      action: result.duplicate ? 'merge' : 'create',
      draft: result.draft,
      urgencyReason: result.urgencyReason,
      safetyRule: result.safety,
      vendors: result.vendors.top,
      budget: {
        tableNte: result.nte.tableNte,
        available: result.nte.available,
        needsBudgetIncrease: result.nte.needsBudgetIncrease,
        shortfall: result.nte.shortfall,
      },
      duplicate: result.duplicate,
      repeatIssueNote: result.repeatNote,
      trendNote: n.sensor?.trendNote ?? null,
      needsHuman: verdict.needsHuman,
      needsHumanReason: verdict.needsHuman ? verdict.needsHumanReason : null,
      clarifyingQuestion: verdict.needsHuman
        ? (u?.clarifyingQuestion ??
          'Which piece of equipment is this about, and what exactly is wrong?')
        : null,
      confidence: n.sensor ? 1 : (u?.confidence ?? 0),
      checks: verdict.checks,
      excludedVendors: result.vendors.excluded.map(({ name, reason }) => ({ name, reason })),
      modelUsed: pass.understanding ? pass.model : null,
      escalated,
      latencyMs: Date.now() - started,
      usage,
      workOrderId: null,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    });
    await SignalModel.updateOne({ _id: signalId }, { status: 'done', proposalId });
    await logActivity({
      ...ids,
      step: 'propose',
      actor: 'system',
      inputSummary: n.text,
      outputSummary: `${proposal.action === 'merge' ? `Merge into ${result.duplicate?.workOrderNumber}` : 'New work order'}: ${result.draft.title} [${result.draft.urgency}, NTE $${result.draft.nte}]${verdict.needsHuman ? ' — needs human' : ''}`,
      reason:
        autonomy === 'advise'
          ? 'Advise mode: analysis only, cannot be approved'
          : 'Awaiting manager approval',
      latencyMs: proposal.latencyMs,
    });
    return proposal;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await SignalModel.updateOne({ _id: signalId }, { status: 'failed', error: message });
    await logActivity({
      ...ids,
      step: 'propose',
      actor: 'system',
      reason: `Pipeline failed: ${message}`,
    });
    throw err;
  }
}

async function currentAutonomy(): Promise<AutonomyMode> {
  const s = await SettingsModel.findById('global').lean();
  return s?.autonomyMode ?? 'propose';
}

// ---- Step 1 --------------------------------------------------------------------------------

async function normalize(
  signalId: string,
  now: Date,
  ids: { signalId: string; proposalId: string },
): Promise<Normalized> {
  const signal = await SignalModel.findById(signalId).lean();
  if (!signal) throw new SignalInputError(`Unknown signal ${signalId}`);
  const input = signal.input;
  const site = await SiteModel.findById(signal.siteId).lean();
  if (!site) throw new SignalInputError(`Unknown site ${signal.siteId}`);
  const assets = await AssetModel.find({ siteId: site._id }).sort({ _id: 1 }).lean();

  let text: string;
  let sensorAsset: AssetDoc | null = null;
  let sensor: SensorAssessment | null = null;
  if (input.type === 'request') {
    text = input.text;
  } else {
    sensorAsset = assets.find((a) => a._id === input.assetId) ?? null;
    const spec = sensorAsset?.sensor;
    if (!sensorAsset || !spec) throw new SignalInputError(`Asset ${input.assetId} has no sensor`);
    const readingAt = input.readingAt ? new Date(input.readingAt) : now;
    await SensorReadingModel.create({
      assetId: sensorAsset._id,
      siteId: site._id,
      metric: input.metric,
      unit: input.unit,
      value: input.value,
      readingAt,
    });
    const since = new Date(readingAt.getTime() - SENSOR_HISTORY_HOURS * 3_600_000);
    const history = await SensorReadingModel.find({
      assetId: sensorAsset._id,
      readingAt: { $gte: since, $lte: readingAt },
    })
      .sort({ readingAt: 1 })
      .lean();
    sensor = assessSensor(
      spec,
      { at: readingAt, value: input.value },
      history.map((h) => ({ at: h.readingAt, value: h.value })),
    );
    const limit =
      spec.alertAbove !== null
        ? `alert above ${formatValue(spec.alertAbove, spec.unit)}`
        : `alert below ${formatValue(spec.alertBelow as number, spec.unit)}`;
    text = `Sensor reading: ${sensorAsset.name} (${sensorAsset.location}) ${input.metric} is ${formatValue(input.value, spec.unit)}. Normal range ${formatValue(spec.normalMin, spec.unit)} to ${formatValue(spec.normalMax, spec.unit)}, ${limit}.${sensor.trendNote ? ` ${sensor.trendNote}` : ''}`;
  }

  await logActivity({
    ...ids,
    step: 'normalize',
    actor: 'system',
    inputSummary:
      input.type === 'request' ? `Request at ${site.shortName}` : `Sensor ${input.assetId}`,
    outputSummary: text,
    reason: sensor ? `Urgency from data: ${sensor.urgency}. ${sensor.urgencyReason}` : null,
  });
  return {
    signalId,
    reference: signal.reference ?? null,
    type: input.type,
    site,
    assets,
    text,
    sensorAsset,
    sensor,
  };
}

// ---- Step 2 --------------------------------------------------------------------------------

async function understand(
  n: Normalized,
  model: string,
  llm: LlmClient,
  effort: 'low' | 'medium',
  ids: { signalId: string; proposalId: string },
): Promise<Pass> {
  const assetsForPrompt = n.assets.map((a) => ({ id: a._id, name: a.name, location: a.location }));
  try {
    const res = await llm.complete({
      model,
      system: UNDERSTAND_SYSTEM,
      user: understandUserPrompt(n.site.name, assetsForPrompt, n.text),
      schemaName: 'work_order_understanding',
      schema: Understanding,
      reasoningEffort: effort,
    });
    let u = res.data;
    if (n.sensorAsset && n.sensor) {
      // Sensors: asset, trade and urgency come from data; the model only words the summary.
      u = {
        ...u,
        trade: n.sensorAsset.trade,
        assetId: n.sensorAsset._id,
        urgency: n.sensor.urgency,
        urgencyReason: n.sensor.urgencyReason,
        confidence: 1,
        clarifyingQuestion: null,
      };
    }
    await logActivity({
      ...ids,
      step: 'understand',
      actor: `model:${model}`,
      inputSummary: n.text,
      outputSummary: `${u.trade} · ${u.assetId ?? 'no asset'} · ${u.urgency} · confidence ${u.confidence} · "${u.problemSummary}"`,
      reason: u.clarifyingQuestion
        ? `Clarifying question: ${u.clarifyingQuestion}`
        : u.urgencyReason,
      latencyMs: res.latencyMs,
    });
    return { model, understanding: u, llmError: null, usage: res.usage, latencyMs: res.latencyMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (n.sensorAsset && n.sensor) {
      // The data alone is enough for a sensor proposal; don't block on the model.
      const u: Understanding = {
        trade: n.sensorAsset.trade,
        problemSummary: `${n.sensorAsset.name} sensor out of range`,
        assetId: n.sensorAsset._id,
        locationText: n.sensorAsset.location,
        urgency: n.sensor.urgency,
        urgencyReason: n.sensor.urgencyReason,
        confidence: 1,
        clarifyingQuestion: null,
      };
      await logActivity({
        ...ids,
        step: 'understand',
        actor: 'system',
        inputSummary: n.text,
        outputSummary: u.problemSummary,
        reason: `Model unavailable (${message}); sensor summary from template`,
      });
      return { model: 'rules', understanding: u, llmError: null, usage: ZERO_USAGE, latencyMs: 0 };
    }
    await logActivity({
      ...ids,
      step: 'understand',
      actor: `model:${model}`,
      inputSummary: n.text,
      outputSummary: 'No answer',
      reason: message,
    });
    return { model, understanding: null, llmError: message, usage: ZERO_USAGE, latencyMs: 0 };
  }
}

// ---- Steps 3-5 -----------------------------------------------------------------------------

interface PlanResult {
  safety: SafetyRuleHit | null;
  assetValid: boolean;
  assetResolved: boolean;
  duplicate: DuplicateInfo | null;
  duplicateOf: WorkOrderDoc | null;
  repeatNote: string | null;
  draft: WorkOrderDraft;
  urgencyReason: string;
  nte: ReturnType<typeof planNte>;
  vendors: VendorRanking;
  usage: TokenUsage;
}

async function groundAndPlan(
  n: Normalized,
  pass: Pass,
  deps: PipelineDeps,
  now: Date,
  ids: { signalId: string; proposalId: string },
): Promise<PlanResult> {
  const u = pass.understanding;
  let urgency = u?.urgency ?? 'routine';
  let urgencyReason = u ? capitalize(u.urgencyReason) : 'The model could not read this request.';
  let usage = ZERO_USAGE;

  // Step 3: safety rules (code, cannot be overridden).
  const safety = n.type === 'request' ? checkSafety(n.text) : null;
  if (safety) {
    urgency = 'emergency';
    urgencyReason = `Safety rule "${safety.label}" matched "${safety.matchedText}": forced to emergency.`;
  }
  await logActivity({
    ...ids,
    step: 'safety',
    actor: 'system',
    inputSummary:
      n.type === 'request' ? n.text : 'Sensor signal (safety keywords apply to requests)',
    outputSummary: safety ? `Rule ${safety.ruleId} fired → emergency` : 'No safety rule matched',
    reason: safety ? `Matched "${safety.matchedText}"` : null,
  });

  // Step 4: ground in real data.
  const rawAssetId = u?.assetId ?? null;
  const assetValid = rawAssetId === null || n.assets.some((a) => a._id === rawAssetId);
  const assetId = assetValid ? rawAssetId : null;
  // Unresolved = the model named an asset that doesn't exist here, or had to ask which one.
  const assetResolved = u !== null && assetValid && !(assetId === null && u.clarifyingQuestion);
  const trade = u?.trade ?? 'unknown';
  const locationText = u?.locationText || n.assets.find((a) => a._id === assetId)?.location || '';

  let duplicate: DuplicateInfo | null = null;
  let duplicateOf: WorkOrderDoc | null = null;
  const candidates = u
    ? await findDuplicateCandidates({ siteId: n.site._id, assetId, trade, locationText, now })
    : [];
  for (const wo of candidates.slice(0, MAX_DUPLICATE_CHECKS)) {
    try {
      const res = await deps.llm.complete({
        model: pass.model === 'rules' ? deps.models.small : pass.model,
        system: DUPLICATE_SYSTEM,
        user: duplicateUserPrompt(wo, n.text),
        schemaName: 'duplicate_verdict',
        schema: DuplicateVerdict,
        reasoningEffort: 'low',
      });
      usage = addUsage(usage, res.usage);
      await logActivity({
        ...ids,
        step: 'ground',
        actor: `model:${res.model}`,
        workOrderId: wo._id,
        inputSummary: `Same problem as ${wo.number} "${wo.title}"?`,
        outputSummary: res.data.sameProblem ? 'Yes' : 'No',
        reason: res.data.reason,
        latencyMs: res.latencyMs,
      });
      if (res.data.sameProblem) {
        const raise = URGENCY_RANK[urgency] > URGENCY_RANK[wo.urgency];
        duplicateOf = wo;
        duplicate = {
          workOrderId: wo._id,
          workOrderNumber: wo.number,
          reason: res.data.reason,
          urgencyRaised: raise,
        };
        if (!raise)
          urgency = URGENCY_RANK[wo.urgency] > URGENCY_RANK[urgency] ? wo.urgency : urgency;
        break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logActivity({
        ...ids,
        step: 'ground',
        actor: 'system',
        workOrderId: wo._id,
        inputSummary: `Duplicate check vs ${wo.number}`,
        outputSummary: 'Skipped',
        reason: `Model unavailable: ${message}`,
      });
    }
  }

  const repeatNote = assetId ? repeatIssueNote(await recentRepairCount(assetId, now)) : null;
  await logActivity({
    ...ids,
    step: 'ground',
    actor: 'system',
    inputSummary: `asset ${rawAssetId ?? 'none'} · ${candidates.length} duplicate candidate(s)`,
    outputSummary: [
      assetValid
        ? assetId
          ? `Asset ${assetId} verified at ${n.site.shortName}`
          : 'No specific asset'
        : `Asset ${rawAssetId} not found at this site`,
      duplicate ? `Duplicate of ${duplicate.workOrderNumber}` : 'No duplicate',
      repeatNote ?? 'No repeat issue',
    ].join(' · '),
  });

  // Step 5: plan.
  const budgetDoc = await BudgetModel.findById(n.site._id).lean();
  const available = budgetDoc ? budgetDoc.total - budgetDoc.committed - budgetDoc.spent : 0;
  const planTrade: Trade | null = trade === 'unknown' ? null : trade;
  const nte = planTrade
    ? planNte(planTrade, urgency, available)
    : { tableNte: 0, available, nte: 0, needsBudgetIncrease: false, shortfall: 0 };
  const vendorDocs = await VendorModel.find().lean();
  const vendors = planTrade
    ? rankVendors(vendorDocs, n.site, planTrade, urgency, now)
    : { top: [], excluded: [] };

  const summary = u?.problemSummary.trim() ?? '';
  const title = summary ? capitalize(summary) : 'Unclear request: needs review';
  const draft: WorkOrderDraft = {
    siteId: n.site._id,
    assetId,
    trade,
    title: title.slice(0, 200),
    description: n.text,
    locationText,
    urgency,
    nte: nte.nte,
    // A merge keeps the vendor already on the job.
    vendorId: duplicateOf?.vendorId ?? vendors.top[0]?.vendorId ?? null,
  };

  await logActivity({
    ...ids,
    step: 'plan',
    actor: 'system',
    inputSummary: `${trade} · ${urgency} · Available $${available}`,
    outputSummary: `NTE $${nte.nte}${nte.needsBudgetIncrease ? ` (table $${nte.tableNte}, short $${nte.shortfall})` : ''} · top vendors: ${vendors.top.map((v) => v.name).join(', ') || 'none'}`,
    reason: vendors.excluded.length
      ? `Excluded: ${vendors.excluded.map((e) => `${e.name} (${e.reason})`).join('; ')}`
      : null,
  });

  return {
    safety,
    assetValid,
    assetResolved,
    duplicate,
    duplicateOf,
    repeatNote,
    draft,
    urgencyReason,
    nte,
    vendors,
    usage,
  };
}

// ---- Step 6 --------------------------------------------------------------------------------

interface Verdict {
  checks: VerifyCheck[];
  escalate: boolean;
  why: string;
  needsHuman: boolean;
  needsHumanReason: string;
}

export function verify(n: Normalized, pass: Pass, r: PlanResult): Verdict {
  const u = pass.understanding;
  const topVendor = r.vendors.top[0];
  const checks: VerifyCheck[] = [
    {
      name: 'Schema valid',
      passed: u !== null,
      detail: u ? 'Model output matched the schema' : (pass.llmError ?? 'No model output'),
    },
    {
      name: 'Asset resolved',
      passed: r.assetResolved,
      detail: !r.assetValid
        ? `Model named an asset that is not at ${n.site.shortName}`
        : r.assetResolved
          ? (r.draft.assetId ?? 'No specific asset involved')
          : 'Could not tell which asset',
    },
    {
      name: 'Trade known',
      passed: r.draft.trade !== 'unknown',
      detail: r.draft.trade,
    },
    {
      name: 'NTE within Available',
      passed: r.draft.nte <= Math.max(0, r.nte.available) || r.nte.needsBudgetIncrease,
      detail: r.nte.needsBudgetIncrease
        ? `Flagged: needs $${r.nte.shortfall} more`
        : `$${r.draft.nte} of $${r.nte.available}`,
    },
    {
      name: 'Top vendor compliant',
      passed: Boolean(topVendor),
      detail: topVendor ? topVendor.reason : 'No vendor passed the filters',
    },
  ];
  const failed = checks.filter((c) => !c.passed);
  const confidence = n.sensor ? 1 : (u?.confidence ?? 0);
  const lowConfidence = confidence < ESCALATE_BELOW_CONFIDENCE;
  const escalate = lowConfidence || failed.length > 0;
  const why = [
    lowConfidence ? `confidence ${confidence} < ${ESCALATE_BELOW_CONFIDENCE}` : null,
    ...failed.map((c) => `${c.name}: ${c.detail}`),
  ]
    .filter(Boolean)
    .join('; ');

  const reasons: string[] = [];
  if (!u) reasons.push(`The model could not read this request (${pass.llmError ?? 'no output'})`);
  else {
    if (confidence < NEEDS_HUMAN_BELOW_CONFIDENCE) reasons.push(`Low confidence (${confidence})`);
    if (!r.assetResolved) reasons.push('Could not tell which asset this is about');
    if (r.draft.trade === 'unknown') reasons.push('Could not tell what is broken');
  }
  if (r.draft.trade !== 'unknown' && !topVendor)
    reasons.push('No compliant vendor is available in time');
  if (r.draft.trade !== 'unknown' && r.nte.available <= 0)
    reasons.push('Site has no Available budget');
  return {
    checks,
    escalate,
    why,
    needsHuman: reasons.length > 0,
    needsHumanReason: reasons.join('; '),
  };
}
