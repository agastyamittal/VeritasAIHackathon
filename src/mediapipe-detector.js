// Camera frame -> 21 hand landmarks with Google's MediaPipe Hand Landmarker (open source, Apache-2.0),
// vendored in vendor/mediapipe (tasks-vision 0.10.14 and the official float16 hand_landmarker model; see
// vendor/mediapipe/README.md). Nothing is downloaded at runtime. Landmarks use the same order and
// video-normalised coordinates that the gesture classifier was trained on (HaGRID's MediaPipe landmarks).
//
// This replaced AEROFORM HandNet, our own landmark model (src/handnet.js, training/train_handnet.py): HandNet
// reached 0.34 palm-length error on FreiHAND/RHD test images but missed real hands and fired on other objects
// with the phone camera. It stays in the repository as a documented experiment.

const asset = path => new URL(`../vendor/mediapipe/${path}`, import.meta.url).href;
export const MEDIAPIPE_VERSION = '0.10.14';
export const MEDIAPIPE_ASSETS = Object.freeze({
  bundle: asset('vision_bundle.mjs'),
  wasmLoaderPath: asset('wasm/vision_wasm_internal.js'),
  wasmBinaryPath: asset('wasm/vision_wasm_internal.wasm'),
  model: asset('hand_landmarker.task')
});

// detector interface (src/hand-tracking.js): { name, detect(video, time) -> {landmarks, presence, ms, mode}, close() }.
// delegate 'auto' tries the GPU first and falls back to the CPU (some phone WebViews fail on GPU).
export async function createMediaPipeDetector({ loadVision = () => import(MEDIAPIPE_ASSETS.bundle), delegate = 'auto', log = () => {}, now = () => performance.now() } = {}) {
  const vision = await loadVision();
  const fileset = { wasmLoaderPath: MEDIAPIPE_ASSETS.wasmLoaderPath, wasmBinaryPath: MEDIAPIPE_ASSETS.wasmBinaryPath };
  const options = d => ({
    baseOptions: { modelAssetPath: MEDIAPIPE_ASSETS.model, delegate: d },
    runningMode: 'VIDEO', numHands: 1,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5
  });
  let landmarker = null, used = null;
  if (delegate !== 'CPU') {
    try { landmarker = await vision.HandLandmarker.createFromOptions(fileset, options('GPU')); used = 'GPU'; }
    catch (error) { log(`GPU hand model failed, using CPU: ${error?.message || error}`); if (delegate === 'GPU') throw error; }
  }
  if (!landmarker) { landmarker = await vision.HandLandmarker.createFromOptions(fileset, options('CPU')); used = 'CPU'; }
  let lastTimestamp = -Infinity;
  return {
    name: `MediaPipe Hand Landmarker ${MEDIAPIPE_VERSION} (Google, open source) · ${used}`,
    delegate: used,
    detect(video, time) {
      const started = now();
      // VIDEO mode needs strictly increasing timestamps.
      const timestamp = Math.max(time, lastTimestamp + 1); lastTimestamp = timestamp;
      const result = landmarker.detectForVideo(video, timestamp);
      const hand = result?.landmarks?.[0] ?? null;
      const score = (result?.handedness ?? result?.handednesses)?.[0]?.[0]?.score ?? null;
      return { landmarks: hand ? [hand] : [], presence: hand ? score : 0, ms: now() - started, mode: hand ? 'tracking' : 'searching' };
    },
    close() { landmarker?.close?.(); landmarker = null; }
  };
}

// Same detector, run in a background thread (src/mediapipe-worker.js) so detection never stalls drawing.
// detect() sends the camera frame as an ImageBitmap and resolves with the worker's result. Rejects from
// creation if the worker cannot start (callers fall back to createMediaPipeDetector on the main thread).
export const MEDIAPIPE_WORKER_URL = new URL('./mediapipe-worker.js', import.meta.url).href;
export function createMediaPipeWorkerDetector({ WorkerClass = globalThis.Worker, url = MEDIAPIPE_WORKER_URL, delegate = 'auto',
  createBitmap = source => createImageBitmap(source), log = () => {}, timeout = 20000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof WorkerClass !== 'function') return Promise.reject(new Error('Web workers are not available'));
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new WorkerClass(url, { type: 'module' }); } catch (error) { reject(error); return; }
    const waiting = new Map(); let nextId = 1, ready = false, closed = false;
    const fail = error => { for (const { reject: r } of waiting.values()) r(error); waiting.clear(); };
    const timer = setTimer(() => { if (!ready) { worker.terminate(); reject(new Error('Hand model worker did not start in time')); } }, timeout);
    worker.onerror = event => { const error = new Error(event?.message || 'Hand model worker failed'); event?.preventDefault?.();
      if (!ready) { clearTimer(timer); worker.terminate(); reject(error); } else fail(error); };
    worker.onmessage = ({ data }) => {
      if (data.type === 'log') log(data.message);
      else if (data.type === 'ready') {
        ready = true; clearTimer(timer);
        resolve({
          name: `${data.name} · background thread`, delegate: data.delegate, worker: true,
          async detect(video, time) {
            if (closed) throw new Error('Hand model closed');
            const frame = await createBitmap(video), id = nextId++;
            return new Promise((done, failed) => { waiting.set(id, { resolve: done, reject: failed }); worker.postMessage({ type: 'detect', id, frame, time }, [frame]); });
          },
          close() { closed = true; fail(new Error('Hand model closed')); worker.terminate(); }
        });
      } else if (data.type === 'result' || (data.type === 'error' && data.id)) {
        const job = waiting.get(data.id); waiting.delete(data.id);
        if (data.type === 'result') job?.resolve({ landmarks: data.landmarks, presence: data.presence, ms: data.ms, mode: data.mode });
        else job?.reject(new Error(data.message));
      } else if (data.type === 'error' && !ready) { clearTimer(timer); worker.terminate(); reject(new Error(data.message)); }
    };
    worker.postMessage({ type: 'init', delegate });
  });
}
