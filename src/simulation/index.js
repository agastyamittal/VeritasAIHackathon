// SimulationAdapter (see src/contracts/README.md): building + design inputs + weather conditions ->
// spatial results with units, model name/version, assumptions and input provenance.
import { buildThermalModel } from './model.js';
import { simulate, MODEL_INFO, VENTILATION_GUIDELINE_ACH } from './thermal.js';
import { designDay } from './weather.js';
import { normalizeDesign, OPTIONS, FIXED } from './constructions.js';

export { findImprovements, applyImprovement, findings, candidateChanges } from './optimizer.js';
export { OPTIONS, ORDER, DEFAULT_DESIGN, normalizeDesign, describeOption } from './constructions.js';
export { MODEL_INFO, VENTILATION_GUIDELINE_ACH } from './thermal.js';

export function analyze({ building, design: rawDesign, moves = {}, conditions }) {
  const design = normalizeDesign(rawDesign);
  const day = designDay(conditions, design);
  const model = buildThermalModel(building, design, moves);
  const result = simulate(model, day, design);
  result.provenance = {
    model: `${MODEL_INFO.name} ${MODEL_INFO.version}`,
    kind: 'Simplified physics estimate (not EnergyPlus, not CFD, not AI)',
    building: `${building.id} schema ${building.schemaVersion} (${building.source?.kind ?? 'unknown source'})`,
    timestep: `${result.settings.stepSeconds} s, ${result.settings.days} repeated design days, last day reported`,
    units: { temperature: '°C', energy: 'kWh per design day', power: 'kW', airflow: 'air changes per hour', emissions: 'kg CO2e per design day' },
    inputs: {
      conditions: { ...conditions }, latitude: design.latitude,
      windows: `${OPTIONS.windows[design.windows].label} (U ${OPTIONS.windows[design.windows].u}, SHGC ${OPTIONS.windows[design.windows].shgc})`,
      walls: `${OPTIONS.walls[design.walls].label} (U ${OPTIONS.walls[design.walls].u})`,
      roof: `${OPTIONS.roof[design.roof].label} (U ${OPTIONS.roof[design.roof].u})`,
      floor: `${OPTIONS.floor[design.floor].label} (U ${OPTIONS.floor[design.floor].u})`,
      airtightness: `${OPTIONS.airtightness[design.airtightness].label} (${OPTIONS.airtightness[design.airtightness].ach} ACH)`,
      ventilation: `${FIXED.ventSupplyM3h} m³/h per vent, ${OPTIONS.heatRecovery[design.heatRecovery].label}`,
      setpoints: `heat ${design.heatSetpoint} °C, cool ${design.coolSetpoint} °C`,
      ac: `${OPTIONS.acSize[design.acSize].label} (heat pump, heats and cools), COP ${FIXED.ac.copHeat} heating / ${FIXED.ac.copCool} cooling`,
      grid: `${design.gridKgPerKWh} kg CO2e/kWh (user-set factor)`
    },
    assumptions: [
      ...day.assumptions,
      'Typical U-values and SHGC for each construction choice, not measured values',
      `Thermal mass ${FIXED.massJPerKm2 / 1000} kJ/K per m² floor (ISO 13790 medium); ground ${FIXED.groundC} °C`,
      `People and appliances ${FIXED.internalWm2} W/m², plus ${FIXED.eveningWm2} W/m² from 17:00 to 23:00`,
      'Rooms are well mixed (one temperature each); air moves between rooms through doorways and the stair',
      `Fresh-air guideline ${VENTILATION_GUIDELINE_ACH} air changes per hour`
    ],
    createdAt: new Date().toISOString()
  };
  return { result, day, model, design };
}
