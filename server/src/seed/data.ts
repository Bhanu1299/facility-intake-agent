import type { AssetType, SensorSpec, Trade, Urgency } from '@fia/shared';

/** Fictional restaurant chain. Addresses and coordinates are approximate and made up. */
export const COMPANY_NAME = 'Harbor & Hearth Kitchen';

export interface SiteDef {
  id: string;
  shortName: string;
  address: string;
  lat: number;
  lng: number;
  hours: string;
  /** Restrooms on the 2nd floor (only Elmwood has an upstairs dining room). */
  twoFloors: boolean;
  budgetTotal: number;
  /** Available budget the seed should leave after open commitments and spend. */
  targetAvailable: number;
}

export const SITES: SiteDef[] = [
  {
    id: 'elmwood',
    shortName: 'Elmwood',
    address: '812 Elmwood Ave, Buffalo, NY 14222',
    lat: 42.9265,
    lng: -78.8774,
    hours: 'Mon–Thu 11:00–22:00 · Fri–Sat 11:00–23:00 · Sun 10:00–21:00',
    twoFloors: true,
    budgetTotal: 40000,
    targetAvailable: 9800,
  },
  {
    id: 'canalside',
    shortName: 'Canalside',
    address: '95 Lakefront Blvd, Buffalo, NY 14202',
    lat: 42.8771,
    lng: -78.8792,
    hours: 'Daily 11:00–23:00',
    twoFloors: false,
    budgetTotal: 45000,
    targetAvailable: 12400,
  },
  {
    id: 'hertel',
    shortName: 'Hertel',
    address: '1438 Hertel Ave, Buffalo, NY 14216',
    lat: 42.9478,
    lng: -78.8547,
    hours: 'Tue–Sun 11:30–22:00 · Closed Mon',
    twoFloors: false,
    budgetTotal: 30000,
    targetAvailable: 6100,
  },
  {
    id: 'amherst',
    shortName: 'Amherst',
    address: '4120 Maple Rd, Amherst, NY 14226',
    lat: 42.9946,
    lng: -78.7948,
    hours: 'Daily 11:00–22:00',
    twoFloors: false,
    budgetTotal: 35000,
    targetAvailable: 8300,
  },
  {
    id: 'cheektowaga',
    shortName: 'Cheektowaga',
    address: '2055 Walden Ave, Cheektowaga, NY 14225',
    lat: 42.9068,
    lng: -78.7593,
    hours: 'Daily 10:30–21:30',
    twoFloors: false,
    // Nearly out of budget so the "needs budget increase" path triggers.
    budgetTotal: 20000,
    targetAvailable: 350,
  },
];

export const SENSOR_SPECS: Partial<Record<AssetType, SensorSpec>> = {
  walkin_cooler: {
    metric: 'temperature',
    unit: 'F',
    normalMin: 35,
    normalMax: 38,
    alertAbove: 41,
    alertBelow: null,
  },
  walkin_freezer: {
    metric: 'temperature',
    unit: 'F',
    normalMin: -10,
    normalMax: 0,
    alertAbove: 5,
    alertBelow: null,
  },
  rooftop_ac: {
    metric: 'vibration',
    unit: 'mm/s',
    normalMin: 0,
    normalMax: 5,
    alertAbove: 7,
    alertBelow: null,
  },
  water_heater: {
    metric: 'temperature',
    unit: 'F',
    normalMin: 120,
    normalMax: 140,
    alertAbove: null,
    alertBelow: 110,
  },
};

export interface AssetTemplate {
  key: string;
  name: string;
  type: AssetType;
  trade: Trade;
  location: (site: SiteDef) => string;
}

export const ASSET_TEMPLATES: AssetTemplate[] = [
  {
    key: 'walkin-cooler',
    name: 'Walk-in cooler',
    type: 'walkin_cooler',
    trade: 'refrigeration',
    location: () => 'Back of kitchen, behind the prep line',
  },
  {
    key: 'walkin-freezer',
    name: 'Walk-in freezer',
    type: 'walkin_freezer',
    trade: 'refrigeration',
    location: () => 'Back of kitchen, next to the walk-in cooler',
  },
  {
    key: 'rtu-1',
    name: 'Rooftop AC unit 1',
    type: 'rooftop_ac',
    trade: 'hvac',
    location: () => 'Roof, north side (serves dining room)',
  },
  {
    key: 'rtu-2',
    name: 'Rooftop AC unit 2',
    type: 'rooftop_ac',
    trade: 'hvac',
    location: () => 'Roof, south side (serves kitchen)',
  },
  {
    key: 'fryer',
    name: 'Fryer',
    type: 'fryer',
    trade: 'electrical',
    location: () => 'Cook line, station 2',
  },
  {
    key: 'dishwasher',
    name: 'Dishwasher',
    type: 'dishwasher',
    trade: 'plumbing',
    location: () => 'Dish pit, back of kitchen',
  },
  {
    key: 'ice-machine',
    name: 'Ice machine',
    type: 'ice_machine',
    trade: 'refrigeration',
    location: () => 'Beverage station behind the bar',
  },
  {
    key: 'water-heater',
    name: 'Water heater',
    type: 'water_heater',
    trade: 'plumbing',
    location: () => 'Basement mechanical room',
  },
  {
    key: 'restroom-mens',
    name: "Men's restroom fixtures",
    type: 'restroom',
    trade: 'plumbing',
    location: (s) =>
      s.twoFloors ? "2nd floor men's restroom" : "1st floor men's restroom, off the dining room",
  },
  {
    key: 'restroom-womens',
    name: "Women's restroom fixtures",
    type: 'restroom',
    trade: 'plumbing',
    location: (s) =>
      s.twoFloors
        ? "2nd floor women's restroom"
        : "1st floor women's restroom, off the dining room",
  },
  {
    key: 'front-door',
    name: 'Front door',
    type: 'front_door',
    trade: 'handyman',
    location: () => 'Main entrance',
  },
];

const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export interface VendorDef {
  id: string;
  name: string;
  trades: Trade[];
  lat: number;
  lng: number;
  rating: number;
  performanceScore: number;
  hourlyRate: number;
  phone: string;
  /** Insurance expiry relative to seed time, in days (negative = already expired). */
  insuranceDays: number;
  emergency24x7: boolean;
  windows: { days: number[]; start: string; end: string }[];
  /** Fully booked for this many hours from seed time (0 = open now). */
  bookedHours: number;
}

/** 13 fictional vendors across the 6 trades. Two have expired insurance. */
export const VENDORS: VendorDef[] = [
  {
    id: 'v-lakeshore-plumbing',
    name: 'Lakeshore Plumbing Co.',
    trades: ['plumbing'],
    lat: 42.8865,
    lng: -78.8665,
    rating: 4.7,
    performanceScore: 91,
    hourlyRate: 95,
    phone: '(716) 555-0141',
    insuranceDays: 520,
    emergency24x7: true,
    windows: [{ days: ALL_DAYS, start: '00:00', end: '23:59' }],
    bookedHours: 0,
  },
  {
    id: 'v-queen-city-drain',
    name: 'Queen City Drain & Pipe',
    trades: ['plumbing'],
    lat: 42.9612,
    lng: -78.8203,
    rating: 4.3,
    performanceScore: 78,
    hourlyRate: 85,
    phone: '(716) 555-0177',
    insuranceDays: 210,
    emergency24x7: false,
    windows: [{ days: [1, 2, 3, 4, 5, 6], start: '07:00', end: '19:00' }],
    bookedHours: 0,
  },
  {
    id: 'v-niagara-frontier-hvac',
    name: 'Niagara Frontier HVAC',
    trades: ['hvac'],
    lat: 42.9401,
    lng: -78.8131,
    rating: 4.8,
    performanceScore: 93,
    hourlyRate: 120,
    phone: '(716) 555-0102',
    insuranceDays: 300,
    emergency24x7: true,
    windows: [{ days: ALL_DAYS, start: '00:00', end: '23:59' }],
    bookedHours: 0,
  },
  {
    id: 'v-erie-air',
    name: 'Erie Air Mechanical',
    trades: ['hvac'],
    lat: 42.8998,
    lng: -78.8475,
    rating: 4.1,
    performanceScore: 72,
    hourlyRate: 105,
    phone: '(716) 555-0119',
    // Expired insurance: the compliance filter must exclude this vendor.
    insuranceDays: -18,
    emergency24x7: false,
    windows: [{ days: WEEKDAYS, start: '07:00', end: '17:00' }],
    bookedHours: 0,
  },
  {
    id: 'v-skyline-mechanical',
    name: 'Skyline Mechanical Services',
    trades: ['hvac', 'refrigeration'],
    lat: 42.9852,
    lng: -78.7322,
    rating: 4.5,
    performanceScore: 86,
    hourlyRate: 115,
    phone: '(716) 555-0158',
    insuranceDays: 140,
    emergency24x7: false,
    windows: [{ days: WEEKDAYS, start: '06:00', end: '20:00' }],
    bookedHours: 0,
  },
  {
    id: 'v-coldline-refrigeration',
    name: 'ColdLine Refrigeration',
    trades: ['refrigeration'],
    lat: 42.9154,
    lng: -78.7781,
    rating: 4.9,
    performanceScore: 95,
    hourlyRate: 135,
    phone: '(716) 555-0133',
    insuranceDays: 410,
    emergency24x7: true,
    windows: [{ days: ALL_DAYS, start: '00:00', end: '23:59' }],
    bookedHours: 0,
  },
  {
    id: 'v-polar-point',
    name: 'Polar Point Commercial Refrigeration',
    trades: ['refrigeration'],
    lat: 42.8702,
    lng: -78.8251,
    rating: 4.4,
    performanceScore: 84,
    hourlyRate: 115,
    phone: '(716) 555-0164',
    insuranceDays: 95,
    emergency24x7: false,
    windows: [{ days: WEEKDAYS, start: '07:00', end: '18:00' }],
    // Booked solid for 3 days: fine for routine work, filtered out for urgent/emergency.
    bookedHours: 72,
  },
  {
    id: 'v-frost-belt',
    name: 'Frost Belt Ice & Cooling',
    trades: ['refrigeration'],
    lat: 42.9531,
    lng: -78.8889,
    rating: 4.0,
    performanceScore: 69,
    hourlyRate: 99,
    phone: '(716) 555-0185',
    // Expired insurance.
    insuranceDays: -104,
    emergency24x7: true,
    windows: [{ days: ALL_DAYS, start: '00:00', end: '23:59' }],
    bookedHours: 0,
  },
  {
    id: 'v-bright-circuit',
    name: 'Bright Circuit Electric',
    trades: ['electrical'],
    lat: 42.9033,
    lng: -78.8657,
    rating: 4.6,
    performanceScore: 88,
    hourlyRate: 110,
    phone: '(716) 555-0110',
    insuranceDays: 260,
    emergency24x7: true,
    windows: [{ days: ALL_DAYS, start: '00:00', end: '23:59' }],
    bookedHours: 0,
  },
  {
    id: 'v-allentown-electric',
    name: 'Allentown Electrical Services',
    trades: ['electrical'],
    lat: 42.8991,
    lng: -78.8771,
    rating: 4.2,
    performanceScore: 80,
    hourlyRate: 95,
    phone: '(716) 555-0126',
    insuranceDays: 75,
    emergency24x7: false,
    windows: [{ days: WEEKDAYS, start: '08:00', end: '17:00' }],
    bookedHours: 0,
  },
  {
    id: 'v-fixit-fred',
    name: "Fix-It Fred's Handyman",
    trades: ['handyman'],
    lat: 42.9312,
    lng: -78.8524,
    rating: 4.5,
    performanceScore: 85,
    hourlyRate: 65,
    phone: '(716) 555-0192',
    insuranceDays: 330,
    emergency24x7: false,
    windows: [{ days: [1, 2, 3, 4, 5, 6], start: '08:00', end: '18:00' }],
    bookedHours: 0,
  },
  {
    id: 'v-two-rivers',
    name: 'Two Rivers Facility Services',
    trades: ['handyman', 'plumbing'],
    lat: 42.9721,
    lng: -78.7605,
    rating: 4.0,
    performanceScore: 74,
    hourlyRate: 70,
    phone: '(716) 555-0148',
    insuranceDays: 180,
    emergency24x7: true,
    windows: [{ days: ALL_DAYS, start: '00:00', end: '23:59' }],
    bookedHours: 0,
  },
  {
    id: 'v-great-lakes-pest',
    name: 'Great Lakes Pest Solutions',
    trades: ['pest_control'],
    lat: 42.9188,
    lng: -78.8302,
    rating: 4.6,
    performanceScore: 90,
    hourlyRate: 80,
    phone: '(716) 555-0171',
    insuranceDays: 450,
    emergency24x7: false,
    windows: [{ days: [1, 2, 3, 4, 5, 6], start: '06:00', end: '20:00' }],
    bookedHours: 0,
  },
];

export interface HistoryTemplate {
  title: string;
  description: string;
  urgency: Urgency;
  /** Invoiced cost range in USD. */
  cost: [number, number];
}

/** Realistic closed-work-order templates per asset type. Trade comes from the asset. */
export const HISTORY_TEMPLATES: Record<AssetType, HistoryTemplate[]> = {
  walkin_cooler: [
    {
      title: 'Walk-in cooler running warm',
      description: 'Replaced failed evaporator fan motor; temp back to 36°F.',
      urgency: 'urgent',
      cost: [380, 690],
    },
    {
      title: 'Walk-in cooler door not sealing',
      description: 'Replaced torn door gasket and adjusted hinges.',
      urgency: 'routine',
      cost: [160, 320],
    },
    {
      title: 'Ice build-up on cooler evaporator',
      description: 'Cleared ice, replaced defrost timer.',
      urgency: 'routine',
      cost: [220, 390],
    },
  ],
  walkin_freezer: [
    {
      title: 'Walk-in freezer above 0°F',
      description: 'Low refrigerant; found and brazed leak, recharged.',
      urgency: 'urgent',
      cost: [520, 1200],
    },
    {
      title: 'Freezer door heater strip failed',
      description: 'Door frozen shut overnight; replaced heater strip.',
      urgency: 'routine',
      cost: [180, 340],
    },
  ],
  rooftop_ac: [
    {
      title: 'RTU quarterly filter and belt service',
      description: 'Replaced filters and worn belt, checked refrigerant.',
      urgency: 'low',
      cost: [150, 260],
    },
    {
      title: 'RTU not cooling',
      description: 'Replaced failed condenser fan capacitor.',
      urgency: 'urgent',
      cost: [280, 540],
    },
    {
      title: 'RTU rattling on roof',
      description: 'Tightened loose blower housing, replaced motor mount.',
      urgency: 'routine',
      cost: [190, 360],
    },
  ],
  fryer: [
    {
      title: 'Fryer not heating',
      description: 'Replaced high-limit switch.',
      urgency: 'urgent',
      cost: [240, 450],
    },
    {
      title: 'Fryer thermostat inaccurate',
      description: 'Calibrated thermostat, replaced probe.',
      urgency: 'routine',
      cost: [150, 280],
    },
  ],
  dishwasher: [
    {
      title: 'Dishwasher not draining',
      description: 'Cleared food debris from drain line and pump.',
      urgency: 'urgent',
      cost: [160, 320],
    },
    {
      title: 'Dishwasher rinse temp low',
      description: 'Replaced booster heater element.',
      urgency: 'urgent',
      cost: [260, 480],
    },
    {
      title: 'Dishwasher leaking at door',
      description: 'Replaced door gasket.',
      urgency: 'routine',
      cost: [120, 220],
    },
  ],
  ice_machine: [
    {
      title: 'Ice machine not making ice',
      description: 'Replaced water inlet valve.',
      urgency: 'routine',
      cost: [210, 380],
    },
    {
      title: 'Ice machine slow harvest',
      description: 'Descaled evaporator, cleaned condenser.',
      urgency: 'routine',
      cost: [170, 290],
    },
  ],
  water_heater: [
    {
      title: 'No hot water at hand sinks',
      description: 'Replaced thermocouple and relit pilot.',
      urgency: 'urgent',
      cost: [180, 360],
    },
    {
      title: 'Water heater annual flush',
      description: 'Flushed tank, inspected anode rod.',
      urgency: 'low',
      cost: [140, 220],
    },
  ],
  restroom: [
    {
      title: 'Toilet clogged',
      description: 'Augered toilet, cleared blockage.',
      urgency: 'routine',
      cost: [110, 210],
    },
    {
      title: 'Sink faucet dripping',
      description: 'Replaced faucet cartridge.',
      urgency: 'low',
      cost: [90, 170],
    },
    {
      title: 'Urinal flush valve stuck',
      description: 'Rebuilt flush valve diaphragm.',
      urgency: 'routine',
      cost: [120, 230],
    },
  ],
  front_door: [
    {
      title: 'Front door closer leaking oil',
      description: 'Replaced hydraulic door closer.',
      urgency: 'routine',
      cost: [140, 260],
    },
    {
      title: 'Front door lock sticking',
      description: 'Lubricated and re-aligned strike plate.',
      urgency: 'low',
      cost: [80, 150],
    },
  ],
};

/** Asset that must show the repeat-issue note (3 repairs in the last 90 days). */
export const REPEAT_ISSUE_ASSET_ID = 'hertel-ice-machine';

/** Sensors seeded with a rising trend toward their alert threshold. */
export const TRENDING_SENSORS: Record<string, { from: number; to: number; overDays: number }> = {
  'amherst-walkin-cooler': { from: 36.8, to: 39.6, overDays: 5 },
  'canalside-rtu-1': { from: 3.2, to: 6.1, overDays: 7 },
};

export interface OpenWorkOrderDef {
  siteId: string;
  assetKey: string | null;
  trade: Trade;
  title: string;
  description: string;
  locationText: string;
  urgency: Urgency;
  hoursAgo: number;
  vendorId: string;
}

/** Open work orders for duplicate detection. The last one is outside the 72h window on purpose. */
export const OPEN_WORK_ORDERS: OpenWorkOrderDef[] = [
  {
    siteId: 'elmwood',
    assetKey: 'restroom-mens',
    trade: 'plumbing',
    title: "Toilet running constantly in men's room",
    description:
      'Staff report the toilet in the 2nd floor men’s room keeps running after flushing.',
    locationText: "2nd floor men's restroom",
    urgency: 'routine',
    hoursAgo: 20,
    vendorId: 'v-lakeshore-plumbing',
  },
  {
    siteId: 'canalside',
    assetKey: 'rtu-1',
    trade: 'hvac',
    title: 'Rooftop AC unit 1 making loud rattling noise',
    description: 'Loud rattle from the roof above the dining room when the AC kicks on.',
    locationText: 'Roof, north side',
    urgency: 'urgent',
    hoursAgo: 30,
    vendorId: 'v-niagara-frontier-hvac',
  },
  {
    siteId: 'hertel',
    assetKey: 'dishwasher',
    trade: 'plumbing',
    title: 'Dishwasher not draining',
    description: 'Standing water in the dishwasher after each cycle.',
    locationText: 'Dish pit',
    urgency: 'urgent',
    hoursAgo: 10,
    vendorId: 'v-queen-city-drain',
  },
  {
    siteId: 'amherst',
    assetKey: 'front-door',
    trade: 'handyman',
    title: 'Front door slams shut, closer broken',
    description: 'Door closer arm detached; door slams in the wind.',
    locationText: 'Main entrance',
    urgency: 'routine',
    hoursAgo: 48,
    vendorId: 'v-fixit-fred',
  },
  {
    siteId: 'elmwood',
    assetKey: null,
    trade: 'pest_control',
    title: 'Fruit flies around bar floor drain',
    description: 'Fruit flies near the bar floor drain, worse in the evening.',
    locationText: 'Bar, floor drain behind the bar',
    urgency: 'low',
    hoursAgo: 40,
    vendorId: 'v-great-lakes-pest',
  },
  {
    siteId: 'cheektowaga',
    assetKey: 'walkin-cooler',
    trade: 'refrigeration',
    title: 'Walk-in cooler door gasket torn',
    description: 'Gasket torn along the bottom of the walk-in cooler door.',
    locationText: 'Back of kitchen',
    urgency: 'routine',
    hoursAgo: 120,
    vendorId: 'v-coldline-refrigeration',
  },
];
