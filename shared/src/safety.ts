export type RequesterLanguage = 'en' | 'es';

/**
 * What the requester should do right now, keyed by safety rule id (server/src/pipeline/safety.ts).
 * Rules without an entry get the generic 911 note.
 */
const GAS = {
  en: "Leave the area now. Don't use light switches, flames or phones near the smell. Call 911 and your gas utility from outside.",
  es: 'Salga del área ahora. No use interruptores de luz, llamas ni teléfonos cerca del olor. Llame al 911 y a la compañía de gas desde afuera.',
};
const FIRE = {
  en: "Leave the building now and pull the fire alarm on your way out. Don't go back in. Call 911 from outside.",
  es: 'Salga del edificio ahora y active la alarma de incendio al salir. No vuelva a entrar. Llame al 911 desde afuera.',
};
const WATER = {
  en: 'Stay out of standing water and away from outlets or equipment near it. Move people and stock clear if it is safe.',
  es: 'No pise el agua estancada y aléjese de enchufes o equipos cercanos. Aleje a las personas y la mercancía si es seguro hacerlo.',
};
const INJURY = {
  en: "If someone is badly hurt, call 911 now. Don't move them unless they are in danger where they are.",
  es: 'Si alguien está gravemente herido, llame al 911 ahora. No lo mueva a menos que corra peligro donde está.',
};

export const SAFETY_GUIDANCE: Record<string, Record<RequesterLanguage, string>> = {
  gas_smell: GAS,
  alarm: FIRE,
  smoke: FIRE,
  fire: FIRE,
  flooding: WATER,
  water_everywhere: WATER,
  ceiling_leak: WATER,
  injury: INJURY,
};

export const safetyGuidance = (
  ruleId: string | null | undefined,
  lang: RequesterLanguage = 'en',
): string | null => (ruleId && SAFETY_GUIDANCE[ruleId]?.[lang]) || null;

const SPANISH_WORDS = new Set(
  'el la los las del que en por para con una un no hay está esta están se muy baño baños agua cocina funciona sale olor huele puerta luz también hace mucho ayuda favor pero otra vez como donde'.split(
    ' ',
  ),
);
const ENGLISH_WORDS = new Set(
  'the is are in on of and to it a an not there this that with for from by at was has have water room broken leaking smell door light again please'.split(
    ' ',
  ),
);

/** Cheap word-count guess, used only to pick the language of the confirmation page. */
export function detectLanguage(text: string): RequesterLanguage {
  const words = text.toLowerCase().match(/[a-záéíóúñü]+/g) ?? [];
  let es = 0;
  let en = 0;
  for (const w of words) {
    if (SPANISH_WORDS.has(w)) es++;
    if (ENGLISH_WORDS.has(w)) en++;
  }
  if (/[ñáéíóú¿¡]/i.test(text)) es++;
  return es >= 2 && es > en ? 'es' : 'en';
}
