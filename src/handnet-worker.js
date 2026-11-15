// Runs AEROFORM HandNet off the main thread so the 3D/VR view never waits for hand detection.
import { createHandNet, HANDNET_URL } from './handnet.js';

let net = null;
self.onmessage = async event => {
  const message = event.data;
  try {
    if (message.type === 'load') {
      const response = await fetch(message.url || HANDNET_URL);
      if (!response.ok) throw new Error(`Hand model could not load (${response.status}).`);
      net = createHandNet(await response.json());
      self.postMessage({ type: 'ready', input: net.input });
    } else if (message.type === 'detect') {
      const started = performance.now();
      const result = net.detectPixels(message.pixels);
      self.postMessage({ type: 'result', id: message.id, ...result, ms: performance.now() - started });
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: message.id, message: error.message || String(error) });
  }
};
