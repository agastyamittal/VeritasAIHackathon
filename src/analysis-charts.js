// Charts for the Analysis panel, as SVG/HTML strings built from simulation results.
// Colours: categorical slots 1-3 (dark steps, validated on the panel surface #171717 (neutral dark grey since the UI went grey; was #112019) with the dataviz
// validator), a blue-grey-red diverging scale for "colder / comfortable / hotter", and one hue per bar list.
// Text always uses ink colours; coloured marks sit beside it.

export const SERIES = ['#3987e5', '#d95926', '#199e70']; // living, bedroom, hall
const INK = '#f1f1f1', INK2 = '#c4c4c4', MUTED = '#898781', GRID = '#2c2c2c', SURFACE = '#171717', NEUTRAL = '#383835';
const SHORT = { living: 'Living', bedroom: 'Bedroom', hall: 'Hall' };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const f1 = v => (v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
const hex = rgb => '#' + rgb.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Diverging: grey inside the comfort band (heating to cooling setpoint), blue below, red above.
const COLD = [[0, rgb(NEUTRAL)], [1.5, rgb('#1c5cab')], [5, rgb('#3987e5')]];
const HOT = [[0, rgb(NEUTRAL)], [1.5, rgb('#a33a3a')], [5, rgb('#e66767')]];
function along(stops, d) {
  if (d <= 0) return stops[0][1];
  for (let i = 1; i < stops.length; i++) if (d <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], (d - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
  return stops.at(-1)[1];
}
export function comfortColor(c, heatSetpoint, coolSetpoint) {
  if (c < heatSetpoint) return along(COLD, heatSetpoint - c);
  if (c > coolSetpoint) return along(HOT, c - coolSetpoint);
  return rgb(NEUTRAL);
}
// Heat flow through a surface: one hue (orange), stronger with more flow.
const FLOW = [[0, rgb('#4a4945')], [8, rgb('#8f4a2c')], [20, rgb('#d95926')], [45, rgb('#f39a61')]];
export function flowColor(wPerM2) {
  const v = Math.abs(wPerM2);
  for (let i = 1; i < FLOW.length; i++) if (v <= FLOW[i][0]) return mix(FLOW[i - 1][1], FLOW[i][1], (v - FLOW[i - 1][0]) / (FLOW[i][0] - FLOW[i - 1][0]));
  return FLOW.at(-1)[1];
}
const zoneKey = id => id.split('-')[0];

// Two floor plans side by side; rooms coloured by mean temperature against the comfort band.
// stacked: floors one above the other (narrow screens), so labels stay readable.
export function floorPlanSvg(result, building, { stacked = false } = {}) {
  const { heatSetpoint: hs, coolSetpoint: cs } = result.settings, fp = building.thermal.footprint;
  const s = 20, w = (fp.x1 - fp.x0) * s, h = (fp.z1 - fp.z0) * s, gap = 36, top = 26;
  const rowH = top + h + 14;
  const X = (x, i) => (stacked ? 0 : i * (w + gap)) + (x - fp.x0) * s, Z = (z, i = 0) => (stacked ? i * rowH : 0) + top + (z - fp.z0) * s;
  const parts = [];
  building.thermal.levels.forEach((level, i) => {
    parts.push(`<text x="${X(fp.x0, i)}" y="${(stacked ? i * rowH : 0) + 16}" fill="${INK2}" font-size="12">Floor ${level.level}</text>`);
    for (const room of building.rooms.filter(r => r.level === level.level)) {
      const z = result.zones.find(r => r.id === room.id); if (!z) continue;
      const fill = hex(comfortColor(z.meanC, hs, cs));
      for (const [x0, x1, z0, z1] of room.rects) parts.push(`<rect x="${X(x0, i) + 1}" y="${Z(z0, i) + 1}" width="${(x1 - x0) * s - 2}" height="${(z1 - z0) * s - 2}" fill="${fill}" stroke="${SURFACE}" stroke-width="2"><title>${esc(z.name)}, floor ${z.level}: ${f1(z.meanC)} °C mean (${f1(z.minC)} to ${f1(z.maxC)})</title></rect>`);
      const [x0, x1, z0, z1] = room.rects.reduce((a, b) => (b[1] - b[0]) * (b[3] - b[2]) > (a[1] - a[0]) * (a[3] - a[2]) ? b : a);
      const cx = X((x0 + x1) / 2, i), cy = Z((z0 + z1) / 2, i);
      const notes = [!z.acUnits ? 'no AC' : null, z.poorlyVentilated ? 'low air' : null].filter(Boolean).join(' · ');
      parts.push(`<text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="${INK}" font-size="12" font-weight="600">${esc(SHORT[zoneKey(z.id)] ?? z.name)}</text>`,
        `<text x="${cx}" y="${cy + 12}" text-anchor="middle" fill="${INK}" font-size="12">${f1(z.meanC)} °C</text>`);
      if (notes) parts.push(`<text x="${cx}" y="${cy + 26}" text-anchor="middle" fill="${INK2}" font-size="10">${esc(notes)}</text>`);
    }
    // Windows along the facades, and HVAC where it currently is.
    for (const o of building.thermal.openings.filter(o => o.type === 'window')) {
      const zEdge = o.facade === 'north' ? fp.z0 : fp.z1;
      parts.push(`<line x1="${X(o.from, i)}" y1="${Z(zEdge, i)}" x2="${X(o.to, i)}" y2="${Z(zEdge, i)}" stroke="#d9d9d9" stroke-width="3"/>`);
    }
    for (const d of result.devices.filter(d => !d.outside && d.zoneId && Number(d.zoneId.split('-').pop()) === level.level)) {
      const px = X(d.position[0], i), pz = Z(d.position[2], i);
      parts.push(d.type === 'ac'
        ? `<rect x="${px - 5}" y="${pz - 9}" width="10" height="18" fill="#9fd8ff" stroke="${SURFACE}" stroke-width="2"><title>AC unit</title></rect>`
        : `<circle cx="${px}" cy="${pz}" r="5" fill="#55e5d0" stroke="${SURFACE}" stroke-width="2"><title>HVAC vent</title></circle>`);
    }
  });
  const width = stacked ? w : 2 * w + gap, height = stacked ? 2 * rowH - 10 : top + h + 4;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Floor plans coloured by room temperature" class="plan-svg">${parts.join('')}</svg>`;
}

// Hourly temperature for the three rooms of one floor, outdoor dashed, comfort band shaded.
// width: the on-screen width in CSS pixels, so text renders at its real size on phones and desktops.
export function temperatureChartSvg(result, level, hour = null, { width = 640 } = {}) {
  const { heatSetpoint: hs, coolSetpoint: cs } = result.settings;
  const zones = result.zones.filter(z => z.level === level);
  const values = [...zones.flatMap(z => z.hourlyC), ...result.outdoor.hourlyC, hs, cs];
  const lo = Math.floor(Math.min(...values) / 5) * 5, hi = Math.ceil(Math.max(...values) / 5) * 5;
  const W = Math.round(Math.min(720, Math.max(300, width))), H = W < 480 ? 200 : 220, L = 34, R = W < 480 ? 66 : 92, T = 10, B = 24, pw = W - L - R, ph = H - T - B;
  const x = t => L + (t / 24) * pw, y = c => T + (1 - (c - lo) / (hi - lo || 1)) * ph;
  const path = list => list.map((c, k) => `${k ? 'L' : 'M'}${x(k + 0.5).toFixed(1)} ${y(c).toFixed(1)}`).join('');
  const parts = [];
  for (let c = lo; c <= hi; c += 5) parts.push(`<line x1="${L}" x2="${L + pw}" y1="${y(c)}" y2="${y(c)}" stroke="${GRID}" stroke-width="1"/><text x="${L - 6}" y="${y(c) + 4}" text-anchor="end" fill="${MUTED}" font-size="10">${c}°</text>`);
  for (const t of W < 480 ? [0, 12, 24] : [0, 6, 12, 18, 24]) parts.push(`<text x="${x(t)}" y="${H - 6}" text-anchor="middle" fill="${MUTED}" font-size="10">${String(t).padStart(2, '0')}:00</text>`);
  parts.push(`<rect x="${L}" y="${y(cs)}" width="${pw}" height="${y(hs) - y(cs)}" fill="#ffffff" fill-opacity="0.06"/><text x="${L + 6}" y="${y(cs) + 12}" fill="${MUTED}" font-size="10">comfort ${hs}–${cs} °C</text>`);
  parts.push(`<path d="${path(result.outdoor.hourlyC)}" fill="none" stroke="${MUTED}" stroke-width="2" stroke-dasharray="5 4"/>`);
  zones.forEach(z => parts.push(`<path d="${path(z.hourlyC)}" fill="none" stroke="${SERIES[['living', 'bedroom', 'hall'].indexOf(zoneKey(z.id))]}" stroke-width="2" stroke-linejoin="round"/>`));
  // Direct labels at the right end, spaced so they never overlap.
  const ends = [...zones.map(z => ({ name: SHORT[zoneKey(z.id)], c: z.hourlyC[23], color: SERIES[['living', 'bedroom', 'hall'].indexOf(zoneKey(z.id))] })), { name: 'Outdoor', c: result.outdoor.hourlyC[23], color: MUTED, dashed: true }]
    .map(e => ({ ...e, py: y(e.c) })).sort((a, b) => a.py - b.py);
  for (let k = 1; k < ends.length; k++) ends[k].py = Math.max(ends[k].py, ends[k - 1].py + 13);
  for (const e of ends) parts.push(`<line x1="${L + pw + 6}" x2="${L + pw + 18}" y1="${e.py}" y2="${e.py}" stroke="${e.color}" stroke-width="2"${e.dashed ? ' stroke-dasharray="3 2"' : ''}/><text x="${L + pw + 22}" y="${e.py + 4}" fill="${INK2}" font-size="11">${esc(e.name)}</text>`);
  if (hour !== null) {
    parts.push(`<line x1="${x(hour + 0.5)}" x2="${x(hour + 0.5)}" y1="${T}" y2="${T + ph}" stroke="${INK2}" stroke-width="1"/>`);
    zones.forEach(z => parts.push(`<circle cx="${x(hour + 0.5)}" cy="${y(z.hourlyC[hour])}" r="4.5" fill="${SERIES[['living', 'bedroom', 'hall'].indexOf(zoneKey(z.id))]}" stroke="${SURFACE}" stroke-width="2"/>`));
  }
  parts.push(`<rect class="chart-hit" x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent"/>`);
  return { svg: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Room temperatures through the day, floor ${level}" class="line-svg">${parts.join('')}</svg>`, plot: { left: L / W, width: pw / W } };
}

export function readout(result, level, hour) {
  if (hour === null) return 'Hover or tap the chart to pick an hour · 3D view shows the daily mean';
  const zones = result.zones.filter(z => z.level === level);
  return `${String(hour).padStart(2, '0')}:00 · ` + zones.map(z => `${SHORT[zoneKey(z.id)]} ${f1(z.hourlyC[hour])} °C`).join(' · ') + ` · Outdoor ${f1(result.outdoor.hourlyC[hour])} °C`;
}

// Horizontal bar list: [{label, value, text}], one hue, widths relative to the largest value.
export function barListHtml(items, color) {
  const max = Math.max(1e-9, ...items.map(i => Math.abs(i.value)));
  return items.map(i => `<div class="bar-row"><span class="bar-label">${esc(i.label)}</span><span class="bar-track"><span class="bar-fill" style="width:${(100 * Math.abs(i.value) / max).toFixed(1)}%;background:${color}"></span></span><span class="bar-value">${esc(i.text)}</span></div>`).join('');
}

export const LEGEND_SWATCHES = { cold: hex(along(COLD, 4)), comfortable: NEUTRAL, hot: hex(along(HOT, 4)) };
