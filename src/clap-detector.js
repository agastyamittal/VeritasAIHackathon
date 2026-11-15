// Clap to recenter in VR: listens to the microphone for the sound of a clap. Audio is analysed on the device
// in short blocks and never recorded, stored or sent anywhere; the microphone is released when VR ends.
//
// A clap is a sharp click that dies away within about a tenth of a second. The detector fires when a block
// is clearly louder than the room's background and than the blocks just before it, is impulsive (peak well
// above its RMS), and the sound has fallen away again shortly after. Speech, music and steady noise rise
// more slowly or keep going, so they do not count.
//
// Tuned for a phone inside a headset, where the microphone is covered and points away from the hands, so a
// clap arrives much quieter than in the open. How eager it is depends on the room and the phone, so it has one
// setting, `sensitivity` (0-1, a slider in the hand dev view), that moves every threshold together between
// CLAP_STRICT (0: only loud, sharp claps) and CLAP_EAGER (1: faint claps, but also some clicks and taps).
// Earlier fixed versions: v1 (peak 0.2) missed claps on the phone; v2 (peak 0.06) and v3 (peak 0.1, about 0.67
// on this scale) fired too easily. The default is 0.45.
export const CLAP_STRICT = Object.freeze({ minPeak: 0.4, minRms: 0.03, overBackground: 7, overPrevious: 4, minCrest: 2.8, fadeTo: 0.3 });
export const CLAP_EAGER = Object.freeze({ minPeak: 0.05, minRms: 0.004, overBackground: 2.5, overPrevious: 2, minCrest: 2, fadeTo: 0.5 });
export const DEFAULT_CLAP_SENSITIVITY = 0.45;
// Thresholds for a sensitivity: loudness levels on a log scale (each step is the same ratio), ratios linearly.
export function clapThresholds(sensitivity = DEFAULT_CLAP_SENSITIVITY) {
  const s = Math.max(0, Math.min(1, Number.isFinite(sensitivity) ? sensitivity : DEFAULT_CLAP_SENSITIVITY));
  const out = {};
  for (const key of Object.keys(CLAP_STRICT)) {
    const a = CLAP_STRICT[key], b = CLAP_EAGER[key];
    out[key] = key === 'minPeak' || key === 'minRms' ? a * Math.pow(b / a, s) : a + (b - a) * s;
  }
  return out;
}

export function createClapDetector({ sensitivity = DEFAULT_CLAP_SENSITIVITY, quietAfter = [45, 200], cooldown = 600, ...overrides } = {}) {
  // quietAfter: ms after the onset in which the sound must have faded to fadeTo of its loudest block.
  let minPeak, minRms, overBackground, overPrevious, minCrest, fadeTo, current;
  const apply = value => { current = Math.max(0, Math.min(1, value)); ({ minPeak, minRms, overBackground, overPrevious, minCrest, fadeTo } = { ...clapThresholds(current), ...overrides }); };
  apply(sensitivity);
  let background = null, recent = [], pending = null, blockedUntil = -Infinity, claps = 0, lastLevel = 0, lastPeak = 0;
  return {
    get claps() { return claps; },
    get background() { return background ?? 0; },
    get level() { return lastLevel; },
    get peak() { return lastPeak; },
    get sensitivity() { return current; },
    // Changes how eager the detector is, immediately (the dev view slider).
    setSensitivity(value) { apply(Number(value)); },
    // Loudest peak a clap needs right now (for the dev view).
    get threshold() { return Math.max(minPeak, minCrest * Math.max(minRms, overBackground * Math.max(background ?? 0, 0.002))); },
    reset() { background = null; recent = []; pending = null; blockedUntil = -Infinity; },
    // samples: one block of audio (Float32Array, -1..1); time: ms. Returns true when a clap is confirmed.
    update(samples, time) {
      let sum = 0, peak = 0;
      for (let i = 0; i < samples.length; i++) { const v = samples[i]; sum += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
      const rms = Math.sqrt(sum / Math.max(1, samples.length));
      lastLevel = rms; lastPeak = peak;
      background ??= rms;
      let fired = false;
      // Compared with the quietest of the last three blocks, so a clap that starts at the very end of one
      // block (and so barely raises it) still counts as a sudden onset in the next.
      const before = recent.length ? Math.min(...recent) : 0;
      const onset = peak >= minPeak && rms >= minRms && rms >= overBackground * Math.max(background, 0.002)
        && rms >= overPrevious * Math.max(before, 0.001) && peak >= minCrest * rms;
      if (pending) {
        const since = time - pending.time;
        // The onset's level is its loudest block (the clap may straddle two blocks).
        if (since < quietAfter[0]) pending.rms = Math.max(pending.rms, rms);
        // Loud again: a second clap right after the first restarts the check (a double clap counts once);
        // anything else still sounding is not a clap.
        else if (rms > pending.rms * fadeTo) pending = onset ? { time, rms } : null;
        else if (since >= quietAfter[1] || rms < Math.max(2 * background, pending.rms * 0.15)) { pending = null; fired = true; claps++; blockedUntil = time + cooldown; }
      } else if (time >= blockedUntil && onset) {
        pending = { time, rms };
      }
      // The background follows quiet blocks only, so a clap or a voice does not raise it.
      if (!pending && rms < 3 * background) background += (rms - background) * 0.05;
      recent.push(rms); if (recent.length > 3) recent.shift();
      return fired;
    }
  };
}

// Microphone -> detector. Call from a user action (entering VR) so the audio context may start.
// Returns { stop(), diagnostics() }; onError gets a message if the microphone is unavailable or refused.
export function startClapListener({ onClap, onError = () => {}, media = globalThis.navigator?.mediaDevices,
  AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext, now = () => performance.now(),
  setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = id => clearInterval(id), detector = createClapDetector() } = {}) {
  let stream = null, context = null, timer = null, processor = null, stopped = false, state = 'starting', message = 'Starting microphone…';
  const fail = text => { state = 'error'; message = text; onError(text); };
  if (!media?.getUserMedia || !AudioContextClass) { fail('Clap to recenter needs a microphone, which this browser does not offer.'); return { stop() {}, diagnostics: () => ({ state, message }) }; }
  try { context = new AudioContextClass(); context.resume?.(); } catch { fail('Audio could not start.'); return { stop() {}, diagnostics: () => ({ state, message }) }; }
  // Raw sound: echo cancellation, noise suppression and auto gain would flatten the clap's sharp onset.
  Promise.resolve(media.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })).then(s => {
    if (stopped) { s.getTracks().forEach(t => t.stop()); return; }
    stream = s;
    const source = context.createMediaStreamSource(stream);
    state = 'listening'; message = 'Listening for a clap';
    if (context.createScriptProcessor) {
      // Every sample, in back-to-back 1024-sample blocks (about 21 ms), timed by the audio clock: nothing is
      // missed when the page's timers lag, as they do on phones. The output is left silent.
      processor = context.createScriptProcessor(1024, 1, 1);
      const start = now(); let samples = 0;
      processor.onaudioprocess = event => {
        const block = event.inputBuffer.getChannelData(0);
        const time = start + samples / (event.inputBuffer.sampleRate || context.sampleRate || 48000) * 1000;
        samples += block.length;
        if (detector.update(block, time)) onClap();
      };
      source.connect(processor); processor.connect(context.destination);
      return;
    }
    // Fallback: poll an analyser (can skip sound if the timer runs late).
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const block = new Float32Array(analyser.fftSize);
    timer = setTimer(() => {
      analyser.getFloatTimeDomainData(block);
      if (detector.update(block, now())) onClap();
    }, 20);
  }).catch(error => {
    if (stopped) return;
    fail(error?.name === 'NotAllowedError' ? 'Microphone not allowed · clap to recenter is off' : 'Microphone unavailable · clap to recenter is off');
  });
  return {
    stop() {
      stopped = true; state = 'off'; message = 'Off';
      if (timer !== null) clearTimer(timer);
      if (processor) { processor.onaudioprocess = null; try { processor.disconnect(); } catch {} }
      stream?.getTracks().forEach(t => t.stop());
      try { context?.close?.(); } catch {}
    },
    diagnostics: () => ({ state, message, claps: detector.claps, level: detector.level, peak: detector.peak, threshold: detector.threshold, background: detector.background, sensitivity: detector.sensitivity })
  };
}
