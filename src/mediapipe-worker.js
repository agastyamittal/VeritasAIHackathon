// Runs MediaPipe Hand Landmarker in a background thread, so hand tracking never stalls the 3D view (on the
// main thread each detection held up drawing; in VR that showed as stutter). Main side: src/mediapipe-detector.js
// (createMediaPipeWorkerDetector). Messages:
//   in:  {type:'init', delegate}            out: {type:'ready', name, delegate} | {type:'error', message}
//   in:  {type:'detect', id, frame, time}   out: {type:'result', id, landmarks, presence, ms, mode} | {type:'error', id, message}
//   out: {type:'log', message}
// frame is an ImageBitmap of the camera frame, transferred here and closed after use.
import { createMediaPipeDetector } from './mediapipe-detector.js';

// tasks-vision loads its WebAssembly loader (vendor/mediapipe/wasm/vision_wasm_internal.js, same origin, hash
// in vendor/mediapipe/README.md) with importScripts, which module workers do not allow. This does the same:
// a synchronous same-origin request, run in the worker's global scope.
self.importScripts = (...urls) => {
  for (const url of urls) {
    const request = new XMLHttpRequest();
    request.open('GET', url, false); request.send();
    if (request.status !== 200 && request.status !== 0) throw new Error(`Could not load ${url} (${request.status})`);
    (0, eval)(`${request.responseText}\n//# sourceURL=${url}`);
  }
};

let detector = null;
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      detector = await createMediaPipeDetector({ delegate: data.delegate ?? 'auto', log: message => self.postMessage({ type: 'log', message }) });
      self.postMessage({ type: 'ready', name: detector.name, delegate: detector.delegate });
    } catch (error) { self.postMessage({ type: 'error', message: String(error?.message || error) }); }
  } else if (data.type === 'detect') {
    try {
      const result = detector.detect(data.frame, data.time);
      // Landmarks as plain {x, y, z} objects (structured-cloneable, small).
      const landmarks = result.landmarks.map(hand => hand.map(({ x, y, z }) => ({ x, y, z })));
      self.postMessage({ type: 'result', id: data.id, ...result, landmarks });
    } catch (error) { self.postMessage({ type: 'error', id: data.id, message: String(error?.message || error) }); }
    finally { data.frame?.close?.(); }
  }
};
