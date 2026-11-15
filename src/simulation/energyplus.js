// EnergyPlus adapter, pure part: writes the building + design + weather as an EnergyPlus input file (IDF) and
// reads EnergyPlus's CSV output back into the same result shape as the simplified heat balance. It does not
// run EnergyPlus (that needs the energyplus executable; see training/energyplus/run-energyplus.mjs), so it
// can be imported anywhere, including the browser and the tests.
//
// What is the same as the simplified model: the geometry (zones, windows, door, footprint, storeys), U-values
// and SHGC of each construction option, ground temperature, internal gains schedule, vent fresh air per zone,
// heat recovery, AC capacity per zone, thermostat setpoints, doorway and stair air exchange rates, latitude,
// design day date, outdoor temperature, wind and clear-sky sun. What EnergyPlus does itself: transient
// conduction through layered constructions (CTF), surface heat balances with long-wave exchange, convection
// coefficients, sun position and window optics, infiltration from its own wind/temperature formula, and
// ideal-loads HVAC. So results differ from the simplified model by design; that difference is the point.
import { OPTIONS, FIXED } from './constructions.js';
import { buildThermalModel, exteriorEdges } from './model.js';
import { ventFlows } from './thermal.js';
import { designDay } from './weather.js';
import { normalizeDesign } from './constructions.js';

export const ENERGYPLUS_VERSION = '26.2';
export const ADAPTER_INFO = Object.freeze({ name: 'AEROFORM EnergyPlus adapter', version: '1.0', energyPlus: ENERGYPLUS_VERSION });
const TIMESTEPS_PER_HOUR = 20; // 3 minutes, same as the simplified model
const WINDOW_CENTRE = 1.85; // window centre height above each floor (src/building.js)
const AIR_W_PER_M3K = 1206; // rho * cp of air, to turn W/K exchange coefficients into m3/s
const EPS = 1e-6;
const WIND_DEGREES = { N: 0, E: 90, S: 180, W: 270 };
const FILMS = { wallIn: 0.13, out: 0.04, upIn: 0.10, downIn: 0.17 }; // ISO 6946 surface resistances, m2K/W
const GYPSUM = { k: 0.16, thick: 0.0125 }, CONCRETE = { k: 1.7, thick: 0.15 };

const num = v => Number.isInteger(v) ? String(v) : Number(v.toFixed(6)).toString();
const obj = (type, ...fields) => `${type},\n${fields.map((f, i) => `  ${f === null || f === undefined ? '' : typeof f === 'number' ? num(f) : f}${i === fields.length - 1 ? ';' : ','}`).join('\n')}\n`;
const overlap = (a0, a1, b0, b1) => [Math.max(a0, b0), Math.min(a1, b1)];

// Our plan coordinates are x east, z south (north is -z), y up. EnergyPlus: X east, Y north, Z up.
const toEp = (x, z, y) => [x, -z, y];

// A vertical rectangle between plan points p and q, from height y0 to y1, facing outward along plan normal n.
// EnergyPlus wants vertices counter-clockwise seen from outside, starting at the upper left corner.
function vertical(p, q, n, y0, y1) {
  const [nx, ny] = [n[0], -n[1]]; // outward normal in EnergyPlus X/Y
  const right = [-ny, nx];        // the viewer's right when looking at the surface from outside
  const P = toEp(p[0], p[1], 0), Q = toEp(q[0], q[1], 0);
  const [L, R] = P[0] * right[0] + P[1] * right[1] <= Q[0] * right[0] + Q[1] * right[1] ? [P, Q] : [Q, P];
  return [[L[0], L[1], y1], [L[0], L[1], y0], [R[0], R[1], y0], [R[0], R[1], y1]];
}
// Horizontal rectangle [x0, x1, z0, z1] at height y, facing up (ceiling/roof) or down (floor).
function horizontal([x0, x1, z0, z1], y, up) {
  const corners = [toEp(x0, z1, y), toEp(x1, z1, y), toEp(x1, z0, y), toEp(x0, z0, y)]; // CCW seen from above
  return up ? corners : corners.reverse();
}
const vertexFields = vs => [vs.length, ...vs.flat()];

function noMass(name, r) { return obj('Material:NoMass', name, 'MediumRough', Math.max(0.001, r), 0.9, 0.6, 0.7); }

function constructions(design) {
  const out = [];
  const rGyp = GYPSUM.thick / GYPSUM.k, rCon = CONCRETE.thick / CONCRETE.k;
  out.push(obj('Material', 'Gypsum board', 'Smooth', GYPSUM.thick, GYPSUM.k, 800, 1090, 0.9, 0.5, 0.5));
  out.push(obj('Material', 'Concrete slab', 'MediumRough', CONCRETE.thick, CONCRETE.k, 2300, 900, 0.9, 0.6, 0.6));
  // Insulation layers sized so each construction's U-value (with standard surface films) equals the option's.
  const wallU = OPTIONS.walls[design.walls].u, roofU = OPTIONS.roof[design.roof].u, floorU = OPTIONS.floor[design.floor].u;
  out.push(noMass('Wall insulation', 1 / wallU - FILMS.wallIn - FILMS.out - rGyp));
  out.push(noMass('Roof insulation', 1 / roofU - FILMS.upIn - FILMS.out - rGyp));
  out.push(noMass('Ground floor insulation', 1 / floorU - FILMS.downIn - rCon)); // ground side has no film
  out.push(noMass('Inter-floor layer', 1 / FIXED.interFloorU - FILMS.upIn - FILMS.downIn - rCon));
  out.push(noMass('Partition core', 1 / FIXED.partitionU - 2 * FILMS.wallIn - 2 * rGyp));
  out.push(noMass('Door leaf', 1 / FIXED.doorU - FILMS.wallIn - FILMS.out));
  const glazing = OPTIONS.windows[design.windows];
  out.push(obj('WindowMaterial:SimpleGlazingSystem', 'Glazing', glazing.u, glazing.shgc, 0.6));
  out.push(obj('Construction', 'Exterior wall', 'Wall insulation', 'Gypsum board'));
  out.push(obj('Construction', 'Roof', 'Roof insulation', 'Gypsum board'));
  out.push(obj('Construction', 'Ground floor', 'Ground floor insulation', 'Concrete slab'));
  out.push(obj('Construction', 'Inter-floor (ceiling side)', 'Concrete slab', 'Inter-floor layer'));
  out.push(obj('Construction', 'Inter-floor (floor side)', 'Inter-floor layer', 'Concrete slab'));
  out.push(obj('Construction', 'Partition', 'Gypsum board', 'Partition core', 'Gypsum board'));
  out.push(obj('Construction', 'Exterior door', 'Door leaf'));
  out.push(obj('Construction', 'Window', 'Glazing'));
  return out;
}

function monthDay(dayOfYear) {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let d = dayOfYear;
  for (let m = 0; m < 12; m++) { if (d <= lengths[m]) return [m + 1, d]; d -= lengths[m]; }
  return [12, 31];
}

// Returns { idf, zones } where zones lists the EnergyPlus zone names in the simplified model's order.
export function buildIdf({ building, design: rawDesign, moves = {}, conditions }) {
  const design = normalizeDesign(rawDesign);
  const day = designDay(conditions, design);
  const model = buildThermalModel(building, design, moves);
  const t = building.thermal, fp = t.footprint, H = t.storeyHeight;
  const swing = (Math.max(...day.hours.map(h => h.outdoor)) - Math.min(...day.hours.map(h => h.outdoor))) / 2;
  const [month, dayOfMonth] = monthDay(day.dayOfYear);
  const maxDryBulb = day.meanOutdoor + swing;
  const idf = [];
  const push = s => idf.push(s);

  push(obj('Version', ENERGYPLUS_VERSION));
  push(obj('SimulationControl', 'No', 'No', 'No', 'Yes', 'No', 'No', 1));
  push(obj('Building', 'AEROFORM demo house', 0, 'Suburbs', 0.04, 0.2, 'FullExterior', 25, 6));
  push(obj('Timestep', TIMESTEPS_PER_HOUR));
  push(obj('GlobalGeometryRules', 'UpperLeftCorner', 'Counterclockwise', 'Relative'));
  push(obj('Site:Location', 'Design site', design.latitude, 0, 0, 0));
  push(obj('Site:GroundTemperature:BuildingSurface', ...Array(12).fill(FIXED.groundC)));
  push(obj('SizingPeriod:DesignDay', `${day.season} design day`, month, dayOfMonth, day.season === 'winter' ? 'WinterDesignDay' : 'SummerDesignDay',
    maxDryBulb, 2 * swing, 'DefaultMultipliers', null, 'DewPoint', Math.min(maxDryBulb - 10, 16), null, null, null, null, 101325,
    day.windSpeed, WIND_DEGREES[day.wind] ?? 0, 'No', 'No', 'No', 'ASHRAEClearSky', null, null, null, null, 1.0));
  push(obj('ScheduleTypeLimits', 'Fraction', 0, 1, 'Continuous'));
  push(obj('Schedule:Constant', 'Always on', 'Fraction', 1));
  push(obj('Schedule:Constant', 'Always off', 'Fraction', 0));
  push(obj('ScheduleTypeLimits', 'Any number'));
  // People and appliances: FIXED.internalWm2 all day plus FIXED.eveningWm2 from 17:00 to 23:00.
  const evening = (FIXED.internalWm2 + FIXED.eveningWm2) / FIXED.internalWm2;
  push(obj('Schedule:Compact', 'Internal gains', 'Any number', 'Through: 12/31', 'For: AllDays', 'Until: 17:00', 1, 'Until: 23:00', evening, 'Until: 24:00', 1));
  idf.push(...constructions(design));

  const zoneName = z => z.id;
  const surfaces = [], fenestration = [];
  const surface = (name, type, construction, zone, boundary, boundaryObject, vertices) => {
    const exposed = boundary === 'Outdoors';
    surfaces.push(obj('BuildingSurface:Detailed', name, type, construction, zone, null, boundary, boundaryObject,
      exposed ? 'SunExposed' : 'NoSun', exposed ? 'WindExposed' : 'NoWind', 'autocalculate', ...vertexFields(vertices)));
  };
  const outward = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
  for (const z of model.zones) {
    const level = t.levels.find(l => l.level === z.level), y0 = level.floorY, y1 = y0 + H;
    const below = t.levels.find(l => l.level === z.level - 1), above = t.levels.find(l => l.level === z.level + 1);
    z.rects.forEach((rect, r) => {
      const [x0, x1, z0, z1] = rect;
      // Exterior walls with their windows and door.
      exteriorEdges(rect, fp).forEach((edge, e) => {
        const n = outward[edge.facade], vertical_ = edge.facade === 'north' || edge.facade === 'south';
        const at = s => vertical_ ? [s, edge.facade === 'north' ? fp.z0 : fp.z1] : [edge.facade === 'west' ? fp.x0 : fp.x1, s];
        const wall = `${z.id} ${edge.facade} wall ${r}${e}`;
        surface(wall, 'Wall', 'Exterior wall', zoneName(z), 'Outdoors', null, vertical(at(edge.from), at(edge.to), n, y0, y1));
        t.openings.filter(o => o.facade === edge.facade).forEach((o, k) => {
          let [a, b] = overlap(edge.from, edge.to, o.from, o.to);
          if (b - a <= EPS) return;
          // Keep sub-surfaces just inside the wall edges.
          if (a - edge.from < 0.01) a = edge.from + 0.01; if (edge.to - b < 0.01) b = edge.to - 0.01;
          const bottom = o.type === 'door' ? 0 : WINDOW_CENTRE - o.height / 2;
          fenestration.push(obj('FenestrationSurface:Detailed', `${wall} ${o.type} ${k}`, o.type === 'door' ? 'Door' : 'Window',
            o.type === 'door' ? 'Exterior door' : 'Window', wall, null, 'autocalculate', null, 1,
            ...vertexFields(vertical(at(a), at(b), n, y0 + bottom, y0 + Math.min(H - 0.01, bottom + o.height)))));
        });
      });
      // Floor and ceiling of this rectangle.
      const lowerName = l => `${z.key}-${l.level} ceiling ${r}`, upperName = l => `${z.key}-${l.level} floor ${r}`;
      if (!below) surface(`${z.id} floor ${r}`, 'Floor', 'Ground floor', zoneName(z), 'Ground', null, horizontal(rect, y0, false));
      else surface(upperName(level), 'Floor', 'Inter-floor (floor side)', zoneName(z), 'Surface', lowerName(below), horizontal(rect, y0, false));
      if (!above) surface(`${z.id} roof ${r}`, 'Roof', 'Roof', zoneName(z), 'Outdoors', null, horizontal(rect, y1, true));
      else surface(lowerName(level), 'Ceiling', 'Inter-floor (ceiling side)', zoneName(z), 'Surface', upperName(above), horizontal(rect, y1, true));
    });
  }
  // Interior partitions: every shared edge between rectangles of different zones on the same floor.
  let partitions = 0;
  for (const a of model.zones) for (const b of model.zones) {
    if (a.level !== b.level || a.id >= b.id) continue;
    const level = t.levels.find(l => l.level === a.level), y0 = level.floorY, y1 = y0 + H;
    for (const ra of a.rects) for (const rb of b.rects) {
      const shared = [];
      for (const [xa, xb, n] of [[ra[1], rb[0], [1, 0]], [ra[0], rb[1], [-1, 0]]]) {
        if (Math.abs(xa - xb) > EPS) continue;
        const [s0, s1] = overlap(ra[2], ra[3], rb[2], rb[3]);
        if (s1 - s0 > EPS) shared.push({ p: [xa, s0], q: [xa, s1], n });
      }
      for (const [za, zb, n] of [[ra[3], rb[2], [0, 1]], [ra[2], rb[3], [0, -1]]]) {
        if (Math.abs(za - zb) > EPS) continue;
        const [s0, s1] = overlap(ra[0], ra[1], rb[0], rb[1]);
        if (s1 - s0 > EPS) shared.push({ p: [s0, za], q: [s1, za], n });
      }
      for (const { p, q, n } of shared) {
        const k = partitions++, an = `${a.id} partition ${k}`, bn = `${b.id} partition ${k}`;
        surface(an, 'Wall', 'Partition', a.id, 'Surface', bn, vertical(p, q, n, y0, y1));
        surface(bn, 'Wall', 'Partition', b.id, 'Surface', an, vertical(p, q, [-n[0], -n[1]], y0, y1));
      }
    }
  }

  const vents = ventFlows(model);
  const unitW = OPTIONS.acSize[design.acSize].kw * 1000;
  const recovery = OPTIONS.heatRecovery[design.heatRecovery].efficiency;
  push(obj('HVACTemplate:Thermostat', 'Setpoints', null, design.heatSetpoint, null, design.coolSetpoint));
  model.zones.forEach((z, i) => {
    push(obj('Zone', zoneName(z), 0, 0, 0, 0, 1, 1, H, z.volume, z.area, null, null, 'Yes'));
    push(obj('ZoneInfiltration:DesignFlowRate', `${z.id} air leakage`, z.id, 'Always on', 'AirChanges/Hour', null, null, null,
      OPTIONS.airtightness[design.airtightness].ach, 0.606, 0.03636, 0.1177, 0)); // EnergyPlus "BLAST" coefficients
    push(obj('OtherEquipment', `${z.id} people and appliances`, 'None', z.id, 'Internal gains', 'Watts/Area', null, FIXED.internalWm2, null, 0, 0.5, 0));
    const capacity = model.devices.filter(d => d.type === 'ac' && d.zone === i).length * unitW;
    const on = capacity > 0 ? 'Always on' : 'Always off';
    const air = vents[i] / 3600;
    push(obj('HVACTemplate:Zone:IdealLoadsAirSystem', z.id, 'Setpoints', null, 50, 13, 0.0156, 0.0077,
      'LimitCapacity', null, capacity, 'LimitCapacity', null, capacity, on, on, 'None', null, null, 'None', null,
      air > 0 ? 'Flow/Zone' : 'None', 0, 0, air, null, 'None', 'NoEconomizer', recovery > 0 ? 'Sensible' : 'None', recovery, 0));
  });
  const outdoorNodes = model.zones.filter((_, i) => vents[i] > 0).map(z => `${z.id} Ideal Loads Outdoor Air Inlet`);
  if (outdoorNodes.length) push(obj('OutdoorAir:NodeList', ...outdoorNodes));
  // Air exchange through doorways and the stair: one cross-mixing object per zone, as the EnergyPlus manual
  // recommends for zones joined by an open doorway, so heat moves whichever side is warmer.
  for (const c of model.couplings) {
    if (c.kind === 'floor') continue;
    const open = c.kind === 'stair' ? c.wPerK : t.connections.find(k => `${k.a}-${model.zones[c.a].level}` === model.zones[c.a].id && `${k.b}-${model.zones[c.b].level}` === model.zones[c.b].id)?.area * FIXED.openingWPerKm2;
    if (!open) continue;
    const flow = open / AIR_W_PER_M3K;
    for (const [to, from] of [[c.a, c.b], [c.b, c.a]]) {
      push(obj('ZoneCrossMixing', `${model.zones[from].id} to ${model.zones[to].id} (${c.kind})`, model.zones[to].id, 'Always on', 'Flow/Zone', flow, null, null, null, model.zones[from].id, 0));
    }
  }
  idf.push(...surfaces, ...fenestration);
  for (const v of ['Zone Mean Air Temperature', 'Zone Ideal Loads Supply Air Sensible Heating Rate', 'Zone Ideal Loads Supply Air Sensible Cooling Rate']) {
    push(obj('Output:Variable', '*', v, 'Timestep'));
  }
  push(obj('Output:Diagnostics', 'DisplayExtraWarnings'));
  return { idf: idf.join('\n'), zones: model.zones.map(zoneName), model, design, day };
}

// csv: eplusout.csv text (from energyplus --readvars). Returns a result in the simplified model's shape
// (zones with hourly/mean/min/max temperatures and heating/cooling, totals), with provenance.
export function parseEnergyPlusCsv(csv, { zones, model, design, day }) {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => l.split(','));
  const steps = 24 * TIMESTEPS_PER_HOUR;
  if (rows.length < steps) throw new Error(`EnergyPlus returned ${rows.length} time steps; expected ${steps}.`);
  const last = rows.slice(-steps);
  const column = (zone, variable) => {
    const i = header.findIndex(h => h.toUpperCase().startsWith(zone.toUpperCase() + ':') || h.toUpperCase().startsWith(zone.toUpperCase() + ' IDEAL LOADS AIR SYSTEM:') ? h.includes(variable) : false);
    if (i < 0) throw new Error(`EnergyPlus output has no "${variable}" for ${zone}.`);
    return last.map(r => Number(r[i]));
  };
  const dt = 3600 / TIMESTEPS_PER_HOUR;
  let peakHeat = new Float64Array(steps), peakCool = new Float64Array(steps);
  const zoneResults = zones.map((name, i) => {
    const T = column(name, 'Zone Mean Air Temperature');
    const heat = column(name, 'Supply Air Sensible Heating Rate'), cool = column(name, 'Supply Air Sensible Cooling Rate');
    heat.forEach((w, s) => { peakHeat[s] += w; }); cool.forEach((w, s) => { peakCool[s] += w; });
    const hourly = Array.from({ length: 24 }, (_, h) => T.slice(h * TIMESTEPS_PER_HOUR, (h + 1) * TIMESTEPS_PER_HOUR).reduce((a, b) => a + b, 0) / TIMESTEPS_PER_HOUR);
    let unmet = 0, coldHours = 0, hotHours = 0;
    for (const v of T) {
      const cold = Math.max(0, design.heatSetpoint - 1 - v), hot = Math.max(0, v - design.coolSetpoint - 1);
      unmet += (cold + hot) * dt / 3600; if (cold > 0) coldHours += dt / 3600; if (hot > 0) hotHours += dt / 3600;
    }
    const z = model.zones[i];
    return { id: z.id, name: z.name, level: z.level, area: z.area, volume: z.volume,
      meanC: T.reduce((a, b) => a + b, 0) / steps, minC: Math.min(...T), maxC: Math.max(...T), hourlyC: hourly,
      heatingKWh: heat.reduce((a, b) => a + b, 0) * dt / 3.6e6, coolingKWh: cool.reduce((a, b) => a + b, 0) * dt / 3.6e6,
      unmetKh: unmet, coldHours, hotHours };
  });
  const heatingKWh = zoneResults.reduce((s, z) => s + z.heatingKWh, 0), coolingKWh = zoneResults.reduce((s, z) => s + z.coolingKWh, 0);
  const electricKWh = heatingKWh / FIXED.ac.copHeat + coolingKWh / FIXED.ac.copCool;
  return {
    model: { name: 'EnergyPlus', version: ENERGYPLUS_VERSION, kind: 'physics', adapter: `${ADAPTER_INFO.name} ${ADAPTER_INFO.version}` },
    season: day.season, zones: zoneResults,
    totals: { heatingKWh, coolingKWh, electricKWh, co2Kg: electricKWh * design.gridKgPerKWh,
      peakHeatingKW: Math.max(...peakHeat) / 1000, peakCoolingKW: Math.max(...peakCool) / 1000,
      unmetKh: zoneResults.reduce((s, z) => s + z.unmetKh, 0) }
  };
}
