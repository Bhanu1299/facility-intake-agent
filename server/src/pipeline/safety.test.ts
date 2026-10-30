import { checkSafety, SAFETY_RULES } from './safety';

describe('safety rules force emergency', () => {
  const mustFire: [string, string][] = [
    // gas
    ['I smell gas near the fryers', 'gas_smell'],
    ['It smells like gas in the basement', 'gas_smell'],
    ['strong gas odor by the range', 'gas_smell'],
    ['there is a gas leak in the kitchen', 'gas_smell'],
    ['Huele a gas en la cocina', 'gas_smell'],
    // smoke
    ['Smoke is coming out of the rooftop unit', 'smoke'],
    ['the panel is smoking', 'smoke'],
    ['hay humo en la bodega', 'smoke'],
    // fire
    ['grease fire on the line', 'fire'],
    ['the dumpster is on fire', 'fire'],
    ['flames coming from the fryer', 'fire'],
    ['burning smell from the dishwasher motor', 'fire'],
    ['hay fuego en la freidora', 'fire'],
    // sparks
    ['sparks coming out of the outlet', 'sparks'],
    ['outlet sparked when I plugged in the mixer', 'sparks'],
    ['the breaker panel is arcing', 'sparks'],
    ['salen chispas del enchufe', 'sparks'],
    // flooding
    ['basement is flooding', 'flooding'],
    ['the dish pit flooded overnight', 'flooding'],
    ['el sótano está inundado', 'flooding'],
    // water everywhere / pouring
    ['water everywhere in the mens room', 'water_everywhere'],
    ['water is gushing from under the sink', 'water_everywhere'],
    ['a pipe burst in the back', 'water_everywhere'],
    ['hay agua por todas partes', 'water_everywhere'],
    // ceiling
    ['the ceiling is leaking over table 12', 'ceiling_leak'],
    ['water dripping from the ceiling', 'ceiling_leak'],
    ['part of the ceiling collapsed', 'ceiling_leak'],
    ['el techo gotea en el comedor', 'ceiling_leak'],
    // injury
    ['a server slipped and got hurt', 'injury'],
    ['customer injured by the door', 'injury'],
    ['cook cut his hand, bleeding a lot', 'injury'],
    ['un empleado está herido', 'injury'],
    // blocked exit
    ["we can't get out the back door", 'blocked_exit'],
    ['the fire door is blocked by pallets', 'blocked_exit'],
    ['emergency exit is chained shut', 'blocked_exit'],
    ['someone is trapped in the walk-in', 'blocked_exit'],
    ['no podemos salir por atrás', 'blocked_exit'],
    // alarm
    ['the fire alarm is going off', 'alarm'],
    ['smoke detector keeps beeping in the hallway', 'alarm'],
    ['CO alarm in the basement', 'alarm'],
    ['alarm is blaring and we do not know why', 'alarm'],
    ['suena la alarma', 'alarm'],
  ];

  it.each(mustFire)('"%s" -> %s', (text, ruleId) => {
    const hit = checkSafety(text);
    expect(hit).not.toBeNull();
    expect(hit!.ruleId).toBe(ruleId);
    expect(text.toLowerCase()).toContain(hit!.matchedText.toLowerCase());
  });

  it('matches regardless of case and punctuation', () => {
    expect(checkSafety('SMELLS LIKE GAS!!!')?.ruleId).toBe('gas_smell');
    expect(checkSafety('Water.Everywhere.')).toBeNull(); // sentence break between words
    expect(checkSafety('water... everywhere')).toBeNull();
    expect(checkSafety('water everywhere!!')?.ruleId).toBe('water_everywhere');
  });

  it('every rule has at least one test above', () => {
    const covered = new Set(mustFire.map(([, id]) => id));
    expect(SAFETY_RULES.map((r) => r.id).filter((id) => !covered.has(id))).toEqual([]);
  });
});

describe('safety rules do not fire on ordinary requests', () => {
  const mustNotFire = [
    'fryer wont fire up this morning, display just blinks E5',
    'AC up top for the kitchen is blowing warm, cooks are dying back there',
    'upstairs toilet is overflowing, water on the floor',
    'dishwasher is leaking a little water from the door',
    'the walk-in cooler is warm',
    'Front door lock is sticking',
    'gasket on the cooler is torn',
    'the gas fryer needs a new thermostat',
    'ice machine making very little ice',
    'water heater making popping noises',
    'El inodoro del baño de mujeres está tapado',
    'La máquina de hielo no está haciendo hielo otra vez',
    'we cant get in to the freezer, door froze shut',
    'light fixture flickering in the dining room',
  ];

  it.each(mustNotFire)('"%s" -> no rule', (text) => {
    expect(checkSafety(text)).toBeNull();
  });
});
