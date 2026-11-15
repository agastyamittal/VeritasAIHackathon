// Design optimization by search: each candidate change is simulated on the winter, mild and summer
// design days and compared with the current design. Nothing is estimated without simulating it.
// Two rankings are kept apart because they trade off: electricity saved, and comfort improved
// (fewer degree-hours outside the setpoints).
import { ORDER, OPTIONS, describeOption, normalizeDesign } from './constructions.js';
import { buildThermalModel, acPlacement } from './model.js';
import { simulate } from './thermal.js';
import { designDay } from './weather.js';

const CATEGORY_NAMES = { windows: 'Windows', walls: 'Walls', roof: 'Roof', floor: 'Ground floor', airtightness: 'Air sealing', heatRecovery: 'Ventilation', acSize: 'AC size' };

function evaluate(building, design, moves, seasonConditions) {
  const model = buildThermalModel(building, design, moves);
  const perSeason = seasonConditions.map(c => simulate(model, designDay(c, design), design).totals);
  const sum = key => perSeason.reduce((s, t) => s + t[key], 0);
  return { electricKWh: sum('electricKWh'), co2Kg: sum('co2Kg'), unmetKh: sum('unmetKh'), perSeason };
}

export function candidateChanges(building, design, moves) {
  const list = [];
  for (const key of Object.keys(ORDER)) {
    const at = ORDER[key].indexOf(design[key]);
    for (const value of ORDER[key].slice(at + 1)) {
      list.push({ kind: 'design', category: key, change: { [key]: value },
        label: `${CATEGORY_NAMES[key]}: ${describeOption(key, design[key])} → ${describeOption(key, value)}` });
    }
  }
  if (design.heatSetpoint > 18) list.push({ kind: 'setpoint', category: 'heatSetpoint', change: { heatSetpoint: design.heatSetpoint - 1 }, label: `Heating setpoint ${design.heatSetpoint} → ${design.heatSetpoint - 1} °C (less comfort)` });
  if (design.coolSetpoint < 27) list.push({ kind: 'setpoint', category: 'coolSetpoint', change: { coolSetpoint: design.coolSetpoint + 1 }, label: `Cooling setpoint ${design.coolSetpoint} → ${design.coolSetpoint + 1} °C (less comfort)` });
  const model = buildThermalModel(building, design, moves);
  for (const device of model.devices.filter(d => d.type === 'ac')) {
    const level = device.zoneId ? Number(device.zoneId.split('-').pop()) : null;
    for (const zone of model.zones.filter(z => (level === null || z.level === level) && z.id !== device.zoneId)) {
      if (model.devices.some(d => d.type === 'ac' && d.zoneId === zone.id)) continue;
      const target = acPlacement(model, zone.id);
      if (!target) continue;
      const home = building.boxes.find(b => b.group === device.group && b.type === 'ac').home;
      list.push({ kind: 'move', category: `move-${device.group}`, group: device.group, moveTo: target,
        offset: target.map((v, k) => Math.round((v - home[k]) * 1000) / 1000),
        label: `Move the floor ${zone.level} AC unit into the ${zone.name.toLowerCase()}` });
    }
  }
  return list;
}

function applyCandidate(design, moves, candidate) {
  if (candidate.kind === 'move') return { design, moves: { ...moves, [candidate.group]: candidate.offset } };
  return { design: normalizeDesign({ ...design, ...candidate.change }), moves };
}

// seasonConditions: the design days to test on (e.g. the winter, mild and summer presets).
export function findImprovements({ building, design, moves = {}, seasonConditions, packageSize = 4 }) {
  const base = evaluate(building, design, moves, seasonConditions);
  const results = candidateChanges(building, design, moves).map(candidate => {
    const applied = applyCandidate(design, moves, candidate);
    const r = evaluate(building, applied.design, applied.moves, seasonConditions);
    return { ...candidate, electricKWh: r.electricKWh, savedKWh: base.electricKWh - r.electricKWh, savedCo2Kg: base.co2Kg - r.co2Kg,
      unmetKh: r.unmetKh, comfortGainKh: base.unmetKh - r.unmetKh };
  });
  // A change that "saves" energy by leaving rooms colder or hotter is a trade-off, not an improvement.
  const tradeoff = r => r.kind === 'setpoint' || r.comfortGainKh < -5;
  const energy = results.filter(r => r.savedKWh > 0.05 && !tradeoff(r)).sort((a, b) => b.savedKWh - a.savedKWh);
  const comfort = results.filter(r => r.comfortGainKh > 1).sort((a, b) => b.comfortGainKh - a.comfortGainKh);
  const tradeoffs = results.filter(r => tradeoff(r) && (r.savedKWh > 0.05 || r.comfortGainKh > 1)).sort((a, b) => b.savedKWh - a.savedKWh);
  // Package: the best energy change per category, plus the best comfort fix, simulated together.
  const chosen = [], used = new Set();
  for (const r of [...energy, ...comfort.slice(0, 1)]) {
    if (used.has(r.category) || chosen.length >= packageSize) continue;
    used.add(r.category); chosen.push(r);
  }
  let pkg = null;
  if (chosen.length) {
    let d = design, m = moves;
    for (const c of chosen) ({ design: d, moves: m } = applyCandidate(d, m, c));
    const r = evaluate(building, d, m, seasonConditions);
    pkg = { changes: chosen.map(c => c.label), candidates: chosen, design: d, moves: m, electricKWh: r.electricKWh,
      savedKWh: base.electricKWh - r.electricKWh, savedCo2Kg: base.co2Kg - r.co2Kg, unmetKh: r.unmetKh, comfortGainKh: base.unmetKh - r.unmetKh };
  }
  return { base, energy, comfort, tradeoffs, package: pkg, seasons: seasonConditions.map(c => c.season), method:
    'Each change simulated on the listed design days and compared with the current design (sum over the days).' };
}

export function applyImprovement(design, moves, candidate) { return applyCandidate(design, moves, candidate); }

// Rule-based findings from one simulation result (not AI). Each finding cites the numbers it is based on.
export function findings(result) {
  const list = [];
  const losses = Object.entries(result.breakdown).map(([k, v]) => [k, v.lossKWh]).filter(([, v]) => v > 0.05).sort((a, b) => b[1] - a[1]);
  const totalLoss = losses.reduce((s, [, v]) => s + v, 0);
  if (losses.length && totalLoss > 1) list.push({ level: 'info', text: `Largest heat loss: ${losses[0][0]} (${losses[0][1].toFixed(1)} kWh/day, ${Math.round(100 * losses[0][1] / totalLoss)}% of losses)` });
  const solar = result.breakdown.solar.gainKWh, cooling = result.totals.coolingKWh;
  if (cooling > 1 && solar > 0.5 * cooling) list.push({ level: 'warn', text: `Sun through windows adds ${solar.toFixed(0)} kWh/day while ${cooling.toFixed(0)} kWh/day of cooling is needed: shading or lower-SHGC glass would help` });
  // Placement: an AC unit in a small room while bigger rooms on its floor have none.
  for (const d of result.devices.filter(x => x.type === 'ac' && !x.outside && x.zoneId)) {
    const home = result.zones.find(z => z.id === d.zoneId);
    const unserved = result.zones.filter(z => z.level === home.level && !z.acUnits && z.area > home.area * 1.5);
    if (unserved.length && unserved.some(z => z.unmetKh > 5)) {
      const area = unserved.reduce((s, z) => s + z.area, 0);
      list.push({ level: 'warn', text: `The AC unit (floor ${home.level}) is in the ${home.name.toLowerCase()} (${home.area.toFixed(0)} m²) while the ${unserved.map(z => z.name.toLowerCase()).join(' and ')} (${area.toFixed(0)} m²) have none: Find improvements tests moving it` });
    }
  }
  for (const z of result.zones) {
    if (!z.acUnits && z.unmetKh > 5) list.push({ level: 'warn', text: `${z.name} (floor ${z.level}) has no AC and is outside the setpoints for ${(z.coldHours + z.hotHours).toFixed(0)} h (${z.minC.toFixed(1)}–${z.maxC.toFixed(1)} °C)` });
    else if (z.unmetKh > 5) list.push({ level: 'warn', text: `${z.name} (floor ${z.level}) is outside the setpoints for ${(z.coldHours + z.hotHours).toFixed(0)} h even with its AC running` });
    if (z.poorlyVentilated) list.push({ level: 'warn', text: `${z.name} (floor ${z.level}) gets ${z.freshAirACH.toFixed(2)} fresh-air changes per hour, under the 0.35 guideline` });
  }
  for (const d of result.devices) if (d.outside) list.push({ level: 'warn', text: `${d.name} (${d.group}) is outside the building and serves no room` });
  const capKW = result.devices.filter(d => d.type === 'ac' && !d.outside).length * OPTIONS.acSize[result.settings.acSize].kw;
  if (capKW > 0 && Math.max(result.totals.peakHeatingKW, result.totals.peakCoolingKW) >= 0.98 * capKW) list.push({ level: 'warn', text: `AC units reach full capacity (${capKW.toFixed(1)} kW): they cannot hold the setpoints on this day` });
  return list;
}
