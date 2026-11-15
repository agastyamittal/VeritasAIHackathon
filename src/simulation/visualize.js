// Turns a simulation result into what the viewer draws for the Thermal, Heat loss and Airflow layers.
// Every colour comes from a simulated number, on the same scales as the Analysis charts: rooms are grey
// when comfortable, blue when colder, red when hotter; surfaces get more orange with more heat flow.
import { comfortColor, flowColor } from '../analysis-charts.js';

const ENVELOPE = { 'west wall': 'wall', 'east wall': 'wall', 'north sill': 'wall', 'north lintel': 'wall', 'window pier': 'wall', 'south sill': 'wall',
  'entry lintel': 'wall', 'north window': 'window', 'south glazing': 'window', door: 'door', roof: 'roof' };

function facadeOf(box, fp) {
  const [x, , z] = box.center;
  if (Math.abs(z - fp.z0) < 0.3) return 'north';
  if (Math.abs(z - fp.z1) < 0.3) return 'south';
  if (Math.abs(x - fp.x0) < 0.3) return 'west';
  if (Math.abs(x - fp.x1) < 0.3) return 'east';
  return null;
}
const zoneAt = (result, building, level, x, z) => {
  const zone = building.rooms.find(r => r.level === level && r.rects.some(([x0, x1, z0, z1]) => x >= x0 - 0.3 && x <= x1 + 0.3 && z >= z0 - 0.3 && z <= z1 + 0.3));
  return zone ? result.zones.find(r => r.id === zone.id) : null;
};

// Room floors coloured by temperature: grey when comfortable, blue when colder, red when hotter (the same
// scale as the Analysis charts). zones: [{id, meanC, hourlyC}]; hour: 0-23, or null for the daily mean.
export function roomTiles(zones, building, settings, hour = null) {
  const levelY = Object.fromEntries(building.thermal.levels.map(l => [l.level, l.floorY]));
  const tempOf = z => hour === null ? z.meanC : z.hourlyC[hour];
  const tiles = [];
  for (const room of building.rooms) {
    const z = zones.find(r => r.id === room.id);
    if (!z) continue;
    for (const [x0, x1, z0, z1] of room.rects) {
      tiles.push({ center: [(x0 + x1) / 2, levelY[room.level] + 0.04, (z0 + z1) / 2], size: [x1 - x0 - 0.12, 0.05, z1 - z0 - 0.12],
        color: comfortColor(tempOf(z), settings.heatSetpoint, settings.coolSetpoint), alpha: 0.7, floor: room.level, zoneId: z.id, valueC: tempOf(z) });
    }
  }
  return tiles;
}
const timeLabel = hour => hour === null ? 'Daily mean' : `At ${String(hour).padStart(2, '0')}:00`;

// hour: 0-23 for that hour's temperatures, or null for the daily mean.
export function buildVisualization(result, building, moves = {}, hour = null) {
  const t = building.thermal, fp = t.footprint;
  const thermalTiles = roomTiles(result.zones, building, result.settings, hour);

  // Heat flow through each envelope box: its zone's simulated mean flux for that surface type and facade.
  const recolor = {}, fluxes = [], heatLeaks = [];
  for (const box of building.boxes) {
    const type = ENVELOPE[box.name];
    if (!type) continue;
    let flux = null;
    if (type === 'roof') {
      const roofs = result.zones.flatMap(z => z.surfaces.filter(s => s.type === 'roof'));
      const area = roofs.reduce((s, r) => s + r.area, 0);
      flux = area ? roofs.reduce((s, r) => s + r.meanLossWm2 * r.area, 0) / area : null;
    } else {
      const facade = facadeOf(box, fp), z = zoneAt(result, building, box.floor, box.center[0], box.center[2]);
      const surface = z?.surfaces.find(s => s.type === type && s.facade === facade) ?? z?.surfaces.find(s => s.type === type);
      flux = surface ? surface.meanLossWm2 : null;
    }
    if (flux === null) continue;
    recolor[box.id] = flowColor(flux);
    fluxes.push({ name: box.name, floor: box.floor, type, wPerM2: flux });
    if (type === 'window' || type === 'door') heatLeaks.push(...leakStreams(box, facadeOf(box, fp), flux));
  }

  // Where the air goes, as streams of particles along routes through the house (doorways and the stair,
  // never through walls). Particle counts follow the simulated flows; see airflowStreams() below.
  const cooling = result.totals.coolingKWh > result.totals.heatingKWh;
  const streams = airflowStreams(result, building, cooling);
  const ventilationTiles = thermalTiles.map(tile => {
    const z = result.zones.find(r => r.id === tile.zoneId);
    return { ...tile, color: z.poorlyVentilated ? [0.95, 0.65, 0.2] : [0.3, 0.8, 0.6], alpha: z.poorlyVentilated ? 0.45 : 0.12, valueACH: z.freshAirACH };
  });

  return {
    thermal: { tiles: thermalTiles, legend: timeLabel(hour) + ' · blue colder, grey comfortable, red hotter' },
    heatloss: { recolor, fluxes, streams: heatLeaks, legend: (cooling ? 'Heat coming in' : 'Heat leaking out') + ' · brighter orange = more · red dots: heat through windows' },
    airflow: { streams, tiles: ventilationTiles, dim: 0.5, legend: `Air flow · AC ${cooling ? 'cooling (blue)' : 'heating (orange)'} · fresh air (aqua) · outside air leaking in (${streams.find(s => s.kind === 'outside')?.colorName ?? 'white'})` }
  };
}

export const HEAT_COLOR = Object.freeze([1, 0.24, 0.12]);
const FACADE_OUT = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };

// Heat through a window or door as red particles: from inside the room, through the glass, out and rising
// (or inwards when heat comes in, flux < 0). Six lanes spread over the opening; more particles and faster
// with more heat flow (W per m2 times the opening's area).
export function leakStreams(box, facade, flux) {
  const out = FACADE_OUT[facade];
  if (!out || !Number.isFinite(flux)) return [];
  const width = out[0] ? box.size[2] : box.size[0], height = box.size[1], area = width * height;
  const watts = Math.abs(flux) * area, perLane = Math.round(Math.min(110, watts / 5) / 6);
  if (perLane < 1) return [];
  const along = out[0] ? [0, 1] : [1, 0], speed = 0.35 + Math.min(0.9, Math.abs(flux) / 60);
  const lanes = [];
  for (const u of [-0.33, 0, 0.33]) for (const v of [-0.22, 0.18]) {
    const x = box.center[0] + along[0] * u * width, z = box.center[2] + along[1] * u * width, y = box.center[1] + v * height;
    const points = [[x - out[0] * 1.3, y - 0.2, z - out[1] * 1.3], [x, y, z], [x + out[0] * 1.2, y + 0.35, z + out[1] * 1.2], [x + out[0] * 2.4, y + 0.9, z + out[1] * 2.4]];
    if (flux < 0) points.reverse();
    lanes.push(prepareStream({ kind: 'heat', floor: box.floor, color: HEAT_COLOR, size: 0.7, count: perLane, speed, points, wPerM2: flux }));
  }
  return lanes;
}

export const AIR_COLORS = Object.freeze({ acCool: [0.35, 0.68, 1], acHeat: [1, 0.55, 0.22], fresh: [0.3, 1, 0.82], outsideCold: [0.78, 0.9, 1], outsideMild: [0.95, 0.97, 0.97], outsideHot: [1, 0.85, 0.55], stairWarm: [1, 0.9, 0.5], stairCool: [0.6, 0.85, 1] });
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
const WIND_FACADE = { N: 'north', E: 'east', S: 'south', W: 'west' };

// Builds polyline streams: {points: [[x,y,z]...], count, speed (m/s), color, floor, kind, loop}.
export function airflowStreams(result, building, cooling) {
  const t = building.thermal, fp = t.footprint, levelY = Object.fromEntries(t.levels.map(l => [l.level, l.floorY]));
  const zoneOf = (level, x, z) => building.rooms.find(r => r.level === level && r.rects.some(([x0, x1, z0, z1]) => x >= x0 - 1e-6 && x <= x1 + 1e-6 && z >= z0 - 1e-6 && z <= z1 + 1e-6));
  const centre = room => { const [x0, x1, z0, z1] = room.rects.reduce((a, b) => (b[1] - b[0]) * (b[3] - b[2]) > (a[1] - a[0]) * (a[3] - a[2]) ? b : a); return [(x0 + x1) / 2, (z0 + z1) / 2]; };
  const keyOf = room => room.id.split('-')[0];
  // Route between two rooms on one floor through doorways (breadth-first over the connections).
  function route(level, from, to) {
    if (from.id === to.id) return [];
    const prev = new Map([[keyOf(from), null]]), queue = [keyOf(from)];
    while (queue.length) {
      const k = queue.shift();
      for (const c of t.connections) {
        const next = c.a === k ? c.b : c.b === k ? c.a : null;
        if (next && !prev.has(next)) { prev.set(next, { from: k, at: c.at }); queue.push(next); }
      }
    }
    const steps = [];
    for (let k = keyOf(to); prev.get(k); k = prev.get(k).from) steps.unshift({ door: prev.get(k).at, room: building.rooms.find(r => r.level === level && keyOf(r) === k) });
    return steps.flatMap(s => [s.door, centre(s.room)]);
  }
  const at = (xz, y) => [xz[0], y, xz[1]];
  const streams = [];
  const outdoor = result.outdoor.meanC, indoor = result.zones.reduce((s, z) => s + z.meanC, 0) / result.zones.length;
  const outsideColor = outdoor < indoor - 4 ? AIR_COLORS.outsideCold : outdoor > indoor + 2 ? AIR_COLORS.outsideHot : AIR_COLORS.outsideMild;

  for (const d of result.devices) {
    if (d.outside || !d.zoneId) continue;
    const room = building.rooms.find(r => r.id === d.zoneId), level = room.level, y0 = levelY[level];
    const [x, y, z] = d.position, zone = result.zones.find(r => r.id === d.zoneId);
    if (d.type === 'ac') {
      // Out across the room at head height, down (cooling) or up (heating) at the far side, back along the floor or ceiling.
      const dir = Math.abs(x - fp.x1) < 0.6 ? [-1, 0] : Math.abs(x - fp.x0) < 0.6 ? [1, 0] : Math.abs(z - fp.z0) < 0.6 ? [0, 1] : Math.abs(z - fp.z1) < 0.6 ? [0, -1] : [-1, 0];
      const [cx, cz] = centre(room), reach = Math.max(2, Math.abs(dir[0] ? cx - x : cz - z) * 1.6);
      const far = [x + dir[0] * reach, z + dir[1] * reach], low = y0 + (cooling ? 0.35 : 2.9);
      const work = zone.heatingKWh + zone.coolingKWh;
      for (const side of [-0.6, 0.6]) {
        const off = dir[0] ? [0, side] : [side, 0];
        streams.push({ kind: 'ac', floor: level, loop: true, color: cooling ? AIR_COLORS.acCool : AIR_COLORS.acHeat, count: Math.round(40 + Math.min(70, work * 1.5)), speed: 1.4,
          points: [[x + dir[0] * 0.25, y - 0.1, z + dir[1] * 0.25], [far[0] + off[0], y - (cooling ? 0.4 : -0.1), far[1] + off[1]], [far[0] + off[0], low, far[1] + off[1]], [x + dir[0] * 0.4 + off[0], low, z + dir[1] * 0.4 + off[1]], [x + dir[0] * 0.25, y - 0.1, z + dir[1] * 0.25]] });
      }
    } else if (d.type === 'vent') {
      // Fresh air: down from the ceiling, then out to each room the vent serves, through the doorways.
      const served = [room, ...t.connections.filter(c => c.a === keyOf(room) || c.b === keyOf(room)).map(c => building.rooms.find(r => r.level === level && keyOf(r) === (c.a === keyOf(room) ? c.b : c.a)))];
      const total = served.reduce((s, r) => s + result.zones.find(zn => zn.id === r.id).area, 0);
      for (const target of served) {
        const share = result.zones.find(zn => zn.id === target.id).area / total, h = y0 + 1.2;
        const path = [[x, y - 0.1, z], [x, h, z], ...route(level, room, target).map(p => at(p, h))];
        if (target.id === room.id) path.push(at(centre(room).map((v, i) => v + (i ? 1.2 : -1.2)), y0 + 0.6));
        else path.push([path.at(-1)[0], y0 + 0.6, path.at(-1)[2]]);
        streams.push({ kind: 'fresh', floor: level, color: AIR_COLORS.fresh, count: Math.round(24 + 60 * share), speed: 0.9, points: path });
      }
    }
  }

  // Outside air: in on the windward side, across the house through the doorways, out on the far side.
  const windward = WIND_FACADE[result.weather?.wind] ?? 'north', leeward = OPPOSITE[windward], wind = result.weather?.windSpeed ?? 4;
  const facadePoints = facade => {
    const windows = t.openings.filter(o => o.facade === facade && o.type === 'window').map(o => (o.from + o.to) / 2);
    const along = windows.length ? windows : facade === 'east' || facade === 'west' ? [fp.z0 + 2.2, fp.z1 - 2.2] : [-3, 3];
    return along.map(a => {
      if (facade === 'north') return { inside: [a, fp.z0 + 0.4], outside: [a, fp.z0 - 1.6] };
      if (facade === 'south') return { inside: [a, fp.z1 - 0.4], outside: [a, fp.z1 + 1.6] };
      if (facade === 'west') return { inside: [fp.x0 + 0.4, a], outside: [fp.x0 - 1.6, a] };
      return { inside: [fp.x1 - 0.4, a], outside: [fp.x1 + 1.6, a] };
    });
  };
  const exits = facadePoints(leeward);
  for (const level of t.levels.map(l => l.level)) {
    const h = levelY[level] + 1.5;
    for (const inlet of facadePoints(windward)) {
      const exit = exits.reduce((best, e) => (Math.hypot(e.inside[0] - inlet.inside[0], e.inside[1] - inlet.inside[1]) < Math.hypot(best.inside[0] - inlet.inside[0], best.inside[1] - inlet.inside[1]) ? e : best));
      const a = zoneOf(level, ...inlet.inside), b = zoneOf(level, ...exit.inside);
      if (!a || !b) continue;
      const middle = a.id === b.id ? [] : [centre(a), ...route(level, a, b)];
      streams.push({ kind: 'outside', floor: level, color: outsideColor, colorName: outsideColor === AIR_COLORS.outsideCold ? 'pale blue, cold' : outsideColor === AIR_COLORS.outsideHot ? 'yellow, hot' : 'white', count: Math.round(15 + 6 * wind), speed: 0.5 + 0.12 * wind,
        points: [inlet.outside, inlet.inside, ...middle, exit.inside, exit.outside].map(p => at(p, h)) });
    }
  }

  // Stair: warm air rises to the upper floor in the heating season; cool air sinks in the cooling season.
  if (t.stair) {
    const [l1, l2] = t.levels, bottom = [t.stair.bottom[0], l1.floorY + 1.4, t.stair.bottom[1]], top = [t.stair.top[0], l2.floorY + 1.4, t.stair.top[1]];
    const upper = building.rooms.find(r => r.level === l2.level && keyOf(r) === t.stair.zone), lower = building.rooms.find(r => r.level === l1.level && keyOf(r) === t.stair.zone);
    const path = [at(centre(lower), l1.floorY + 1.4), bottom, top, at(centre(upper), l2.floorY + 1.4)];
    streams.push({ kind: 'stair', floor: 0, color: cooling ? AIR_COLORS.stairCool : AIR_COLORS.stairWarm, count: 45, speed: 0.7, points: cooling ? path.reverse() : path });
  }
  return streams.map(prepareStream);
}

// Adds cumulative lengths so the viewer can place particles quickly.
function prepareStream(stream) {
  const lengths = [0];
  for (let i = 1; i < stream.points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(...stream.points[i].map((v, k) => v - stream.points[i - 1][k])));
  return { ...stream, lengths, total: lengths.at(-1) || 1 };
}
