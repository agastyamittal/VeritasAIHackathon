// AEROFORM energy surrogates: small neural networks (training/train_surrogate.py) that predict a simulator's
// results for the demo house in well under a millisecond. models/energy-surrogate-energyplus.json learned
// EnergyPlus 26.2, so the app can show an EnergyPlus-level estimate on a phone where EnergyPlus cannot run;
// models/energy-surrogate-simple.json learned the simplified heat balance. Each prediction carries the
// model's measured test error and says when an input lies outside the range it was trained on.
import { FEATURE_NAMES, TARGET_NAMES, SURROGATE_ZONES, surrogateFeatures } from './simulation/surrogate-features.js';
import { FIXED } from './simulation/constructions.js';

export const SURROGATE_URL = engine => new URL(`../models/energy-surrogate-${engine}.json`, import.meta.url).href;

function decode(base64) {
  const bytes = typeof atob === 'function' ? Uint8Array.from(atob(base64), c => c.charCodeAt(0)) : Uint8Array.from(Buffer.from(base64, 'base64'));
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

export function createEnergySurrogate(model) {
  if (model?.format !== 'aeroform-energy-surrogate-v1') throw new Error('Unsupported energy surrogate file.');
  if (model.features.join() !== FEATURE_NAMES.join() || model.targets.join() !== TARGET_NAMES.join()) {
    throw new Error('Energy surrogate inputs/outputs do not match src/simulation/surrogate-features.js.');
  }
  const weights = decode(model.weights);
  const layers = model.layers.map(({ weight, bias }) => ({
    rows: weight.shape[0], cols: weight.shape[1],
    w: weights.subarray(weight.offset, weight.offset + weight.shape[0] * weight.shape[1]),
    b: weights.subarray(bias.offset, bias.offset + bias.shape[0])
  }));
  const logTargets = new Set(model.log1p_targets);
  const isLog = TARGET_NAMES.map(t => logTargets.has(t));
  const index = Object.fromEntries(TARGET_NAMES.map((t, i) => [t, i]));

  // features -> raw outputs in target units (TARGET_NAMES order).
  function forward(features) {
    let x = Float64Array.from(features, (v, i) => (v - model.input_mean[i]) / model.input_std[i]);
    layers.forEach((layer, l) => {
      const y = new Float64Array(layer.rows);
      for (let r = 0; r < layer.rows; r++) {
        let s = layer.b[r];
        const row = r * layer.cols;
        for (let c = 0; c < layer.cols; c++) s += layer.w[row + c] * x[c];
        y[r] = l < layers.length - 1 ? s / (1 + Math.exp(-s)) : s; // SiLU on hidden layers
      }
      x = y;
    });
    return Array.from(x, (v, i) => {
      const value = v * model.output_std[i] + model.output_mean[i];
      return isLog[i] ? Math.max(0, Math.expm1(value)) : value;
    });
  }

  // input: { building, design, moves, conditions } (same as analyze()). Returns null for other buildings.
  function predict(input) {
    const features = surrogateFeatures(input);
    if (!features) return null;
    const outside = FEATURE_NAMES.filter((name, i) => features[i] < model.input_min[i] - 1e-9 || features[i] > model.input_max[i] + 1e-9);
    const y = forward(features);
    const zones = SURROGATE_ZONES.map(id => {
      const hourlyC = Array.from({ length: 24 }, (_, h) => y[index[`t_${id}_${String(h).padStart(2, '0')}`]]);
      const minC = y[index[`min_c_${id}`]], maxC = y[index[`max_c_${id}`]];
      return { id, hourlyC, meanC: hourlyC.reduce((a, b) => a + b, 0) / 24, minC: Math.min(minC, maxC, ...hourlyC), maxC: Math.max(minC, maxC, ...hourlyC) };
    });
    const heatingKWh = y[index.heating_kwh], coolingKWh = y[index.cooling_kwh];
    const electricKWh = heatingKWh / FIXED.ac.copHeat + coolingKWh / FIXED.ac.copCool;
    return {
      model: { name: `AEROFORM energy surrogate (${model.engine})`, learns: model.learns, kind: 'AI surrogate (neural network)', trained: model.training.trained },
      zones,
      totals: { heatingKWh, coolingKWh, electricKWh, co2Kg: electricKWh * (input.design?.gridKgPerKWh ?? 0.38),
        peakHeatingKW: y[index.peak_heating_kw], peakCoolingKW: y[index.peak_cooling_kw], unmetKh: y[index.unmet_kh] },
      inRange: outside.length === 0, outsideTrainingRange: outside,
      testError: model.metrics[`surrogate_vs_${model.engine}`]
    };
  }
  return { predict, forward, info: { engine: model.engine, learns: model.learns, metrics: model.metrics, training: model.training } };
}

export async function loadEnergySurrogate(engine = 'energyplus', fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(SURROGATE_URL(engine));
  if (!response.ok) throw new Error(`Energy surrogate (${engine}) is not available (${response.status}).`);
  return createEnergySurrogate(await response.json());
}
