// AEROFORM gesture classifier: a small MLP trained by training/train_gesture.py on HaGRIDv2 MediaPipe
// landmarks. It runs on the 21 landmarks from the hand tracker, in plain JS (about 30k weights).
// gestureFeatures() must match features() in the Python script; the model JSON carries reference
// inputs and outputs ("checks") that tests compare against.

export const GESTURE_MODEL_URL = new URL('../models/gesture-classifier.json', import.meta.url).href;
export const GESTURE_LABELS = Object.freeze({ open_palm: 'Open palm', fist: 'Fist', point: 'One finger', thumbs_up: 'Thumbs up', thumbs_down: 'Thumbs down', ok: 'OK sign', two_fingers: 'Two fingers', three_fingers: 'Three fingers', four_fingers: 'Four fingers', other: 'No gesture' });

// landmarks: 21 {x, y} (MediaPipe) or [x, y] points in image-normalized coordinates.
export function gestureFeatures(landmarks, aspect = 1) {
  if (!Array.isArray(landmarks) || landmarks.length !== 21) return null;
  const xs = new Float64Array(21), ys = new Float64Array(21);
  for (let i = 0; i < 21; i++) {
    const point = landmarks[i];
    const x = Array.isArray(point) ? point[0] : point?.x, y = Array.isArray(point) ? point[1] : point?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    xs[i] = x * aspect; ys[i] = y;
  }
  const ox = xs[0], oy = ys[0];
  for (let i = 0; i < 21; i++) { xs[i] -= ox; ys[i] -= oy; }
  let palm = Math.hypot(xs[9], ys[9]);
  if (palm < 1e-6) palm = 1;
  const mirror = (xs[5] - xs[17]) / palm < 0 ? -1 : 1;
  const out = new Float64Array(42);
  for (let i = 0; i < 21; i++) { out[i * 2] = mirror * xs[i] / palm; out[i * 2 + 1] = ys[i] / palm; }
  return out;
}

export function createGestureClassifier(model) {
  if (model?.format !== 'aeroform-gesture-mlp-v1' || !Array.isArray(model.classes) || !Array.isArray(model.layers) || !model.layers.length) {
    throw new Error('Unsupported gesture model file.');
  }
  let width = 42;
  const layers = model.layers.map(({ weights, bias }) => {
    if (!Array.isArray(weights) || weights.some(row => !Array.isArray(row) || row.length !== width) || bias?.length !== weights.length) {
      throw new Error('Gesture model layer sizes do not match.');
    }
    width = weights.length;
    return { weights: weights.map(row => Float64Array.from(row)), bias: Float64Array.from(bias) };
  });
  if (width !== model.classes.length) throw new Error('Gesture model output does not match its classes.');
  const classes = [...model.classes];

  function probabilities(input) {
    let values = input;
    layers.forEach((layer, index) => {
      const next = new Float64Array(layer.bias.length);
      for (let j = 0; j < next.length; j++) {
        let sum = layer.bias[j];
        const row = layer.weights[j];
        for (let i = 0; i < row.length; i++) sum += row[i] * values[i];
        next[j] = index < layers.length - 1 ? Math.max(0, sum) : sum;
      }
      values = next;
    });
    const peak = Math.max(...values);
    const exp = Array.from(values, v => Math.exp(v - peak));
    const total = exp.reduce((a, b) => a + b, 0);
    return exp.map(v => v / total);
  }

  return {
    classes,
    metrics: model.metrics ?? null,
    probabilities,
    predict(landmarks, aspect = 1) {
      const input = gestureFeatures(landmarks, aspect);
      if (!input) return null;
      const p = probabilities(input);
      let best = 0;
      for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
      return { label: classes[best], confidence: p[best], probabilities: p };
    }
  };
}

export async function loadGestureClassifier(url = GESTURE_MODEL_URL, fetcher = globalThis.fetch) {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Gesture model could not load (${response.status}).`);
  return createGestureClassifier(await response.json());
}

// Turns per-frame predictions into commands. A sign must be held for `holdMs` (at `minConfidence`) to fire
// once; it fires again only after the hand shows another sign or is gone for longer than `graceMs`. Brief
// dropouts (a blurred or uncertain frame) within `graceMs` do not restart the hold, so a steady sign registers
// even when the classifier flickers. Open palm (walk) and OK are not commands.
export function createGestureCommands({ minConfidence = 0.7, holdMs = 450, graceMs = 250, ignore = ['other', 'open_palm', 'ok'] } = {}) {
  let current = null, since = 0, seen = -Infinity, fired = false, clock = 0, last = 0;
  return {
    reset() { current = null; fired = false; seen = -Infinity; },
    // For the dev view: the sign being held, how far through the hold it is (0-1), and whether it fired.
    get state() { return { label: current, progress: current ? Math.min(1, (last - since) / holdMs) : 0, fired }; },
    // time in ms; frames 33 ms apart are assumed when it is left out.
    update(prediction, time = (clock += 33)) {
      last = time;
      const label = prediction && prediction.confidence >= minConfidence && !ignore.includes(prediction.label) ? prediction.label : null;
      if (label && label === current) seen = time;
      else if (label) { current = label; since = time; seen = time; fired = false; }
      else if (current && time - seen > graceMs) { current = null; fired = false; }
      if (!current || fired || label !== current || time - since < holdMs) return null;
      fired = true;
      return current;
    }
  };
}

// Fist, then open hand within `window` ms: one toggle. The fist must be held `fistFrames` frames first.
export function createFistOpenToggle({ fistFrames = 4, window: windowMs = 1200 } = {}) {
  let fistCount = 0, fistEndedAt = null, lastFist = null;
  return {
    reset() { fistCount = 0; fistEndedAt = null; lastFist = null; },
    // shape: 'fist' | 'open' | null for this frame. Returns true when the toggle fires.
    update(shape, time) {
      if (shape === 'fist') { fistCount++; fistEndedAt = null; lastFist = time; return false; }
      // The window starts when the fist was last seen, not when its absence is noticed.
      if (fistCount >= fistFrames && fistEndedAt === null) fistEndedAt = lastFist;
      fistCount = 0;
      if (shape === 'open' && fistEndedAt !== null && time - fistEndedAt <= windowMs) { fistEndedAt = null; return true; }
      if (fistEndedAt !== null && time - fistEndedAt > windowMs) fistEndedAt = null;
      return false;
    }
  };
}
