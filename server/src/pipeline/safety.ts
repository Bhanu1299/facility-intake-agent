import type { SafetyRuleHit } from '@fia/shared';

interface SafetyRule {
  id: string;
  label: string;
  patterns: RegExp[];
}

// Clause-bounded proximity: "X ... Y" within one sentence.
const near = (a: string, b: string, gap = 40): RegExp =>
  new RegExp(`\\b(?:${a})\\b[^.!?\\n]{0,${gap}}\\b(?:${b})`, 'i');

/**
 * Keyword rules that FORCE urgency to emergency. They run on the raw text, in code, and the
 * model cannot override them. English and Spanish. Order = priority when several match: most
 * specific first, so "fire door is blocked" reports blocked_exit rather than fire.
 */
export const SAFETY_RULES: SafetyRule[] = [
  {
    id: 'blocked_exit',
    label: "Exit blocked or someone can't get out",
    patterns: [
      /\b(?:can'?t|cannot|can not|unable to)\s+(?:get\s+out|exit|escape|leave the building)\b/i,
      near('exit|fire door|emergency door', 'blocked|locked|jammed|chained|stuck', 30),
      /\btrapped\b|\bstuck (?:in|inside) the (?:walk-?in|freezer|cooler|elevator|bathroom|restroom)\b/i,
      /\b(?:no (?:puede|podemos) salir|salida bloqueada|atrapad[oa]s?)\b/i,
    ],
  },
  {
    id: 'alarm',
    label: 'Fire, smoke or CO alarm',
    patterns: [
      /\b(?:fire|smoke|co|carbon monoxide|gas)\s+(?:alarm|detector)s?\b/i,
      near('alarm', 'going off|sounding|ringing|blaring|beeping', 30),
      /\bcarbon monoxide\b/i,
      /\balarma\b/i,
    ],
  },
  {
    id: 'gas_smell',
    label: 'Gas smell or leak',
    patterns: [
      near('smell\\w*|odou?r|stinks?|reeks?', 'gas'),
      near('gas', 'smell\\w*|odou?r|leak\\w*'),
      /\b(?:huele a gas|olor a gas|fuga de gas)\b/i,
    ],
  },
  {
    id: 'smoke',
    label: 'Smoke',
    patterns: [/\bsmok(?:e|es|ing|y)\b/i, /\bhumo\b/i],
  },
  {
    id: 'fire',
    label: 'Fire or flames',
    // Bare "fire" except "fire up" (starting equipment) and fire door/exit/alarm (own rules).
    patterns: [
      /\bfire\b(?!\s+(?:up|alarm|door|exit)s?\b)/i,
      /\b(?:flames?|on fire|caught fire|burning)\b/i,
      /\b(?:fuego|incendio|llamas)\b/i,
    ],
  },
  {
    id: 'sparks',
    label: 'Sparks or arcing',
    patterns: [/\bspark(?:s|ing|ed)?\b/i, /\barcing\b/i, /\bchispa(?:s|zos)?\b/i],
  },
  {
    id: 'flooding',
    label: 'Flooding',
    patterns: [/\bflood(?:s|ing|ed)?\b/i, /\binunda(?:do|da|ción|cion|ndo)\b/i],
  },
  {
    id: 'water_everywhere',
    label: 'Water pouring or everywhere',
    patterns: [
      near('water', 'pouring|gushing|spraying|everywhere|bursting|burst', 40),
      near('pouring|gushing|spraying', 'water', 20),
      /\b(?:pipe|line)s?\s+(?:burst|bursted|exploded)\b|\bburst\s+pipes?\b/i,
      /\bagua por todas partes\b|\bsale mucha agua\b/i,
    ],
  },
  {
    id: 'ceiling_leak',
    label: 'Ceiling leaking or collapsing',
    patterns: [
      near('ceiling', 'leak\\w*|drip\\w*|pouring|collaps\\w*|caving|fell|falling', 30),
      near('leak\\w*|drip\\w*|pouring|coming', 'ceiling', 30),
      /\b(?:gotea el techo|goteras? del techo|el techo gotea)\b/i,
    ],
  },
  {
    id: 'injury',
    label: 'Someone hurt or injured',
    patterns: [
      /\b(?:hurt|injur(?:ed|y|ies)|bleeding|unconscious|passed out|collapsed|ambulance|911)\b/i,
      /\b(?:herid[oa]s?|lastimad[oa]s?|lesionad[oa]s?)\b/i,
    ],
  },
];

/** Returns the first safety rule that matches, or null. */
export function checkSafety(text: string): SafetyRuleHit | null {
  for (const rule of SAFETY_RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text);
      if (match) return { ruleId: rule.id, label: rule.label, matchedText: match[0] };
    }
  }
  return null;
}
