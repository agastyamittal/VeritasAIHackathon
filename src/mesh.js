// Local STL/OBJ parsing for cloud models. Geometry only: no materials, textures or units are read.
// Models are fitted to an 8 m bounding size, centred on the origin and placed on the ground plane.
export const RENDERABLE_EXTENSIONS = new Set(['stl', 'obj']);
export const MAX_MODEL_TRIANGLES = 2000000;
export const MODEL_FIT_METRES = 8;

export const extensionOf = name => {
  const parts = String(name).toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
};
export const canRender = name => RENDERABLE_EXTENSIONS.has(extensionOf(name));

const bytesOf = data => data instanceof Uint8Array ? data : new Uint8Array(data);

function isBinaryStl(bytes) {
  if (bytes.byteLength < 84) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  if (84 + count * 50 === bytes.byteLength) return true;
  // Some exporters start binary headers with "solid", so ASCII also needs facet keywords.
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 1024))).trimStart().toLowerCase();
  return !(head.startsWith('solid') && /facet|endsolid/.test(head));
}

export function parseStl(data) {
  const bytes = bytesOf(data);
  if (isBinaryStl(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    if (count > MAX_MODEL_TRIANGLES) throw new Error(`This model has ${count.toLocaleString()} triangles; the limit is ${MAX_MODEL_TRIANGLES.toLocaleString()}.`);
    if (84 + count * 50 > bytes.byteLength) throw new Error('This STL file is truncated or damaged.');
    const positions = new Float32Array(count * 9);
    for (let i = 0; i < count; i++) {
      const offset = 84 + i * 50 + 12;
      for (let j = 0; j < 9; j++) positions[i * 9 + j] = view.getFloat32(offset + j * 4, true);
    }
    return positions;
  }
  const text = new TextDecoder().decode(bytes);
  const values = [];
  for (const match of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)) values.push(Number(match[1]), Number(match[2]), Number(match[3]));
  if (values.length % 9) throw new Error('This STL file has an incomplete triangle.');
  return new Float32Array(values);
}

export function parseObj(data) {
  const text = new TextDecoder().decode(bytesOf(data));
  const vertices = [], positions = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.split(/\s+/).map(Number);
      vertices.push([x, y, z]);
    } else if (line.startsWith('f ')) {
      const corners = line.split(/\s+/).slice(1).map(token => {
        const index = parseInt(token.split('/')[0], 10);
        const resolved = index < 0 ? vertices.length + index : index - 1;
        const vertex = vertices[resolved];
        if (!vertex) throw new Error('This OBJ file refers to a missing vertex.');
        return vertex;
      });
      for (let i = 1; i + 1 < corners.length; i++) positions.push(...corners[0], ...corners[i], ...corners[i + 1]);
      if (positions.length / 9 > MAX_MODEL_TRIANGLES) throw new Error(`This model has more than ${MAX_MODEL_TRIANGLES.toLocaleString()} triangles.`);
    }
  }
  return new Float32Array(positions);
}

// positions: flat xyz triangle list. Returns interleaved position + flat normal, as the viewer's cube buffer uses.
export function buildMesh(positions, { zUp = false } = {}) {
  const triangles = Math.floor(positions.length / 9);
  if (!triangles) throw new Error('No triangles were found in this file.');
  if (triangles > MAX_MODEL_TRIANGLES) throw new Error(`This model has more than ${MAX_MODEL_TRIANGLES.toLocaleString()} triangles.`);
  const point = i => zUp ? [positions[i], positions[i + 2], -positions[i + 1]] : [positions[i], positions[i + 1], positions[i + 2]];
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < triangles * 9; i += 3) {
    const p = point(i);
    if (!p.every(Number.isFinite)) throw new Error('This model contains invalid coordinates.');
    for (let k = 0; k < 3; k++) { low[k] = Math.min(low[k], p[k]); high[k] = Math.max(high[k], p[k]); }
  }
  const sourceSize = high.map((v, k) => v - low[k]);
  const extent = Math.max(...sourceSize);
  if (!(extent > 0)) throw new Error('This model has no size.');
  const scale = MODEL_FIT_METRES / extent;
  const shift = [-(low[0] + high[0]) / 2, -low[1], -(low[2] + high[2]) / 2];
  const vertices = new Float32Array(triangles * 18);
  for (let t = 0; t < triangles; t++) {
    const [a, b, c] = [0, 1, 2].map(k => point(t * 9 + k * 3).map((v, axis) => (v + shift[axis]) * scale));
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...n);
    n = length > 0 ? n.map(x => x / length) : [0, 1, 0];
    [a, b, c].forEach((p, k) => vertices.set([...p, ...n], t * 18 + k * 6));
  }
  return { vertices, triangles, size: sourceSize.map(v => v * scale), sourceSize, scale };
}

export function parseModel(name, data) {
  const extension = extensionOf(name);
  if (extension === 'stl') return buildMesh(parseStl(data), { zUp: true });
  if (extension === 'obj') return buildMesh(parseObj(data));
  throw new Error('3D preview supports STL and OBJ files.');
}
