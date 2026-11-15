// Construction and system options for the simplified heat-balance model. U-values (W/m2K), solar heat gain
// coefficients and air-change rates are typical published values for each kind of construction, not
// measurements of this house. Every result lists the values it used.

export const OPTIONS = Object.freeze({
  windows: {
    single: { label: 'Single glazing', u: 5.7, shgc: 0.78 },
    double: { label: 'Double glazing', u: 2.8, shgc: 0.7 },
    lowe: { label: 'Double low-e', u: 1.6, shgc: 0.42 },
    triple: { label: 'Triple low-e', u: 0.9, shgc: 0.35 }
  },
  walls: {
    none: { label: 'Uninsulated', u: 1.6 },
    average: { label: 'Partly insulated', u: 0.55 },
    insulated: { label: 'Insulated', u: 0.3 },
    high: { label: 'High insulation', u: 0.16 }
  },
  roof: {
    none: { label: 'Uninsulated', u: 2.0 },
    standard: { label: 'Insulated', u: 0.25 },
    high: { label: 'High insulation', u: 0.12 }
  },
  floor: {
    none: { label: 'Uninsulated slab', u: 0.8 },
    insulated: { label: 'Insulated slab', u: 0.25 }
  },
  // Average natural air changes per hour at moderate wind.
  airtightness: {
    leaky: { label: 'Leaky', ach: 0.9 },
    average: { label: 'Average', ach: 0.45 },
    tight: { label: 'Airtight', ach: 0.15 }
  },
  heatRecovery: {
    none: { label: 'No heat recovery', efficiency: 0 },
    hrv: { label: 'Heat recovery ventilator (75%)', efficiency: 0.75 }
  },
  // Heating and cooling capacity of each AC unit (heat pump).
  acSize: {
    standard: { label: '3.5 kW AC units', kw: 3.5 },
    large: { label: '5 kW AC units', kw: 5 }
  }
});

// Improvement order for the optimizer (worst to best).
export const ORDER = Object.freeze({
  windows: ['single', 'double', 'lowe', 'triple'],
  walls: ['none', 'average', 'insulated', 'high'],
  roof: ['none', 'standard', 'high'],
  floor: ['none', 'insulated'],
  airtightness: ['leaky', 'average', 'tight'],
  heatRecovery: ['none', 'hrv'],
  acSize: ['standard', 'large']
});

export const FIXED = Object.freeze({
  doorU: 2.0,
  partitionU: 2.0,
  interFloorU: 1.2,
  // Air exchange through an open interior opening, per m2, per kelvin of temperature difference.
  openingWPerKm2: 45,
  ventSupplyM3h: 110, // fresh air delivered by each HVAC vent
  groundC: 10, // ground temperature under the slab
  massJPerKm2: 165000, // ISO 13790 "medium" thermal mass, per m2 of floor
  airJPerKm3: 1200, // volumetric heat capacity of air
  internalWm2: 3, // appliances and people, all day
  eveningWm2: 3, // extra 17:00-23:00
  ac: { copHeat: 3.0, copCool: 3.2 }, // typical heat-pump split unit efficiency; capacity is a design option
  solarAbsorptance: 0.6,
  surfaceResistance: 0.04, // outside surface resistance, for sun on walls and roof
  frameFactor: 0.85 // glazed share of a window opening
});

export const DEFAULT_DESIGN = Object.freeze({
  windows: 'double', walls: 'average', roof: 'standard', floor: 'none', airtightness: 'average', heatRecovery: 'none', acSize: 'standard',
  heatSetpoint: 20, coolSetpoint: 25,
  gridKgPerKWh: 0.38, // example grid emission factor; set your own grid's value
  latitude: 45
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export function normalizeDesign(value = {}) {
  const d = { ...DEFAULT_DESIGN };
  for (const key of Object.keys(OPTIONS)) if (Object.hasOwn(OPTIONS[key], value?.[key])) d[key] = value[key];
  if (Number.isFinite(value?.heatSetpoint)) d.heatSetpoint = clamp(Math.round(value.heatSetpoint * 2) / 2, 15, 24);
  if (Number.isFinite(value?.coolSetpoint)) d.coolSetpoint = clamp(Math.round(value.coolSetpoint * 2) / 2, 22, 30);
  if (d.coolSetpoint < d.heatSetpoint + 2) d.coolSetpoint = d.heatSetpoint + 2;
  if (Number.isFinite(value?.gridKgPerKWh)) d.gridKgPerKWh = clamp(value.gridKgPerKWh, 0, 1.5);
  if (Number.isFinite(value?.latitude)) d.latitude = clamp(value.latitude, -66, 66);
  return d;
}
export const describeOption = (key, option) => OPTIONS[key]?.[option]?.label ?? option;
