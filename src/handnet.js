// AEROFORM HandNet inference in plain JS: runs the network exported by training/train_handnet.py
// (models/handnet.json). No ML library or downloaded model is involved. Tensors are channel-last
// (HWC) Float32Arrays, so 1x1 convolutions are dot products over neighbouring memory; batch-norm is already
// folded into the convolution weights.

export const HANDNET_URL = new URL('../models/handnet.json', import.meta.url).href;

function decodeBase64(text) {
  if (typeof atob === 'function') {
    const bin = atob(text), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  const b = Buffer.from(text, 'base64');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// 1x1 convolution: out[p, o] = b[o] + sum_i W[o, i] * x[p, i].
function pointwise(x, L) {
  const { h, w, c: cin } = x, cout = L.cout, X = x.data, W = L.w, B = L.b, plane = h * w, out = new Float32Array(plane * cout);
  for (let p = 0; p < plane; p++) {
    const xi = p * cin, oi = p * cout;
    for (let o = 0; o < cout; o++) {
      const wi = o * cin;
      let s0 = B[o], s1 = 0, s2 = 0, s3 = 0, i = 0;
      for (; i + 3 < cin; i += 4) { s0 += W[wi + i] * X[xi + i]; s1 += W[wi + i + 1] * X[xi + i + 1]; s2 += W[wi + i + 2] * X[xi + i + 2]; s3 += W[wi + i + 3] * X[xi + i + 3]; }
      for (; i < cin; i++) s0 += W[wi + i] * X[xi + i];
      const v = s0 + s1 + s2 + s3;
      out[oi + o] = L.relu && v < 0 ? 0 : v;
    }
  }
  return { h, w, c: cout, data: out };
}

// 3x3 depthwise convolution, padding 1. Weights pre-arranged as [tap][channel].
function depthwise(x, L) {
  const { h, w, c } = x, s = L.stride, ho = Math.ceil(h / s), wo = Math.ceil(w / s), X = x.data, T = L.taps, B = L.b;
  const out = new Float32Array(ho * wo * c);
  for (let oy = 0; oy < ho; oy++) {
    for (let ox = 0; ox < wo; ox++) {
      const o = (oy * wo + ox) * c;
      for (let ch = 0; ch < c; ch++) out[o + ch] = B[ch];
      for (let ky = 0; ky < 3; ky++) {
        const iy = oy * s - 1 + ky; if (iy < 0 || iy >= h) continue;
        for (let kx = 0; kx < 3; kx++) {
          const ix = ox * s - 1 + kx; if (ix < 0 || ix >= w) continue;
          const src = (iy * w + ix) * c, t = (ky * 3 + kx) * c;
          for (let ch = 0; ch < c; ch++) out[o + ch] += T[t + ch] * X[src + ch];
        }
      }
      if (L.relu) for (let ch = 0; ch < c; ch++) if (out[o + ch] < 0) out[o + ch] = 0;
    }
  }
  return { h: ho, w: wo, c, data: out };
}

// Full 3x3 convolution (the stem, 3 input channels), padding 1. Weights pre-arranged as [out][ky][kx][in].
function full3x3(x, L) {
  const { h, w, c: cin } = x, s = L.stride, ho = Math.ceil(h / s), wo = Math.ceil(w / s), X = x.data, K = L.kernel, B = L.b, cout = L.cout;
  const out = new Float32Array(ho * wo * cout);
  for (let oy = 0; oy < ho; oy++) for (let ox = 0; ox < wo; ox++) {
    const o = (oy * wo + ox) * cout;
    for (let oc = 0; oc < cout; oc++) {
      let sum = B[oc];
      for (let ky = 0; ky < 3; ky++) {
        const iy = oy * s - 1 + ky; if (iy < 0 || iy >= h) continue;
        for (let kx = 0; kx < 3; kx++) {
          const ix = ox * s - 1 + kx; if (ix < 0 || ix >= w) continue;
          const src = (iy * w + ix) * cin, k = ((oc * 3 + ky) * 3 + kx) * cin;
          for (let i = 0; i < cin; i++) sum += K[k + i] * X[src + i];
        }
      }
      out[o + oc] = L.relu && sum < 0 ? 0 : sum;
    }
  }
  return { h: ho, w: wo, c: cout, data: out };
}

export function createHandNet(model) {
  if (model?.format !== 'aeroform-handnet-v1') throw new Error('Unsupported hand model file.');
  const weights = new Float32Array(decodeBase64(model.weights));
  const size = shape => shape.reduce((a, b) => a * b, 1);
  const layers = {};
  for (const [name, L] of Object.entries(model.layers)) {
    const w = weights.subarray(L.weight.offset, L.weight.offset + size(L.weight.shape));
    const b = weights.subarray(L.bias.offset, L.bias.offset + size(L.bias.shape));
    const [cout, cinPerGroup, k] = L.weight.shape;
    const layer = { ...L, w, b, cout };
    if (k === 3 && L.groups > 1) { // depthwise: [c,1,3,3] -> [tap][c]
      layer.kind = 'dw'; layer.taps = new Float32Array(9 * cout);
      for (let ch = 0; ch < cout; ch++) for (let t = 0; t < 9; t++) layer.taps[t * cout + ch] = w[ch * 9 + t];
    } else if (k === 3) { // full: [o,i,3,3] -> [o][ky][kx][i]
      layer.kind = 'full'; layer.kernel = new Float32Array(w.length);
      for (let o = 0; o < cout; o++) for (let i = 0; i < cinPerGroup; i++) for (let t = 0; t < 9; t++) layer.kernel[(o * 9 + t) * cinPerGroup + i] = w[(o * cinPerGroup + i) * 9 + t];
    } else layer.kind = 'pw';
    layers[name] = layer;
  }
  const conv = (x, L) => L.kind === 'pw' ? pointwise(x, L) : L.kind === 'dw' ? depthwise(x, L) : full3x3(x, L);
  const run = (x, names) => names.reduce((t, n) => conv(conv(t, layers[`${n}.dw`]), layers[`${n}.pw`]), x);
  // ReLU(nearest-upsampled small + skip), both HWC with the same channel count.
  function upAdd(small, skip) {
    const { h, w, c } = skip, out = new Float32Array(skip.data.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * c, si = ((y >> 1) * small.w + (x >> 1)) * c;
      for (let ch = 0; ch < c; ch++) { const v = small.data[si + ch] + skip.data[o + ch]; out[o + ch] = v > 0 ? v : 0; }
    }
    return { h, w, c, data: out };
  }

  // input: Float32Array N x N x 3 (RGB, 0..1, channel-last). Keypoints come back in 0..1 crop units.
  function forward(input) {
    const n = model.input, g = model.graph;
    let x = conv({ h: n, w: n, c: 3, data: input }, layers.stem);
    x = run(x, g.s64);
    const f32 = run(x, g.s32), f16 = run(f32, g.s16), f8 = run(f16, g.s8);
    const P = layers.presence, c8 = f8.c, area = f8.h * f8.w, mean = new Float32Array(c8);
    for (let p = 0; p < area; p++) for (let ch = 0; ch < c8; ch++) mean[ch] += f8.data[p * c8 + ch];
    let presence = P.b[0];
    for (let ch = 0; ch < c8; ch++) presence += P.w[ch] * mean[ch] / area;
    let u = run(upAdd(f8, conv(f16, layers.skip16)), g.up16);
    u = run(upAdd(u, conv(f32, layers.skip32)), g.up32);
    const heat = conv(u, layers.head), hw = heat.h * heat.w, K = heat.c;
    const keypoints = [];
    for (let k = 0; k < K; k++) {
      let max = -Infinity;
      for (let p = 0; p < hw; p++) max = Math.max(max, heat.data[p * K + k]);
      let total = 0, sx = 0, sy = 0;
      for (let y = 0; y < heat.h; y++) for (let x2 = 0; x2 < heat.w; x2++) {
        const e = Math.exp(heat.data[(y * heat.w + x2) * K + k] - max);
        total += e; sx += e * (x2 + 0.5) / heat.w; sy += e * (y + 0.5) / heat.h;
      }
      keypoints.push({ x: sx / total, y: sy / total, z: 0 });
    }
    return { keypoints, presenceLogit: presence, presence: 1 / (1 + Math.exp(-presence)) };
  }

  // rgba: Uint8ClampedArray N*N*4 from a canvas -> HWC RGB floats.
  function fromPixels(rgba) {
    const n = model.input, out = new Float32Array(n * n * 3);
    for (let p = 0, q = 0; p < n * n; p++, q += 4) { out[p * 3] = rgba[q] / 255; out[p * 3 + 1] = rgba[q + 1] / 255; out[p * 3 + 2] = rgba[q + 2] / 255; }
    return out;
  }
  // The training script's check pattern is channel-first; this builds the same input channel-last.
  function checkInput() {
    const n = model.input, plane = n * n, out = new Float32Array(3 * plane);
    for (let i = 0; i < 3 * plane; i++) { const v = Math.sin(i * 12.9898) * 43758.5453, c = Math.floor(i / plane), p = i % plane; out[p * 3 + c] = v - Math.floor(v); }
    return out;
  }

  return { input: model.input, metrics: model.metrics ?? null, forward, fromPixels, checkInput, detectPixels: rgba => forward(fromPixels(rgba)) };
}
