/**
 * What the requester should do right now, keyed by safety rule id (server/src/pipeline/safety.ts).
 * Rules without an entry get the generic 911 note.
 */
const GAS =
  "Leave the area now. Don't use light switches, flames or phones near the smell. Call 911 and your gas utility from outside.";
const FIRE =
  "Leave the building now and pull the fire alarm on your way out. Don't go back in. Call 911 from outside.";
const WATER =
  'Stay out of standing water and away from outlets or equipment near it. Move people and stock clear if it is safe.';
const INJURY =
  "If someone is badly hurt, call 911 now. Don't move them unless they are in danger where they are.";

export const SAFETY_GUIDANCE: Record<string, string> = {
  gas_smell: GAS,
  alarm: FIRE,
  smoke: FIRE,
  fire: FIRE,
  flooding: WATER,
  water_everywhere: WATER,
  ceiling_leak: WATER,
  injury: INJURY,
};

export const GENERIC_SAFETY_NOTE = 'If anyone is in danger, call 911.';

export const safetyGuidance = (ruleId: string | null | undefined): string | null =>
  (ruleId && SAFETY_GUIDANCE[ruleId]) || null;
