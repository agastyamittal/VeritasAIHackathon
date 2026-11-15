// Paired examples of building inputs and simulation outputs, for training the energy surrogate models (ML
// models that predict a simulation's results instantly). Every row is a real run of a simulator; nothing is
// predicted here.
//
//   node training/generate-sim-dataset.mjs --engine simple     --rows 20000 --out training/data/sim-simple.csv
//   node training/generate-sim-dataset.mjs --engine energyplus --rows 6000  --out training/data/sim-energyplus.csv [--workers 12]
//
// Row i is drawn from its own random stream (seed, i), so an interrupted run resumes where it stopped: rows
// already in --out are skipped. Columns: index, the features of src/simulation/surrogate-features.js, then
// the targets. Inputs cover what the app lets you set: every construction option, setpoints, latitude
// -66..66, outdoor -20..45 °C (season from temperature, as for custom conditions, or a season preset), wind
// 0..15 m/s from N/E/S/W, and the AC units and vents moved to any room (ACs sometimes outside).
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { cpus } from 'node:os';
import { createBuilding } from '../src/building.js';
import { analyze, ORDER, normalizeDesign } from '../src/simulation/index.js';
import { buildThermalModel, acPlacement } from '../src/simulation/model.js';
import { SEASONS } from '../src/conditions.js';
import { FEATURE_NAMES, TARGET_NAMES, SURROGATE_ZONES, surrogateFeatures, surrogateTargets } from '../src/simulation/surrogate-features.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const engine = arg('engine', 'simple'), rows = Number(arg('rows', 500)), seed = Number(arg('seed', 1)), out = arg('out', null);
const workers = Number(arg('workers', Math.max(1, cpus().length - 4)));
if (!['simple', 'energyplus'].includes(engine)) throw new Error('--engine must be simple or energyplus');

function stream(i) { // mulberry32 seeded from (seed, i)
  let a = (Math.imul(seed, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const building = createBuilding();
const plan = buildThermalModel(building, normalizeDesign());
const home = group => building.boxes.find(b => b.group === group && b.type).home;

export function sample(i) {
  const random = stream(i), pick = list => list[Math.floor(random() * list.length)];
  const design = normalizeDesign({
    ...Object.fromEntries(Object.keys(ORDER).map(k => [k, pick(ORDER[k])])),
    heatSetpoint: 15 + Math.round(random() * 18) / 2, coolSetpoint: 22 + Math.round(random() * 16) / 2,
    latitude: Math.round(-66 + random() * 132), gridKgPerKWh: 0.38
  });
  const conditions = random() < 0.15
    ? (s => ({ season: s, ...SEASONS[s] }))(pick(Object.keys(SEASONS)))
    : { season: 'custom', temperature: Math.round(-20 + random() * 65), wind: pick(['N', 'E', 'S', 'W']), windSpeed: Math.round(random() * 15) };
  const moves = {};
  for (const level of [1, 2]) {
    const ac = `ac-${level}`, r = random();
    if (r < 0.05) moves[ac] = [20, 0, 0]; // outside the house: serves nothing
    else if (r < 0.85) { const target = acPlacement(plan, pick(SURROGATE_ZONES)); if (target) moves[ac] = target.map((v, k) => v - home(ac)[k]); }
    const vent = `vent-${level}`;
    if (random() < 0.35) {
      const id = pick(SURROGATE_ZONES.filter(zone => zone.endsWith(`-${level}`))), z = plan.zones.find(zn => zn.id === id);
      const [x0, x1, z0, z1] = z.rects[0];
      moves[vent] = [(x0 + x1) / 2, z.floorY + 3.1, (z0 + z1) / 2].map((v, k) => v - home(vent)[k]);
    }
  }
  return { building, design, moves, conditions };
}

async function existing(path) {
  const done = new Set();
  if (!path || !existsSync(path)) return done;
  const columns = header.split(',').length, keep = [];
  let dropped = 0;
  for await (const line of createInterface({ input: createReadStream(path) })) {
    const cells = line.split(','), i = Number(cells[0]);
    if (line === header) keep.push(line);
    else if (cells.length === columns && Number.isInteger(i) && cells.every(c => c !== '' && Number.isFinite(Number(c)))) { done.add(i); keep.push(line); }
    else if (line.trim()) dropped++;
  }
  if (dropped) { await writeFile(path, keep.join('\n') + '\n'); process.stderr.write(`  dropped ${dropped} incomplete row(s) from an interrupted run\n`); }
  return done;
}

const header = ['index', ...FEATURE_NAMES, ...TARGET_NAMES].join(',');
const fmt = v => Number(v.toFixed(4));
const write = async line => { if (out) await appendFile(out, line + '\n'); else process.stdout.write(line + '\n'); };

if (process.argv[1]?.endsWith('generate-sim-dataset.mjs')) {
  const done = await existing(out);
  if (!done.size) { if (out) await writeFile(out, header + '\n'); else console.log(header); }
  const todo = Array.from({ length: rows }, (_, i) => i).filter(i => !done.has(i));
  const started = Date.now();
  let finished = 0, failed = 0;
  const progress = () => { if (out && (finished % 50 === 0 || finished === todo.length)) process.stderr.write(`  ${engine}: ${finished + done.size}/${rows} rows, ${failed} failed (${((Date.now() - started) / 1000).toFixed(0)} s)\n`); };
  if (engine === 'simple') {
    for (const i of todo) {
      const input = sample(i);
      await write([i, ...surrogateFeatures(input), ...surrogateTargets(analyze(input).result)].map(fmt).join(','));
      finished++; progress();
    }
  } else {
    const { runEnergyPlus } = await import('./energyplus/run-energyplus.mjs');
    let next = 0;
    await Promise.all(Array.from({ length: workers }, async () => {
      while (next < todo.length) {
        const i = todo[next++], input = sample(i);
        try {
          const result = await runEnergyPlus(input);
          await write([i, ...surrogateFeatures(input), ...surrogateTargets(result)].map(fmt).join(','));
        } catch (error) { failed++; process.stderr.write(`row ${i}: ${error.message.split('\n')[0]}\n`); }
        finished++; progress();
      }
    }));
  }
}
