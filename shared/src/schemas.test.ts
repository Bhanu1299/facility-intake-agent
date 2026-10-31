import {
  SignalInput,
  Understanding,
  WorkOrderDraft,
  WorkOrderDraftPatch,
  URGENCIES,
  URGENCY_RANK,
  compareForInbox,
  detectLanguage,
} from './index';

describe('SignalInput', () => {
  it('accepts a request signal', () => {
    const parsed = SignalInput.parse({
      type: 'request',
      siteId: 'site-elmwood',
      text: '  toilet in mens room is clogged  ',
    });
    expect(parsed.type).toBe('request');
    if (parsed.type === 'request') expect(parsed.text).toBe('toilet in mens room is clogged');
  });

  it('accepts a sensor signal', () => {
    const parsed = SignalInput.parse({
      type: 'sensor',
      assetId: 'elmwood-walkin-cooler',
      metric: 'temperature',
      value: 43.5,
      unit: 'F',
      readingAt: '2026-10-30T12:00:00Z',
    });
    expect(parsed.type).toBe('sensor');
  });

  it('rejects unknown types and empty text', () => {
    expect(SignalInput.safeParse({ type: 'email', siteId: 'x', text: 'hi there' }).success).toBe(
      false,
    );
    expect(SignalInput.safeParse({ type: 'request', siteId: 'x', text: '  ' }).success).toBe(false);
  });
});

describe('Understanding', () => {
  it('requires confidence between 0 and 1', () => {
    const base = {
      trade: 'plumbing',
      problemSummary: 'Clogged toilet',
      assetId: null,
      locationText: "men's restroom",
      urgency: 'routine',
      urgencyReason: 'Restroom still usable.',
      clarifyingQuestion: null,
    };
    expect(Understanding.safeParse({ ...base, confidence: 0.9 }).success).toBe(true);
    expect(Understanding.safeParse({ ...base, confidence: 1.2 }).success).toBe(false);
  });
});

describe('WorkOrderDraft', () => {
  it('rejects negative NTE', () => {
    const result = WorkOrderDraft.safeParse({
      siteId: 's',
      assetId: null,
      trade: 'hvac',
      title: 'AC down',
      description: '',
      locationText: 'roof',
      urgency: 'urgent',
      nte: -1,
      vendorId: null,
    });
    expect(result.success).toBe(false);
  });

  it('patch rejects unknown fields and siteId changes', () => {
    expect(WorkOrderDraftPatch.safeParse({ nte: 300 }).success).toBe(true);
    expect(WorkOrderDraftPatch.safeParse({ siteId: 'other' }).success).toBe(false);
    expect(WorkOrderDraftPatch.safeParse({ budget: 1 }).success).toBe(false);
  });
});

describe('urgency ranking', () => {
  it('ranks every urgency, most urgent highest', () => {
    const ranks = URGENCIES.map((u) => URGENCY_RANK[u]);
    expect(ranks).toEqual([3, 2, 1, 0]);
  });
});

describe('compareForInbox', () => {
  const p = (urgency: (typeof URGENCIES)[number], needsHuman: boolean, createdAt: string) => ({
    draft: { urgency },
    needsHuman,
    createdAt,
  });

  it('puts urgency first, then needs-human, then newest', () => {
    const routineNew = p('routine', true, '2026-10-31T12:00:00Z');
    const emergencyOld = p('emergency', false, '2026-10-01T12:00:00Z');
    const urgentPlain = p('urgent', false, '2026-10-31T11:00:00Z');
    const urgentHuman = p('urgent', true, '2026-10-30T11:00:00Z');
    const urgentPlainNewer = p('urgent', false, '2026-10-31T11:30:00Z');
    const low = p('low', true, '2026-10-31T13:00:00Z');
    const sorted = [routineNew, low, urgentPlain, emergencyOld, urgentPlainNewer, urgentHuman].sort(
      compareForInbox,
    );
    expect(sorted).toEqual([
      emergencyOld,
      urgentHuman,
      urgentPlainNewer,
      urgentPlain,
      routineNew,
      low,
    ]);
  });
});

describe('detectLanguage', () => {
  it('spots Spanish requests', () => {
    expect(detectLanguage('El baño de mujeres está inundado')).toBe('es');
    expect(detectLanguage('la puerta de la cocina no cierra')).toBe('es');
    expect(detectLanguage('huele a gas en la cocina')).toBe('es');
  });

  it('keeps English (and short or mixed text) as English', () => {
    expect(detectLanguage('sink leaking bad 2nd floor mens room!!')).toBe('en');
    expect(detectLanguage('no hot water in the kitchen')).toBe('en');
    expect(detectLanguage('fryer down')).toBe('en');
  });
});
