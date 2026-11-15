// Runs EnergyPlus on the AEROFORM house (the EnergyPlus adapter's runner). Needs the EnergyPlus executable:
// by default training/data/energyplus/EnergyPlus-26.2.0/energyplus.exe, or set ENERGYPLUS_EXE.
//
//   node training/energyplus/run-energyplus.mjs [winter|mild|summer]
//
// prints EnergyPlus and the simplified model side by side for the default design. Other scripts import
// runEnergyPlus().
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIdf, parseEnergyPlusCsv } from '../../src/simulation/energyplus.js';

export const ENERGYPLUS_EXE = process.env.ENERGYPLUS_EXE || fileURLToPath(new URL('../data/energyplus/EnergyPlus-26.2.0/energyplus.exe', import.meta.url));

function run(exe, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out }));
  });
}

// input: { building, design, moves, conditions }. Returns the parsed result; keeps the run folder when keep is set.
export async function runEnergyPlus(input, { exe = ENERGYPLUS_EXE, keep = false } = {}) {
  const built = buildIdf(input);
  const dir = await mkdtemp(join(tmpdir(), 'aeroform-eplus-'));
  try {
    await writeFile(join(dir, 'in.idf'), built.idf);
    const { code, out } = await run(exe, ['--expandobjects', '--readvars', '--output-directory', dir, join(dir, 'in.idf')], dir);
    const err = await readFile(join(dir, 'eplusout.err'), 'utf8').catch(() => '');
    if (code !== 0 || /\*\* Fatal|\*\*  Severe/.test(err)) {
      const severe = err.split(/\r?\n/).filter(l => /Severe|Fatal|~~~/.test(l)).slice(0, 12).join('\n');
      throw new Error(`EnergyPlus failed (exit ${code}) in ${dir}:\n${severe || out.slice(-2000)}`);
    }
    const result = parseEnergyPlusCsv(await readFile(join(dir, 'eplusout.csv'), 'utf8'), built);
    result.warnings = (err.match(/\*\* Warning \*\*/g) || []).length;
    if (keep) result.runDir = dir;
    return result;
  } finally {
    if (!keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { createBuilding } = await import('../../src/building.js');
  const { analyze, normalizeDesign } = await import('../../src/simulation/index.js');
  const { applySeason } = await import('../../src/conditions.js');
  const season = process.argv[2] || 'winter';
  const building = createBuilding(), design = normalizeDesign(), conditions = applySeason(season);
  const started = Date.now();
  const ep = await runEnergyPlus({ building, design, conditions }, { keep: process.env.KEEP === '1' });
  const simple = analyze({ building, design, conditions }).result;
  console.log(`${season}: ${JSON.stringify(conditions)}  EnergyPlus ${((Date.now() - started) / 1000).toFixed(1)} s, ${ep.warnings} warnings${ep.runDir ? ', kept ' + ep.runDir : ''}`);
  const f = v => v.toFixed(2).padStart(8);
  console.log('                       EnergyPlus  simplified');
  for (const k of ['heatingKWh', 'coolingKWh', 'electricKWh', 'peakHeatingKW', 'peakCoolingKW', 'unmetKh']) console.log(`${k.padEnd(22)}${f(ep.totals[k])}  ${f(simple.totals[k])}`);
  ep.zones.forEach((z, i) => console.log(`${z.id.padEnd(12)} mean °C ${f(z.meanC)}  ${f(simple.zones[i].meanC)}   min/max ${z.minC.toFixed(1)}/${z.maxC.toFixed(1)}  ${simple.zones[i].minC.toFixed(1)}/${simple.zones[i].maxC.toFixed(1)}`));
}
