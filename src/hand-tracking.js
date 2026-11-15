// Camera hand tracking with Google's MediaPipe Hand Landmarker (open source, vendored; src/mediapipe-detector.js).
// Our own HandNet (src/hand-detector.js) plugs into the same detector interface but is no longer used. A pinch (thumb tip touching index tip) selects whatever the view's center
// reticle points at. Landmarks: 0 wrist, 4 thumb tip, 8 index tip, 9 middle-finger knuckle, normalized to
// the camera image, so x is scaled by the image aspect before measuring distances.
import { createMediaPipeDetector, createMediaPipeWorkerDetector } from './mediapipe-detector.js';

// Thumb-to-index distance divided by palm length (wrist to middle knuckle): about 1 for an open hand,
// under 0.3 for a pinch. Dividing by palm length makes it independent of hand distance from the camera.
export function pinchRatio(landmarks, aspect = 1) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return null;
  const distance = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y, ((a.z ?? 0) - (b.z ?? 0)) * aspect);
  const palm = distance(landmarks[0], landmarks[9]);
  if (!(palm > 1e-4)) return null;
  const ratio = distance(landmarks[4], landmarks[8]) / palm;
  return Number.isFinite(ratio) ? ratio : null;
}

// Hysteresis stops jitter near the threshold from producing repeated selections. A pinch must hold for
// `holdFrames` frames to start, and a hand missing for `lostFrames` frames ends it without selecting.
export function createPinchDetector({ enter = 0.3, exit = 0.45, holdFrames = 2, lostFrames = 6 } = {}) {
  let pinched = false, below = 0, missing = 0;
  return {
    get pinched() { return pinched; },
    reset() { pinched = false; below = 0; missing = 0; },
    update(ratio) {
      if (ratio === null || !Number.isFinite(ratio)) {
        below = 0;
        if (pinched && ++missing >= lostFrames) { pinched = false; missing = 0; return { pinched, started: false, ended: true }; }
        return { pinched, started: false, ended: false };
      }
      missing = 0;
      if (!pinched) {
        below = ratio < enter ? below + 1 : 0;
        if (below >= holdFrames) { pinched = true; below = 0; return { pinched, started: true, ended: false }; }
        return { pinched, started: false, ended: false };
      }
      if (ratio > exit) { pinched = false; return { pinched, started: false, ended: true }; }
      return { pinched, started: false, ended: false };
    }
  };
}

// detector: { name, detect(video, time) -> Promise<{landmarks: [hand] | [], presence, ms, mode}>, close() }.
export function createHandTracker({
  video,
  onPinch = () => {},
  onPinchEnd = () => {},
  onFrame = () => {},
  onStatus = () => {},
  createDetector = null, // default: MediaPipe (set below, so it can log to the dev view)
  getUserMedia = constraints => {
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw Object.assign(new Error('No camera is available in this browser.'), { name: 'NotSupportedError' });
    return globalThis.navigator.mediaDevices.getUserMedia(constraints);
  },
  schedule = callback => requestAnimationFrame(callback),
  cancel = id => cancelAnimationFrame(id),
  now = () => performance.now(),
  detector: pinchDetector = createPinchDetector(),
  maxFps = 30,
  facingMode = 'environment' // 'environment' = rear camera (headset), 'user' = front camera (testing by hand)
} = {}) {
  let handModel = null, stream = null, frameId = 0, running = false, session = 0, lastDetect = -Infinity, lastVideoTime = -1, pending = false;
  // Diagnostics for the dev view. Nothing here changes tracking behaviour.
  const stats = { state: 'off', message: 'Hand tracking off', facingMode, model: null, mode: null, cameraLabel: '',
    frames: 0, handFrames: 0, fps: 0, detectMs: 0, presence: null, ratio: null, pinched: false,
    hand: null, lastHandAt: null, startedAt: null, error: null, events: [] };
  let fpsWindow = [];
  const log = message => { stats.events.unshift({ at: Math.round(now()), message }); stats.events.length = Math.min(stats.events.length, 12); };
  // Default: MediaPipe in a background thread; if the worker cannot start, on the main thread (works, but
  // each detection briefly holds up drawing).
  const makeDetector = createDetector ?? (() => createMediaPipeWorkerDetector({ log }).catch(error => {
    log(`Background hand model unavailable (${error?.message || error}); running it on the main thread`);
    return createMediaPipeDetector({ log });
  }));
  const status = (state, message) => { stats.state = state; stats.message = message; if (state === 'error') stats.error = message; log(message); onStatus({ state, message }); };

  function process(result, time) {
    const hand = result?.landmarks?.[0] ?? null;
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3;
    const ratio = hand ? pinchRatio(hand, aspect) : null;
    const change = pinchDetector.update(ratio);
    fpsWindow.push(time); while (fpsWindow.length && time - fpsWindow[0] > 1000) fpsWindow.shift();
    const ms = Number.isFinite(result?.ms) ? result.ms : now() - time;
    Object.assign(stats, { frames: stats.frames + 1, handFrames: stats.handFrames + (hand ? 1 : 0), fps: fpsWindow.length,
      detectMs: stats.detectMs ? stats.detectMs * 0.8 + ms * 0.2 : ms, hand, ratio, pinched: change.pinched,
      presence: Number.isFinite(result?.presence) ? result.presence : null, mode: result?.mode ?? null });
    if (hand) stats.lastHandAt = time;
    if (change.started) log('Pinch');
    onFrame({ hand, ratio, pinched: change.pinched, aspect });
    if (change.started) onPinch({ hand, aspect });
    if (change.ended) onPinchEnd();
  }

  function loop(current) {
    if (!running || current !== session) return;
    frameId = schedule(() => loop(current));
    const time = now();
    // One frame in flight at a time: the model runs in a worker, so the view keeps rendering meanwhile.
    if (pending || time - lastDetect < 1000 / maxFps || video.readyState < 2) return;
    // Some Android WebViews do not advance currentTime for camera streams; detect at least every 100 ms anyway.
    if (video.currentTime === lastVideoTime && time - lastDetect < 100) return;
    lastDetect = time; lastVideoTime = video.currentTime; pending = true;
    Promise.resolve().then(() => handModel.detect(video, time)).then(result => {
      pending = false;
      if (running && current === session) process(result, time);
    }, error => {
      pending = false;
      if (current !== session) return;
      stop(); status('error', `Hand tracking stopped: ${error?.message || error}`);
    });
  }

  async function start() {
    if (running) return true;
    const current = ++session;
    stats.error = null;
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      status('error', 'Hand tracking needs HTTPS or the Android app. Phones block the camera on plain HTTP pages, such as the laptop LAN address.');
      return false;
    }
    status('starting', `Starting ${facingMode === 'user' ? 'front' : 'rear'} camera…`);
    try {
      stream = await getUserMedia({ video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (current !== session) { stream.getTracks().forEach(track => track.stop()); return false; }
      const track = stream.getVideoTracks?.()[0];
      stats.cameraLabel = track?.label || '';
      stats.facingMode = track?.getSettings?.().facingMode || facingMode;
      video.srcObject = stream; video.muted = true; video.playsInline = true;
      await video.play();
      log(`Camera ${stats.cameraLabel || 'started'} ${video.videoWidth || '?'}×${video.videoHeight || '?'}`);
      status('starting', 'Loading hand model…');
      handModel ??= await makeDetector();
      stats.model = handModel.name ?? 'hand model';
      if (current !== session) return false;
    } catch (error) {
      if (current === session) {
        release();
        const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
        status('error', denied ? 'Camera access was denied. Allow the camera to use hand tracking.' : `Hand tracking could not start: ${error?.message || error}`);
      }
      return false;
    }
    running = true; pinchDetector.reset(); lastDetect = -Infinity; lastVideoTime = -1; fpsWindow = []; pending = false;
    Object.assign(stats, { frames: 0, handFrames: 0, fps: 0, detectMs: 0, hand: null, ratio: null, startedAt: now(), lastHandAt: null });
    status('tracking', 'Hand tracking on · pinch to select');
    frameId = schedule(() => loop(current));
    return true;
  }

  function release() {
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    if (video) video.srcObject = null;
  }
  function stop() {
    const wasPinched = pinchDetector.pinched;
    session++; running = false; cancel(frameId); release(); pinchDetector.reset();
    if (wasPinched) onPinchEnd();
    Object.assign(stats, { hand: null, ratio: null, pinched: false, fps: 0 });
    status('off', 'Hand tracking off');
  }

  return {
    start, stop,
    get running() { return running; },
    diagnostics: () => ({ ...stats, events: [...stats.events], video: video ? { width: video.videoWidth || 0, height: video.videoHeight || 0, readyState: video.readyState ?? 0, currentTime: video.currentTime ?? 0 } : null }),
    // Changing camera restarts tracking if it is running.
    async setOptions(next = {}) {
      const restart = running;
      if (next.facingMode && next.facingMode !== facingMode) { facingMode = next.facingMode; stats.facingMode = facingMode; }
      if (restart) { stop(); return start(); }
      return false;
    },
    get options() { return { facingMode }; },
    dispose() { stop(); handModel?.close?.(); handModel = null; }
  };
}
