// Simplified dynamic heat balance (lumped-capacitance zones, explicit time steps), in the spirit of the
// ISO 13790 / ISO 52016 simple methods. Per zone and time step it adds:
//   conduction through walls, windows, doors, roof (outdoor air) and the ground slab (ground temperature);
//   sun through windows (area x glazed fraction x SHGC x facade sunlight) and on opaque surfaces (sol-air);
//   air leakage (air changes scaled by wind and indoor-outdoor temperature difference, more on the windward side);
//   fresh air from HVAC vents (optionally through heat recovery);
//   heat from people and appliances; exchange with neighbouring zones; and AC units as ideal thermostats with
//   a capacity limit (heat pump: heats below the heating setpoint, cools above the cooling setpoint).
// The building is simulated over repeated design days until it settles; the last day is reported.
// This is an engineering estimate for comparing designs. It is not EnergyPlus, CFD, or a prediction from AI.
import { FIXED, OPTIONS } from './constructions.js';
import { weatherAt } from './weather.js';

export const MODEL_INFO = Object.freeze({ name: 'AEROFORM simplified heat balance', version: '1.0', kind: 'physics' });
export const VENTILATION_GUIDELINE_ACH = 0.35; // common residential minimum (ASHRAE 62-1989)
const WIND_FACADE = { N: 'north', E: 'east', S: 'south', W: 'west' };
const CATEGORIES = ['walls', 'windows', 'doors', 'roof', 'floor', 'infiltration', 'ventilation', 'solar', 'internal'];
const SURFACE_CATEGORY = { wall: 'walls', window: 'windows', door: 'doors', roof: 'roof', floor: 'floor' };

// Fresh air (m3/h) per zone from the vents: each vent's air is shared by its zone and the zones open to it on the
// same floor, by floor area. Also used by the EnergyPlus export, so both engines get the same airflow.
export function ventFlows(model) {
  const zones = model.zones, ventM3h = new Float64Array(zones.length);
  for (const d of model.devices) {
    if (d.type !== 'vent' || d.zone < 0) continue;
    const share = [d.zone, ...model.couplings.filter(c => c.kind === 'opening' && (c.a === d.zone || c.b === d.zone)).map(c => c.a === d.zone ? c.b : c.a)];
    const total = share.reduce((s, i) => s + zones[i].area, 0);
    for (const i of share) ventM3h[i] += FIXED.ventSupplyM3h * zones[i].area / total;
  }
  return ventM3h;
}

export function simulate(model, day, design, { days = 3, stepSeconds = 180 } = {}) {
  const zones = model.zones, n = zones.length, dt = stepSeconds;
  const rhoC = FIXED.airJPerKm3;
  const ach0 = OPTIONS.airtightness[design.airtightness].ach;
  const recovery = OPTIONS.heatRecovery[design.heatRecovery].efficiency;
  const windward = WIND_FACADE[day.wind];

  const ventM3h = ventFlows(model);
  const acs = zones.map((_, i) => model.devices.filter(d => d.type === 'ac' && d.zone === i));
  const unitW = OPTIONS.acSize[design.acSize].kw * 1000;
  const heatCap = acs.map(list => list.length * unitW), coolCap = heatCap;
  const windSide = zones.map(z => z.facades.includes(windward) ? 1.25 : 0.9);

  let T = new Float64Array(n).fill((design.heatSetpoint + design.coolSetpoint) / 2);
  const stepsPerDay = Math.round(86400 / dt), total = days * stepsPerDay, record = total - stepsPerDay;
  const out = zones.map(() => ({ hourly: new Float64Array(24), hourlyCount: new Float64Array(24), min: Infinity, max: -Infinity, sum: 0,
    heatJ: 0, coolJ: 0, unmetKh: 0, coldHours: 0, hotHours: 0, achSum: 0, flows: Object.fromEntries(CATEGORIES.map(c => [c, { gain: 0, loss: 0 }])),
    surfaceJ: [] }));
  out.forEach((o, i) => { o.surfaceJ = zones[i].surfaces.map(() => 0); });
  let peakHeat = 0, peakCool = 0;

  for (let s = 0; s < total; s++) {
    const hour = ((s + 0.5) * dt / 3600) % 24;
    const w = weatherAt(day, hour);
    const evening = hour >= 17 && hour < 23;
    const next = new Float64Array(n);
    const recording = s >= record;
    let stepHeat = 0, stepCool = 0;
    for (let i = 0; i < n; i++) {
      const z = zones[i], Ti = T[i], o = out[i];
      const flow = recording ? o.flows : null;
      const add = (category, watts) => { if (flow) { if (watts >= 0) flow[category].gain += watts * dt; else flow[category].loss -= watts * dt; } };
      let q = 0;
      z.surfaces.forEach((surface, k) => {
        const sun = surface.facade === 'ground' ? 0 : w.solar[surface.facade] ?? 0;
        const outside = surface.facade === 'ground' ? FIXED.groundC : w.outdoor;
        let conduction = surface.u * surface.area * (outside - Ti);
        if (surface.type !== 'window' && surface.facade !== 'ground') conduction += surface.u * surface.area * FIXED.solarAbsorptance * FIXED.surfaceResistance * sun;
        q += conduction; add(SURFACE_CATEGORY[surface.type], conduction);
        if (recording) o.surfaceJ[k] += -conduction * dt; // positive = heat leaving
        if (surface.type === 'window') { const solar = surface.area * FIXED.frameFactor * surface.shgc * sun; q += solar; add('solar', solar); }
      });
      const dT = w.outdoor - Ti;
      const ach = ach0 * (0.5 + 0.5 * Math.sqrt((day.windSpeed / 4) ** 2 + Math.abs(dT) / 20)) * windSide[i];
      const infiltration = rhoC * z.volume * ach / 3600 * dT;
      const ventilation = rhoC * ventM3h[i] / 3600 * (1 - recovery) * dT;
      const internal = z.area * (FIXED.internalWm2 + (evening ? FIXED.eveningWm2 : 0));
      q += infiltration + ventilation + internal;
      add('infiltration', infiltration); add('ventilation', ventilation); add('internal', internal);
      for (const c of model.couplings) {
        if (c.a === i) q += c.wPerK * (T[c.b] - Ti); else if (c.b === i) q += c.wPerK * (T[c.a] - Ti);
      }
      const free = Ti + q * dt / z.capacity;
      let heat = 0, cool = 0;
      if (free < design.heatSetpoint && heatCap[i] > 0) heat = Math.min(heatCap[i], (design.heatSetpoint - free) * z.capacity / dt);
      else if (free > design.coolSetpoint && coolCap[i] > 0) cool = Math.min(coolCap[i], (free - design.coolSetpoint) * z.capacity / dt);
      next[i] = free + (heat - cool) * dt / z.capacity;
      if (recording) {
        const h = Math.floor(hour);
        o.hourly[h] += next[i]; o.hourlyCount[h]++;
        o.min = Math.min(o.min, next[i]); o.max = Math.max(o.max, next[i]); o.sum += next[i];
        o.heatJ += heat * dt; o.coolJ += cool * dt; stepHeat += heat; stepCool += cool;
        o.achSum += ach + ventM3h[i] / z.volume;
        const cold = Math.max(0, design.heatSetpoint - 1 - next[i]), hot = Math.max(0, next[i] - design.coolSetpoint - 1);
        o.unmetKh += (cold + hot) * dt / 3600;
        if (cold > 0) o.coldHours += dt / 3600; if (hot > 0) o.hotHours += dt / 3600;
      }
    }
    if (recording) { peakHeat = Math.max(peakHeat, stepHeat); peakCool = Math.max(peakCool, stepCool); }
    T = next;
  }

  const kWh = joules => joules / 3.6e6;
  const breakdown = Object.fromEntries(CATEGORIES.map(c => [c, { gainKWh: kWh(out.reduce((s, o) => s + o.flows[c].gain, 0)), lossKWh: kWh(out.reduce((s, o) => s + o.flows[c].loss, 0)) }]));
  const zoneResults = zones.map((z, i) => {
    const o = out[i];
    const hourly = Array.from(o.hourly, (v, h) => v / Math.max(1, o.hourlyCount[h]));
    return {
      id: z.id, name: z.name, level: z.level, area: z.area, volume: z.volume,
      meanC: o.sum / stepsPerDay, minC: o.min, maxC: o.max, hourlyC: hourly,
      heatingKWh: kWh(o.heatJ), coolingKWh: kWh(o.coolJ), unmetKh: o.unmetKh, coldHours: o.coldHours, hotHours: o.hotHours,
      freshAirACH: o.achSum / stepsPerDay, poorlyVentilated: o.achSum / stepsPerDay < VENTILATION_GUIDELINE_ACH,
      acUnits: acs[i].length,
      surfaces: z.surfaces.map((surface, k) => ({ type: surface.type, facade: surface.facade, area: surface.area, u: surface.u,
        lossKWh: kWh(o.surfaceJ[k]), meanLossWm2: surface.area > 0 ? o.surfaceJ[k] / 86400 / surface.area : 0 }))
    };
  });
  const heatingKWh = zoneResults.reduce((s, z) => s + z.heatingKWh, 0), coolingKWh = zoneResults.reduce((s, z) => s + z.coolingKWh, 0);
  const electricKWh = heatingKWh / FIXED.ac.copHeat + coolingKWh / FIXED.ac.copCool;
  return {
    model: MODEL_INFO,
    season: day.season, weather: { wind: day.wind, windSpeed: day.windSpeed },
    outdoor: { meanC: day.meanOutdoor, minC: Math.min(...day.hours.map(h => h.outdoor)), maxC: Math.max(...day.hours.map(h => h.outdoor)), hourlyC: day.hours.map(h => h.outdoor) },
    zones: zoneResults,
    totals: {
      heatingKWh, coolingKWh, electricKWh, co2Kg: electricKWh * design.gridKgPerKWh,
      peakHeatingKW: peakHeat / 1000, peakCoolingKW: peakCool / 1000,
      unmetKh: zoneResults.reduce((s, z) => s + z.unmetKh, 0)
    },
    breakdown,
    devices: model.devices.map(d => ({ group: d.group, type: d.type, name: d.name, zoneId: d.zoneId, outside: d.zone < 0, position: d.position })),
    settings: { stepSeconds: dt, days, ...design }
  };
}
