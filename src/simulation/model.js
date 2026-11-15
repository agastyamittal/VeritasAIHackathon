// Builds the thermal network for the simplified heat-balance model from the structured building
// (src/building.js THERMAL + boxes). Zones are the rooms on each floor; surfaces are the exterior wall,
// window, door, roof and ground areas of each zone; couplings join zones through openings, partitions,
// floors and the stair. HVAC devices are assigned to the zone they currently sit in, so moving an AC
// unit changes which room it heats or cools.
import { OPTIONS, FIXED } from './constructions.js';

const EPS = 1e-6;
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const rectArea = ([x0, x1, z0, z1]) => (x1 - x0) * (z1 - z0);
const inRect = ([x0, x1, z0, z1], x, z) => x >= x0 - EPS && x <= x1 + EPS && z >= z0 - EPS && z <= z1 + EPS;

// Exterior edges of a rectangle that lie on the footprint, as {facade, from, to} along the facade axis.
export function exteriorEdges(rect, fp) {
  const [x0, x1, z0, z1] = rect, edges = [];
  if (Math.abs(z0 - fp.z0) < EPS) edges.push({ facade: 'north', from: x0, to: x1 });
  if (Math.abs(z1 - fp.z1) < EPS) edges.push({ facade: 'south', from: x0, to: x1 });
  if (Math.abs(x0 - fp.x0) < EPS) edges.push({ facade: 'west', from: z0, to: z1 });
  if (Math.abs(x1 - fp.x1) < EPS) edges.push({ facade: 'east', from: z0, to: z1 });
  return edges;
}

// moves: {group: [dx, dy, dz]} offsets applied to movable boxes (same format the viewer saves).
export function buildThermalModel(building, design, moves = {}) {
  const t = building.thermal;
  const { footprint: fp, storeyHeight: height } = t;
  const glazing = OPTIONS.windows[design.windows], wallU = OPTIONS.walls[design.walls].u;
  const zones = [];
  for (const level of t.levels) {
    for (const z of t.zones) {
      const area = z.rects.reduce((sum, r) => sum + rectArea(r), 0);
      const surfaces = [];
      for (const rect of z.rects) {
        for (const edge of exteriorEdges(rect, fp)) {
          const gross = (edge.to - edge.from) * height;
          let opened = 0;
          for (const o of t.openings.filter(o => o.facade === edge.facade)) {
            const a = overlap(edge.from, edge.to, o.from, o.to) * o.height;
            if (a <= EPS) continue;
            opened += a;
            surfaces.push(o.type === 'door'
              ? { type: 'door', facade: edge.facade, area: a, u: FIXED.doorU, shgc: 0 }
              : { type: 'window', facade: edge.facade, area: a, u: glazing.u, shgc: glazing.shgc });
          }
          surfaces.push({ type: 'wall', facade: edge.facade, area: Math.max(0, gross - opened), u: wallU, shgc: 0 });
        }
      }
      if (level.roof) surfaces.push({ type: 'roof', facade: 'roof', area, u: OPTIONS.roof[design.roof].u, shgc: 0 });
      if (level.ground) surfaces.push({ type: 'floor', facade: 'ground', area, u: OPTIONS.floor[design.floor].u, shgc: 0 });
      zones.push({
        id: `${z.key}-${level.level}`, key: z.key, name: z.name, level: level.level, floorY: level.floorY, rects: z.rects,
        area, volume: area * height, capacity: area * FIXED.massJPerKm2 + area * height * FIXED.airJPerKm3,
        facades: [...new Set(surfaces.filter(s => s.facade !== 'roof' && s.facade !== 'ground').map(s => s.facade))],
        surfaces
      });
    }
  }
  const index = new Map(zones.map((z, i) => [z.id, i]));
  const couplings = [];
  for (const level of t.levels) {
    for (const c of t.connections) {
      couplings.push({ a: index.get(`${c.a}-${level.level}`), b: index.get(`${c.b}-${level.level}`), kind: 'opening',
        wPerK: c.area * FIXED.openingWPerKm2 + c.partitionArea * FIXED.partitionU });
    }
  }
  // Floors between storeys: each zone above its own footprint below (same plan on both floors), plus the stair.
  for (let l = 1; l < t.levels.length; l++) {
    for (const z of t.zones) {
      const area = z.rects.reduce((sum, r) => sum + rectArea(r), 0);
      couplings.push({ a: index.get(`${z.key}-${t.levels[l - 1].level}`), b: index.get(`${z.key}-${t.levels[l].level}`), kind: 'floor', wPerK: area * FIXED.interFloorU });
    }
    if (t.stair) couplings.push({ a: index.get(`${t.stair.zone}-${t.levels[l - 1].level}`), b: index.get(`${t.stair.zone}-${t.levels[l].level}`), kind: 'stair', wPerK: t.stair.area * FIXED.openingWPerKm2 });
  }

  // HVAC devices at their current (possibly moved) positions.
  const devices = [];
  const groups = new Map();
  for (const box of building.boxes) {
    if (!box.group || !box.type) continue;
    const offset = Array.isArray(moves[box.group]) && moves[box.group].every(Number.isFinite) ? moves[box.group] : [0, 0, 0];
    const position = box.home.map((v, k) => v + offset[k]);
    groups.set(box.group, { group: box.group, type: box.type, name: box.name, position });
  }
  for (const d of groups.values()) {
    const [x, y, z] = d.position;
    const zone = zones.find(zn => y >= zn.floorY - 0.2 && y <= zn.floorY + height + 0.2 && zn.rects.some(r => inRect(r, x, z)));
    devices.push({ ...d, zone: zone ? index.get(zone.id) : -1, zoneId: zone?.id ?? null });
  }
  return { zones, couplings, devices, height, footprint: fp };
}

// Where to put an AC unit inside a zone: centred on the zone's longest east or west exterior wall, at
// head height, so the unit's long side stays along the wall like the original.
export function acPlacement(model, zoneId) {
  const zone = model.zones.find(z => z.id === zoneId);
  if (!zone) return null;
  let best = null;
  for (const rect of zone.rects) {
    const [x0, x1, z0, z1] = rect;
    if (Math.abs(x1 - model.footprint.x1) < EPS && (!best || z1 - z0 > best.len)) best = { len: z1 - z0, x: x1 - 0.24, z: (z0 + z1) / 2 };
    if (Math.abs(x0 - model.footprint.x0) < EPS && (!best || z1 - z0 > best.len)) best = { len: z1 - z0, x: x0 + 0.24, z: (z0 + z1) / 2 };
  }
  return best ? [best.x, zone.floorY + 2.4, best.z] : null;
}
