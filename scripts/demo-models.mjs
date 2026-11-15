// Demo 3D models for AEROFORM, generated from simple solids so they are our own (no third-party assets).
//   node scripts/demo-models.mjs        writes samples/*.obj and samples/*.stl
// The files are checked in; tests/core.test.mjs regenerates them in memory and checks they match byte for byte.
// Geometry is built Y-up in metres. OBJ files are written Y-up; STL files Z-up (the convention the app's STL
// reader assumes). Triangles wind counter-clockwise seen from outside, so the viewer lights them correctly.
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const round = v => Math.round(v * 1e4) / 1e4;

function createMesh() {
  const tris = [];
  const mesh = {
    tris,
    // Triangle facing away from `inside` (a point inside the solid); flipped if needed.
    tri(a, b, c, inside) {
      const n = cross(sub(b, a), sub(c, a)), centre = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      tris.push(inside && dot(n, sub(centre, inside)) < 0 ? [a, c, b] : [a, b, c]);
    },
    quad(a, b, c, d, inside) { mesh.tri(a, b, c, inside); mesh.tri(a, c, d, inside); },
    // Any six-faced solid from its 8 corners: bottom 0-3 and top 4-7, in the same order around.
    hexa(p) {
      const inside = p.reduce((s, v) => [s[0] + v[0] / 8, s[1] + v[1] / 8, s[2] + v[2] / 8], [0, 0, 0]);
      for (const [a, b, c, d] of [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) mesh.quad(p[a], p[b], p[c], p[d], inside);
    },
    // Axis-aligned box from its minimum corner and size.
    box([x, y, z], [w, h, d]) { mesh.hexa([[x, y, z], [x + w, y, z], [x + w, y, z + d], [x, y, z + d], [x, y + h, z], [x + w, y + h, z], [x + w, y + h, z + d], [x, y + h, z + d]]); },
    // Box centred at c, size s, turned by `angle` (radians) about the vertical axis through `pivot`.
    turnedBox(c, s, angle, pivot = [0, 0, 0]) {
      const turn = ([x, y, z]) => { const dx = x - pivot[0], dz = z - pivot[2]; return [pivot[0] + dx * Math.cos(angle) - dz * Math.sin(angle), y, pivot[2] + dx * Math.sin(angle) + dz * Math.cos(angle)]; };
      const [x0, x1, y0, y1, z0, z1] = [c[0] - s[0] / 2, c[0] + s[0] / 2, c[1] - s[1] / 2, c[1] + s[1] / 2, c[2] - s[2] / 2, c[2] + s[2] / 2];
      mesh.hexa([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]].map(turn));
    },
    // Vertical cylinder (closed), centre of the base at c.
    cylinder(c, radius, height, segments = 16) {
      const ring = y => Array.from({ length: segments }, (_, i) => { const a = 2 * Math.PI * i / segments; return [c[0] + radius * Math.cos(a), y, c[2] + radius * Math.sin(a)]; });
      const lo = ring(c[1]), hi = ring(c[1] + height), mid = [c[0], c[1] + height / 2, c[2]];
      for (let i = 0; i < segments; i++) {
        const j = (i + 1) % segments;
        mesh.quad(lo[i], lo[j], hi[j], hi[i], mid);
        mesh.tri([c[0], c[1], c[2]], lo[j], lo[i], mid); mesh.tri([c[0], c[1] + height, c[2]], hi[i], hi[j], mid);
      }
    },
    // A straight bar of square section between two points (handrails, struts, sloping columns).
    bar(a, b, size) {
      const d = sub(b, a), up = Math.abs(d[1]) > 0.9 * Math.hypot(...d) ? [1, 0, 0] : [0, 1, 0];
      const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
      const u = norm(cross(d, up)).map(x => x * size / 2), v = norm(cross(d, u)).map(x => x * size / 2);
      const corners = p => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => [p[0] + s * u[0] + t * v[0], p[1] + s * u[1] + t * v[1], p[2] + s * u[2] + t * v[2]]);
      mesh.hexa([...corners(a), ...corners(b)]);
    }
  };
  return mesh;
}

// 1. Modern cabin: raised floor, glass front (left open so you can look and walk in), mono-pitch roof with
// overhangs, a deck with steps, a chimney and a kitchen island. About 10 x 4.5 x 9 m.
function cabin() {
  const m = createMesh(), W = 9, D = 6, wall = 0.2;
  m.box([0, 0, 0], [W, 0.3, D]);                                    // floor slab
  m.box([0, 0.3, 0], [W, 3.1, wall]);                               // back wall
  m.box([0, 0.3, wall], [wall, 3.1, D - wall]);                     // west wall
  m.box([W - wall, 0.3, wall], [wall, 3.1, 2.2]);                   // east wall, back part
  m.box([W - wall, 0.3, 3.6], [wall, 3.1, D - 3.6]);                // east wall, front part (door gap)
  m.box([W - wall, 2.5, 2.4], [wall, 0.9, 1.2]);                    // lintel over the side door
  for (const x of [0, 2.9, 5.9, W - wall]) m.box([x, 0.3, D - wall], [wall, 3.1, wall]); // front piers
  m.box([0, 3.1, D - wall], [W, 0.4, wall]);                        // front header
  m.box([3.1, 0.3, 1.4], [0.15, 2.6, 2.8]);                         // partition
  m.box([5.4, 0.3, 2.4], [2.2, 0.95, 0.9]);                         // kitchen island
  m.box([0.6, 0.3, 0.4], [2.2, 0.45, 0.9]);                         // bench
  // Mono-pitch roof: high at the front, low at the back, 0.6 m overhang all round.
  const o = 0.6, t = 0.25, back = 3.4, front = 4.3;
  m.hexa([[-o, back, -o], [W + o, back, -o], [W + o, front, D + o], [-o, front, D + o], [-o, back + t, -o], [W + o, back + t, -o], [W + o, front + t, D + o], [-o, front + t, D + o]]);
  m.box([6.6, 3.2, 0.6], [0.7, 2.2, 0.7]);                          // chimney
  m.box([0, 0, D], [W, 0.22, 2.4]);                                 // deck
  for (let i = 0; i < 2; i++) m.box([3.5, 0, D + 2.4 + i * 0.35], [2, 0.22 - (i + 1) * 0.08, 0.35]); // steps
  return m;
}

// 2. Twisting tower: 14 square floors, each turned 6 degrees from the one below, round core through the
// middle and sloping columns joining the corners of each floor to the next.
function tower() {
  const m = createMesh(), floors = 14, step = 1.0, half = 2.2, twist = 6 * Math.PI / 180;
  const corner = (k, i) => { const a = i * twist + Math.PI / 4 + k * Math.PI / 2, r = half * Math.SQRT2 - 0.25; return [r * Math.cos(a), i * step, r * Math.sin(a)]; };
  for (let i = 0; i < floors; i++) {
    m.turnedBox([0, i * step + 0.1, 0], [2 * half, 0.2, 2 * half], i * twist);
    if (i < floors - 1) for (let k = 0; k < 4; k++) { const a = corner(k, i), b = corner(k, i + 1); m.bar([a[0], a[1] + 0.2, a[2]], b, 0.16); }
  }
  m.cylinder([0, 0, 0], 0.75, floors * step + 0.6, 20);
  m.cylinder([0, -0.3, 0], 3.4, 0.3, 24);                           // plinth
  return m;
}

// 3. Geodesic dome pavilion: a frequency-3 geodesic hemisphere (6 m across), an entrance cut on one side, a
// round platform and a ring beam.
function dome() {
  const m = createMesh(), R = 3, t = (1 + Math.sqrt(5)) / 2;
  const base = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  const faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const onSphere = p => { const l = Math.hypot(...p); return p.map(v => v / l * R); };
  const lift = 0.35, centre = [0, lift, 0];
  for (const [a, b, c] of faces) {
    const A = base[a], B = base[b], C = base[c], n = 3, pt = (i, j) => onSphere([0, 1, 2].map(k => A[k] + (B[k] - A[k]) * i / n + (C[k] - A[k]) * j / n));
    for (let i = 0; i < n; i++) for (let j = 0; i + j < n; j++) {
      const tris = [[pt(i, j), pt(i + 1, j), pt(i, j + 1)]];
      if (i + j < n - 1) tris.push([pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)]);
      for (const tri of tris) {
        const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3, cz = (tri[0][2] + tri[1][2] + tri[2][2]) / 3, cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
        if (cy < 0.05) continue;                                    // upper half only
        if (cz > 1.6 && cy < 1.9 && Math.abs(cx) < 1.1) continue;   // entrance
        m.tri(...tri.map(p => [p[0], p[1] + lift, p[2]]), centre);
      }
    }
  }
  m.cylinder([0, 0, 0], R + 0.8, lift, 32);                          // platform
  m.cylinder([0, lift, 0], 0.5, 0.75, 12);                            // table
  return m;
}

// 4. Spiral stair: 20 treads turning 18 degrees each around a central column, a post at the end of each tread,
// a continuous handrail and a landing at the top.
function stair() {
  const m = createMesh(), treads = 20, rise = 0.19, turn = 18 * Math.PI / 180, length = 1.2;
  m.cylinder([0, 0, 0], 0.12, treads * rise + 1.0, 16);
  const tops = [];
  for (let i = 0; i < treads; i++) {
    const a = i * turn, y = (i + 1) * rise;
    m.turnedBox([length / 2 + 0.05, y - 0.03, 0], [length, 0.06, 0.42], a);
    const end = [Math.cos(a) * (length - 0.05), y, Math.sin(a) * (length - 0.05)];
    m.bar(end, [end[0], y + 0.95, end[2]], 0.035);
    tops.push([end[0], y + 0.95, end[2]]);
  }
  for (let i = 1; i < tops.length; i++) m.bar(tops[i - 1], tops[i], 0.05);
  const a = treads * turn;
  m.turnedBox([0.75, treads * rise + 0.03 - 0.03, 0.3], [1.5, 0.06, 1.4], a); // landing
  m.cylinder([0, -0.05, 0], 1.5, 0.05, 24);                           // floor disc
  return m;
}

function toObj(mesh, title) {
  const lines = [`# ${title}`, '# AEROFORM demo model, generated by scripts/demo-models.mjs (metres, Y up)'], index = new Map(), faces = [];
  const id = p => { const key = p.map(round).join(' '); if (!index.has(key)) { index.set(key, index.size + 1); lines.push(`v ${key}`); } return index.get(key); };
  for (const [a, b, c] of mesh.tris) faces.push(`f ${id(a)} ${id(b)} ${id(c)}`);
  return Buffer.from([...lines, ...faces, ''].join('\n'), 'utf8');
}
function toStl(mesh, title) {
  // Binary STL, Z up: a Y-up point (x, y, z) is written as (x, -z, y), a rotation, so winding is kept.
  const out = Buffer.alloc(84 + mesh.tris.length * 50);
  out.write(`AEROFORM demo model: ${title} (metres, Z up)`.slice(0, 80), 0, 'ascii');
  out.writeUInt32LE(mesh.tris.length, 80);
  mesh.tris.forEach((tri, i) => {
    const p = tri.map(([x, y, z]) => [round(x), round(-z), round(y)]), n = cross(sub(p[1], p[0]), sub(p[2], p[0])), l = Math.hypot(...n) || 1;
    let o = 84 + i * 50;
    for (const v of [n.map(x => x / l), ...p]) for (const x of v) { out.writeFloatLE(x, o); o += 4; }
  });
  return out;
}

export const DEMO_MODELS = Object.freeze([
  { file: 'samples/modern-cabin.obj', label: 'Modern cabin', description: 'Glass front, mono-pitch roof, deck', build: cabin, format: toObj },
  { file: 'samples/twisting-tower.stl', label: 'Twisting tower', description: '14 floors, each turned 6°', build: tower, format: toStl },
  { file: 'samples/geodesic-dome.obj', label: 'Geodesic dome', description: 'Pavilion with an entrance', build: dome, format: toObj },
  { file: 'samples/spiral-stair.stl', label: 'Spiral stair', description: '20 treads with a handrail', build: stair, format: toStl }
]);
export const buildDemoModels = () => DEMO_MODELS.map(d => { const mesh = d.build(); return { file: d.file, label: d.label, triangles: mesh.tris.length, bytes: d.format(mesh, d.label) }; });

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = new URL('../', import.meta.url);
  await mkdir(new URL('samples/', root), { recursive: true });
  for (const model of buildDemoModels()) {
    await writeFile(new URL(model.file, root), model.bytes);
    console.log(`${model.file}: ${model.triangles} triangles, ${(model.bytes.length / 1024).toFixed(0)} KB`);
  }
}
