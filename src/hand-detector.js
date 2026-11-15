// Camera frame -> 21 hand landmarks with AEROFORM HandNet (our own model), run in a Web Worker.
// Searching: the whole frame, letterboxed into the square input. Tracking: a square crop around the last
// hand (about 1.8x its size), which keeps the hand large in the input like the training data. Losing the
// hand returns to searching. Landmarks come back in video-normalised coordinates, like MediaPipe's.
import { HANDNET_URL } from './handnet.js';

export const HANDNET_WORKER_URL = new URL('./handnet-worker.js', import.meta.url).href;
export const PRESENCE_THRESHOLD = 0.5;

// Square source region (video pixels) for this frame.
export function cropForFrame(roi, videoWidth, videoHeight) {
  if (roi) return { ...roi };
  const side = Math.max(videoWidth, videoHeight);
  return { cx: videoWidth / 2, cy: videoHeight / 2, side };
}
// Next tracking region from landmarks in video pixels, or null to search the whole frame again.
export function roiFromLandmarks(points, videoWidth, videoHeight) {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  const side = Math.max(w, h) * 1.8, minSide = 0.2 * Math.min(videoWidth, videoHeight);
  if (!(side > 0)) return null;
  return { cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2, side: Math.min(Math.max(side, minSide), 1.5 * Math.max(videoWidth, videoHeight)) };
}
// Crop-relative keypoints (0..1) -> video pixels.
export const toVideoPixels = (keypoints, crop) => keypoints.map(k => ({ x: crop.cx - crop.side / 2 + k.x * crop.side, y: crop.cy - crop.side / 2 + k.y * crop.side }));

export function createLandmarkSmoother(alpha = 0.55) {
  let last = null;
  return {
    reset() { last = null; },
    update(points) {
      last = last ? points.map((p, i) => ({ x: last[i].x + alpha * (p.x - last[i].x), y: last[i].y + alpha * (p.y - last[i].y), z: 0 })) : points.map(p => ({ ...p, z: 0 }));
      return last;
    }
  };
}

export async function createHandNetDetector({
  modelUrl = HANDNET_URL,
  createWorker = () => new Worker(HANDNET_WORKER_URL, { type: 'module' }),
  createCanvas = size => typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size })
} = {}) {
  const worker = createWorker();
  let nextId = 0, input = 128;
  const waiting = new Map();
  const ready = new Promise((resolve, reject) => {
    worker.onmessage = event => {
      const m = event.data;
      if (m.type === 'ready') { input = m.input; resolve(); return; }
      const job = waiting.get(m.id);
      if (m.type === 'error') { if (job) { waiting.delete(m.id); job.reject(new Error(m.message)); } else reject(new Error(m.message)); return; }
      if (job) { waiting.delete(m.id); job.resolve(m); }
    };
    worker.onerror = event => reject(new Error(event.message || 'Hand model worker failed.'));
  });
  worker.postMessage({ type: 'load', url: modelUrl });
  await ready;
  const canvas = createCanvas(input), ctx = canvas.getContext('2d', { willReadFrequently: true });
  const smoother = createLandmarkSmoother();
  let roi = null;

  return {
    name: 'AEROFORM HandNet (own model, worker)',
    get tracking() { return roi !== null; },
    async detect(video) {
      const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
      const crop = cropForFrame(roi, vw, vh);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, input, input);
      // Map the square source region onto the canvas; parts outside the video stay black.
      const scale = input / crop.side, sx = crop.cx - crop.side / 2, sy = crop.cy - crop.side / 2;
      ctx.drawImage(video, 0, 0, vw, vh, (0 - sx) * scale, (0 - sy) * scale, vw * scale, vh * scale);
      const pixels = ctx.getImageData(0, 0, input, input).data;
      const id = ++nextId;
      const result = await new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ type: 'detect', id, pixels }, [pixels.buffer]); });
      const mode = roi ? 'tracking' : 'searching';
      if (result.presence < PRESENCE_THRESHOLD) { roi = null; smoother.reset(); return { landmarks: [], presence: result.presence, ms: result.ms, mode }; }
      const pixelsOut = toVideoPixels(result.keypoints, crop);
      roi = roiFromLandmarks(pixelsOut, vw, vh);
      const smoothed = smoother.update(pixelsOut.map(p => ({ x: p.x / vw, y: p.y / vh, z: 0 })));
      return { landmarks: [smoothed], presence: result.presence, ms: result.ms, mode };
    },
    close() { worker.terminate(); waiting.clear(); }
  };
}
