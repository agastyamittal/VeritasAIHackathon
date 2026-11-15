// Inputs and outputs of the energy surrogate models (src/energy-surrogate.js), defined once so the dataset
// generator (training/generate-sim-dataset.mjs) and the app compute exactly the same numbers.
// The surrogates are trained on the AEROFORM demo house only: 6 zones (3 rooms x 2 floors). Construction
// options enter as their physical values (U-value, SHGC, air changes...), and HVAC placement as the number
// of AC units and vents in each zone, wherever they have been moved.
import { OPTIONS, normalizeDesign } from './constructions.js';
import { buildThermalModel } from './model.js';
import { designDay } from './weather.js';

export const SURROGATE_ZONES = Object.freeze(['living-1', 'bedroom-1', 'hall-1', 'living-2', 'bedroom-2', 'hall-2']);
const SEASON_KEYS = ['winter', 'mild', 'summer'], WIND_KEYS = ['N', 'E', 'S', 'W'];

export const FEATURE_NAMES = Object.freeze([
  'window_u', 'window_shgc', 'wall_u', 'roof_u', 'floor_u', 'air_changes', 'heat_recovery', 'ac_kw',
  'heat_setpoint', 'cool_setpoint', 'latitude',
  ...SEASON_KEYS.map(s => `season_${s}`), 'outdoor_mean_c', ...WIND_KEYS.map(w => `wind_${w}`), 'wind_speed',
  ...SURROGATE_ZONES.map(z => `ac_${z}`), ...SURROGATE_ZONES.map(z => `vent_${z}`)
]);
export const TOTAL_TARGETS = Object.freeze(['heating_kwh', 'cooling_kwh', 'peak_heating_kw', 'peak_cooling_kw', 'unmet_kh']);
export const TARGET_NAMES = Object.freeze([
  ...TOTAL_TARGETS,
  ...SURROGATE_ZONES.flatMap(z => [`min_c_${z}`, `max_c_${z}`]),
  ...SURROGATE_ZONES.flatMap(z => Array.from({ length: 24 }, (_, h) => `t_${z}_${String(h).padStart(2, '0')}`))
]);

// Building must be the demo house (same zone ids); returns null otherwise.
export function surrogateFeatures({ building, design: rawDesign, moves = {}, conditions }) {
  const design = normalizeDesign(rawDesign);
  const model = buildThermalModel(building, design, moves);
  if (model.zones.length !== SURROGATE_ZONES.length || model.zones.some((z, i) => z.id !== SURROGATE_ZONES[i])) return null;
  const season = designDay(conditions, design).season;
  const count = type => SURROGATE_ZONES.map((_, i) => model.devices.filter(d => d.type === type && d.zone === i).length);
  return [
    OPTIONS.windows[design.windows].u, OPTIONS.windows[design.windows].shgc, OPTIONS.walls[design.walls].u,
    OPTIONS.roof[design.roof].u, OPTIONS.floor[design.floor].u, OPTIONS.airtightness[design.airtightness].ach,
    OPTIONS.heatRecovery[design.heatRecovery].efficiency, OPTIONS.acSize[design.acSize].kw,
    design.heatSetpoint, design.coolSetpoint, design.latitude,
    ...SEASON_KEYS.map(s => +(season === s)), conditions.temperature, ...WIND_KEYS.map(w => +(conditions.wind === w)), conditions.windSpeed,
    ...count('ac'), ...count('vent')
  ];
}

// The same targets from a full result (simplified model or EnergyPlus), in TARGET_NAMES order.
export function surrogateTargets(result) {
  const t = result.totals;
  return [
    t.heatingKWh, t.coolingKWh, t.peakHeatingKW, t.peakCoolingKW, t.unmetKh,
    ...result.zones.flatMap(z => [z.minC, z.maxC]),
    ...result.zones.flatMap(z => z.hourlyC)
  ];
}
