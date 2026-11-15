// Environmental analysis panel: headline numbers, a floor-plan map, temperature through the day, the biggest
// heat flows, what to fix, and improvements with Apply. Design settings and the full numbers sit in
// collapsed sections. Results come from the simulation adapter, with provenance shown.
import { createBuilding } from './building.js';
import { analyze, findImprovements, applyImprovement, findings, OPTIONS, normalizeDesign, DEFAULT_DESIGN } from './simulation/index.js';
import { buildVisualization } from './simulation/visualize.js';
import { applySeason, describeConditions } from './conditions.js';
import { floorPlanSvg, temperatureChartSvg, readout, barListHtml, SERIES } from './analysis-charts.js';

const DESIGN_FIELDS = ['windows', 'walls', 'roof', 'floor', 'airtightness', 'heatRecovery', 'acSize'];
const NUMBER_FIELDS = ['heatSetpoint', 'coolSetpoint', 'gridKgPerKWh', 'latitude'];
const FLOW_LABELS = { walls: 'Walls', windows: 'Windows', doors: 'Doors', roof: 'Roof', floor: 'Ground floor', infiltration: 'Air leaks', ventilation: 'Vent fresh air', solar: 'Sun through windows', internal: 'People & appliances' };
const f1 = v => (v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
const pct = (part, whole) => whole ? Math.round(100 * part / whole) : 0;

// surrogate: optional promise of an EnergyPlus-trained surrogate (src/energy-surrogate.js); when it loads, the
// headline adds its estimate next to the simplified physics result, with its measured test error.
export function createAnalysisPanel({ $, doc, storage, getConditions, getMoves, setMoves, onVisualization = () => {}, onSummary = () => {}, surrogate = null }) {
  const building = createBuilding();
  const load = key => { try { return JSON.parse(storage?.getItem(key) || 'null'); } catch { return null; } };
  const save = (key, value) => { try { storage?.setItem(key, JSON.stringify(value)); } catch {} };
  let design = normalizeDesign(load('aeroform-design-v1') || DEFAULT_DESIGN);
  let baseline = load('aeroform-baseline-v1');
  let eplus = null;
  let season = 'current', hour = null, floor = 1, last = null, improvements = null, message = '', plot = null;
  const chartWidth = () => { const w = $('#analysis-chart').clientWidth; return w > 0 ? w : 640; };
  const el = (tag, text, className) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const conditionsFor = s => s === 'current' ? getConditions() : applySeason(s);
  const visualize = () => onVisualization(buildVisualization(last, building, getMoves(), hour), last);

  for (const key of DESIGN_FIELDS) {
    const select = $('#design-' + key);
    select.replaceChildren(...Object.entries(OPTIONS[key]).map(([value, option]) => { const node = el('option', option.label); node.value = value; return node; }));
    select.addEventListener('change', () => setDesign({ [key]: select.value }));
  }
  for (const key of NUMBER_FIELDS) $('#design-' + key).addEventListener('change', event => setDesign({ [key]: Number(event.target.value) }));

  function setDesign(change) {
    design = normalizeDesign({ ...design, ...change }); save('aeroform-design-v1', design);
    improvements = null; message = ''; run();
  }
  function run() {
    last = analyze({ building, design, moves: getMoves(), conditions: conditionsFor(season) }).result;
    visualize(); onSummary(last, season); render();
    return last;
  }

  function renderHeadline(r) {
    $('#analysis-provenance').textContent = `${describeConditions(conditionsFor(season))} · ${f1(r.outdoor.minC)} to ${f1(r.outdoor.maxC)} °C outside · simplified physics estimate (not EnergyPlus or AI)`;
    $('#ak-electric').textContent = f1(r.totals.electricKWh); $('#ak-co2').textContent = f1(r.totals.co2Kg);
    const uncomfortable = r.zones.filter(z => z.coldHours + z.hotHours > 1);
    $('#ak-comfort').textContent = `${r.zones.length - uncomfortable.length} of ${r.zones.length}`;
    const cold = uncomfortable.filter(z => z.coldHours >= z.hotHours).length, hot = uncomfortable.length - cold;
    $('#ak-comfort-note').textContent = uncomfortable.length ? `rooms comfortable · ${[cold ? `${cold} too cold` : '', hot ? `${hot} too hot` : ''].filter(Boolean).join(', ')}` : 'rooms comfortable all day';
  }
  function renderChart(r) {
    const chart = temperatureChartSvg(r, floor, hour, { width: chartWidth() });
    plot = chart.plot;
    $('#analysis-chart').innerHTML = chart.svg;
    $('#analysis-readout').textContent = readout(r, floor, hour);
    doc.querySelectorAll('[data-chart-floor]').forEach(b => { const on = Number(b.dataset.chartFloor) === floor; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  }
  function renderFlows(r) {
    const cooling = r.totals.coolingKWh > r.totals.heatingKWh;
    const key = cooling ? 'gainKWh' : 'lossKWh';
    const rows = Object.entries(r.breakdown).map(([k, v]) => ({ k, v: v[key] })).filter(x => x.v > 0.05).sort((a, b) => b.v - a.v).slice(0, 5);
    const total = Object.values(r.breakdown).reduce((s, v) => s + v[key], 0);
    $('#analysis-flows-title').textContent = cooling ? 'Biggest heat gains' : 'Biggest heat leaks';
    $('#analysis-flows').innerHTML = barListHtml(rows.map(x => ({ label: FLOW_LABELS[x.k] ?? x.k, value: x.v, text: `${f1(x.v)} kWh · ${pct(x.v, total)}%` })), cooling ? '#e0a020' : '#d95926');
  }
  function renderFindings(r) {
    const list = findings(r).filter(f => f.level === 'warn' || /Largest/.test(f.text));
    // One line per kind of problem (the same issue on both floors is said once); every number stays in the details.
    const unique = [], seen = new Set();
    for (const f of list) { const k = f.text.replace(/\(floor \d\)/, '').replace(/[\d.–-]+/g, '#'); if (!seen.has(k)) { seen.add(k); unique.push(f); } }
    $('#analysis-findings').replaceChildren(...(unique.length ? unique.slice(0, 4) : [{ level: 'info', text: 'No problems found on this day.' }]).map(f => el('li', f.text.replace(/ \(floor \d\)/, ''), f.level)));
  }
  function renderDesign() {
    for (const key of DESIGN_FIELDS) $('#design-' + key).value = design[key];
    for (const key of NUMBER_FIELDS) $('#design-' + key).value = String(design[key]);
  }
  function renderCompare(r) {
    if (!baseline) { $('#analysis-compare').replaceChildren(el('p', 'Save a baseline, change the design, and see the difference here.', 'muted')); return; }
    const b = analyze({ building, design: baseline.design, moves: baseline.moves || {}, conditions: conditionsFor(season) }).result;
    const line = (label, before, after, unit) => {
      const change = before ? 100 * (after - before) / before : 0;
      return el('li', `${label}: ${f1(before)} → ${f1(after)} ${unit}${Math.abs(change) >= 0.5 ? ` (${change > 0 ? '+' : ''}${change.toFixed(0)}%)` : ''}`);
    };
    const list = el('ul', undefined, 'compare-list');
    list.append(line('Electricity', b.totals.electricKWh, r.totals.electricKWh, 'kWh/day'), line('CO₂e', b.totals.co2Kg, r.totals.co2Kg, 'kg/day'),
      line('Time outside comfort', b.totals.unmetKh, r.totals.unmetKh, 'K·h'));
    $('#analysis-compare').replaceChildren(el('p', 'Baseline vs current design, same day', 'muted'), list);
  }

  function savingText(item) {
    const p = pct(item.savedKWh, improvements.base.electricKWh);
    const comfort = Math.abs(item.comfortGainKh) < 1 ? '' : item.comfortGainKh > 0 ? ' · more comfortable' : ' · less comfortable';
    return `${item.savedKWh >= 0 ? '−' : '+'}${Math.abs(p)}% electricity${comfort}`;
  }
  function improvementRow(item, index, group, label) {
    const li = el('li', undefined, 'improvement');
    const bar = el('span', undefined, 'bar-track'), fill = el('span', undefined, 'bar-fill');
    fill.style.width = Math.max(2, Math.min(100, Math.abs(pct(item.savedKWh, improvements.base.electricKWh)) * 2)).toFixed(1) + '%';
    fill.style.background = item.savedKWh >= 0 ? SERIES[2] : '#898781';
    bar.append(fill);
    const button = el('button', 'Apply', 'quiet'); button.type = 'button'; button.setAttribute('data-apply', `${group}:${index}`);
    button.addEventListener('click', () => applyFrom(group, index));
    li.append(el('b', label ?? item.label), bar, el('small', savingText(item)), button);
    return li;
  }
  function renderImprovements() {
    const box = $('#analysis-improvements');
    if (!improvements) { box.replaceChildren(...(message ? [el('p', message, 'applied')] : [])); return; }
    const nodes = [];
    if (message) nodes.push(el('p', message, 'applied'));
    const p = improvements.package;
    if (p) {
      const hero = el('div', undefined, 'package-hero');
      const before = improvements.base.electricKWh, after = p.electricKWh;
      const bars = el('div', undefined, 'before-after');
      for (const [label, value, color] of [['Now', before, '#898781'], ['With changes', after, SERIES[2]]]) {
        const row = el('div', undefined, 'bar-row'), track = el('span', undefined, 'bar-track'), fill = el('span', undefined, 'bar-fill');
        fill.style.width = (100 * value / Math.max(before, after)).toFixed(1) + '%'; fill.style.background = color; track.append(fill);
        row.append(el('span', label, 'bar-label'), track, el('span', `${f1(value / 3)} kWh/day`, 'bar-value')); bars.append(row);
      }
      const apply = el('button', 'Apply all', 'vr'); apply.type = 'button'; apply.setAttribute('data-apply', 'package:0'); apply.addEventListener('click', () => applyFrom('package', 0));
      hero.append(el('b', `Best combination: −${pct(p.savedKWh, before)}% electricity`), el('small', p.changes.join(' · ')), bars, el('small', 'Average of a winter, mild and summer day'), apply);
      nodes.push(hero);
    }
    const list = el('ol', undefined, 'improvement-list');
    improvements.energy.slice(0, 4).forEach((item, i) => list.append(improvementRow(item, i, 'energy')));
    // Best comfort fix not already listed: a design change (moves have their own section; setpoint changes are
    // trade-offs, since a looser setpoint only looks more comfortable against itself).
    const bestComfort = improvements.comfort.find(c => c.kind === 'design' && !improvements.energy.slice(0, 4).includes(c));
    if (bestComfort) list.append(improvementRow(bestComfort, improvements.comfort.indexOf(bestComfort), 'comfort', `${bestComfort.label} (comfort)`));
    nodes.push(el('h4', 'One change at a time'), list);
    // Equipment placement: the best simulated spot for each AC unit (moving it changes which rooms it heats
    // and cools, so the gain is mostly comfort, sometimes at the cost of more electricity).
    const placements = [];
    for (const group of ['comfort', 'energy']) improvements[group].forEach((item, i) => {
      if (item.kind === 'move' && !placements.some(p => p.item.group === item.group)) placements.push({ item, group, index: i });
    });
    if (placements.length) {
      const moves = el('ol', undefined, 'improvement-list');
      for (const { item, group, index } of placements) {
        const row = improvementRow(item, index, group);
        const hours = Math.round(item.comfortGainKh), p = pct(item.savedKWh, improvements.base.electricKWh);
        const detail = `${hours > 0 ? hours + ' fewer degree-hours too hot or cold' : 'no comfort gain'} · ${item.savedKWh >= 0 ? '−' : '+'}${Math.abs(p)}% electricity${item.savedKWh < 0 ? ' (it now heats and cools the bigger rooms)' : ''}`;
        row.children[2].textContent = detail;
        moves.append(row);
      }
      nodes.push(el('h4', 'Move equipment'), moves);
    }
    if (improvements.tradeoffs.length) {
      const more = el('details', undefined, 'tradeoffs'), tl = el('ol', undefined, 'improvement-list');
      improvements.tradeoffs.slice(0, 4).forEach((item, i) => tl.append(improvementRow(item, i, 'tradeoffs')));
      more.append(el('summary', 'Trade-offs: less energy but less comfort'), tl);
      nodes.push(more);
    }
    nodes.push(el('p', 'Each change was simulated on a winter, mild and summer day.', 'muted'));
    box.replaceChildren(...nodes);
  }
  function applyFrom(group, index) {
    const moves = getMoves();
    const next = group === 'package' ? { design: improvements.package.design, moves: improvements.package.moves } : applyImprovement(design, moves, improvements[group][index]);
    const label = group === 'package' ? 'the best combination' : improvements[group][index].label;
    design = normalizeDesign(next.design); save('aeroform-design-v1', design);
    if (next.moves !== moves) setMoves(next.moves);
    improvements = null; message = `Applied ${label}. Find improvements again for the next step.`;
    run();
  }

  surrogate?.then(model => { eplus = model; if (last) renderEnergyPlusEstimate(); }).catch(() => { eplus = null; });
  function renderEnergyPlusEstimate() {
    const line = $('#analysis-eplus'); if (!line) return;
    const p = eplus?.predict({ building, design, moves: getMoves(), conditions: conditionsFor(season) });
    if (!p) { line.hidden = true; return; }
    const err = p.testError?.electricity_kwh, temp = p.testError?.room_temperature_daily_mean_c;
    const rooms = p.zones.reduce((s, z) => s + z.meanC, 0) / p.zones.length;
    line.hidden = false;
    line.textContent = `EnergyPlus-trained estimate (AI surrogate of EnergyPlus ${eplus.info.learns.match(/[\d.]+/)?.[0] ?? ''}): ${f1(p.totals.electricKWh)} kWh electricity · rooms average ${f1(rooms)} °C`
      + (err ? ` · test error ±${f1(err.mae)} kWh, ±${f1(temp.mae)} °C` : '')
      + (p.inRange ? '' : ` · outside its training range (${p.outsideTrainingRange.join(', ')}), so less reliable`);
  }
  function render() {
    const r = last; if (!r) return;
    renderEnergyPlusEstimate();
    doc.querySelectorAll('[data-analysis-season]').forEach(b => { const on = b.dataset.analysisSeason === season; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    renderHeadline(r);
    $('#analysis-plan').innerHTML = floorPlanSvg(r, building, { stacked: ($('#analysis-plan').clientWidth || 640) < 480 });
    renderChart(r); renderFlows(r); renderFindings(r); renderDesign(); renderCompare(r); renderImprovements();
  }

  doc.querySelectorAll('[data-analysis-season]').forEach(b => b.addEventListener('click', () => { season = b.dataset.analysisSeason; run(); }));
  doc.querySelectorAll('[data-chart-floor]').forEach(b => b.addEventListener('click', () => { floor = Number(b.dataset.chartFloor); if (last) renderChart(last); }));
  // Hover or tap the chart to pick an hour; the 3D Thermal layer follows. Leaving returns to the daily mean.
  function pickHour(event) {
    const box = $('#analysis-chart').getBoundingClientRect?.(); if (!box || !last || !box.width) return;
    if (!plot) return;
    const t = ((event.clientX - box.left) / box.width - plot.left) / plot.width;
    const next = t < 0 || t > 1 ? null : Math.min(23, Math.max(0, Math.floor(t * 24)));
    if (next === hour) return;
    hour = next; renderChart(last); visualize();
  }
  $('#analysis-chart').addEventListener('pointermove', pickHour);
  $('#analysis-chart').addEventListener('pointerdown', pickHour);
  $('#analysis-chart').addEventListener('pointerleave', () => { if (hour !== null && last) { hour = null; renderChart(last); visualize(); } });
  $('#analysis-optimize').addEventListener('click', () => {
    improvements = findImprovements({ building, design, moves: getMoves(), seasonConditions: ['winter', 'mild', 'summer'].map(applySeason) });
    message = ''; renderImprovements();
  });
  $('#analysis-baseline').addEventListener('click', () => { baseline = { design, moves: { ...getMoves() }, savedAt: new Date().toISOString() }; save('aeroform-baseline-v1', baseline); if (last) renderCompare(last); });
  $('#analysis-reset-design').addEventListener('click', () => setDesign(DEFAULT_DESIGN));
  // Charts are drawn at their on-screen size; redraw them when the panel's width changes.
  let lastWidth = 0;
  globalThis.addEventListener?.('resize', () => { const w = chartWidth(); if (last && w !== lastWidth) { lastWidth = w; render(); } });

  return {
    run, get result() { return last; }, get design() { return { ...design }; }, get season() { return season; },
    get improvements() { return improvements; }, setHour(h) { hour = h; if (last) { renderChart(last); visualize(); } }, building
  };
}
