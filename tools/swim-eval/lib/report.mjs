// The report pages: one per run (a top-down map of the opening and of the whole run, the car's path coloured by beat,
// the failure points, the beat table with its numbers, speed and drift-angle charts, the screenshots) and a summary
// across runs (scenarios × beats, the worst case per beat, run counts, the spread of the key numbers).
// Colours: the dataviz skill's reference palette (categorical slots in fixed order for the beats, validated light and
// dark with its validate_palette.js; the status steps only for verdicts, always with an icon and a word).
import { BLOCKS } from '../../../js/city-config.js';
import { THRESHOLDS as T, beatOfFrame } from './check.mjs';
import { MPH } from './geometry.mjs';
import { CAR_HALF_LENGTH, CAR_HALF_WIDTH } from './map.mjs';

const CLOSE_UP = 18; // m either side of a failure's close-up map
const MAX_CLOSE_UPS = 12;

const BEATS = [
  { id: 1, name: 'Start on the road' }, { id: 2, name: 'Slow roll' }, { id: 3, name: 'Floor it' },
  { id: 4, name: 'Donuts round the cop' }, { id: 5, name: 'Drift out, 50 mph' }, { id: 6, name: 'Swim > 70 mph' },
  { id: 7, name: 'Corners' }, { id: 8, name: 'Endless roam' }
];
// The path's colour per beat: categorical slots 1-7 in their fixed order (beat 1 is a point, the start, not a stretch)
const BEAT_SLOT = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 0: 0 };
const VERDICT_ICON = { VERIFIED: '✓', 'NOT VERIFIED': '✗', INCONCLUSIVE: '?', 'N/A': '–' };
const VERDICT_CLASS = { VERIFIED: 'good', 'NOT VERIFIED': 'critical', INCONCLUSIVE: 'warning', 'N/A': 'na' };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d));

const STYLE = `
.viz-root { color-scheme: light;
  --surface-1:#fcfcfb; --page:#f9f9f7; --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781; --grid:#e1e0d9; --axis:#c3c2b7;
  --ring:rgba(11,11,11,0.10);
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4; --s6:#008300; --s7:#6250d6; --s0:#898781;
  --good:#0ca30c; --warning:#fab219; --critical:#d03b3b; --na:#c3c2b7;
  --road:#ecebe6; --pavement:#cfcdc4; --plaza:#e6d7b8; --building:#8f8c84; --park:#cfe0c4; }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) .viz-root { color-scheme: dark;
  --surface-1:#1a1a19; --page:#0d0d0d; --ink:#f0efec; --ink-2:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --axis:#383835;
  --ring:rgba(255,255,255,0.10);
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#008300; --s7:#9085e9;
  --road:#262624; --pavement:#3d3c39; --plaza:#4a4334; --building:#5f5d57; --park:#2f3b2a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); }
.viz-root { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--page); padding: 24px 32px 64px; max-width: 1400px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 10px; } .sub { color: var(--ink-2); font-size: 13px; }
.card { background: var(--surface-1); border: 1px solid var(--ring); border-radius: 10px; padding: 16px; margin: 12px 0; }
table { border-collapse: collapse; font-size: 13px; width: 100%; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; } td.num { font-variant-numeric: tabular-nums; }
.verdict { display: inline-block; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 12px; white-space: nowrap; color: #fff; }
.verdict.good { background: var(--good); } .verdict.critical { background: var(--critical); }
.verdict.warning { background: var(--warning); color: #0b0b0b; } .verdict.na { background: var(--na); color: #0b0b0b; }
.crit { font-size: 12px; color: var(--ink-2); margin: 2px 0; } .crit.fail { color: var(--ink); font-weight: 600; }
.crit .mark { display: inline-block; width: 14px; }
.maps { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--ink-2); margin: 8px 0; }
.legend .sw { display: inline-block; width: 18px; height: 4px; border-radius: 2px; vertical-align: middle; margin-right: 4px; }
.legend .box { display: inline-block; width: 12px; height: 12px; border-radius: 2px; vertical-align: middle; margin-right: 4px; border: 1px solid var(--ring); }
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
.shots figure { margin: 0; } .shots img { width: 100%; border-radius: 6px; border: 1px solid var(--ring); display: block; }
.shots figcaption { font-size: 12px; color: var(--ink-2); margin-top: 4px; }
.shots figure.fail figcaption { color: var(--ink); font-weight: 600; }
.chart { position: relative; } .chart svg { display: block; width: 100%; height: auto; }
.tip { position: absolute; pointer-events: none; background: var(--surface-1); border: 1px solid var(--ring); border-radius: 6px; padding: 6px 8px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.12); display: none; white-space: nowrap; }
.matrix td.cell { text-align: center; } a { color: var(--s1); }
.strip { font-size: 12px; }
`;

// Hover for the line charts: a crosshair and a tooltip at the nearest sample (data in each svg's data-points)
const CHART_SCRIPT = `
for (const wrap of document.querySelectorAll('.chart[data-points]')) {
  const svg = wrap.querySelector('svg'); const tip = wrap.querySelector('.tip'); const cross = svg.querySelector('.cross');
  const pts = JSON.parse(wrap.dataset.points); const vb = svg.viewBox.baseVal;
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width * vb.width;
    let best = pts[0]; for (const p of pts) if (Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p;
    cross.setAttribute('x1', best[0]); cross.setAttribute('x2', best[0]); cross.style.display = '';
    tip.style.display = 'block'; tip.innerHTML = best[2];
    const left = best[0] / vb.width * r.width; tip.style.left = Math.min(r.width - 180, left + 12) + 'px'; tip.style.top = '8px';
  });
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.style.display = 'none'; });
}`;

function verdictBadge(verdict) {
  return `<span class="verdict ${VERDICT_CLASS[verdict]}">${VERDICT_ICON[verdict]} ${esc(verdict)}</span>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The top-down map: the roads are the surface; blocks (pavement), plazas, parks and buildings drawn over it from the
// game's own data, the car's path on top coloured by beat, the cop, the corners and the failure points
function mapSvg({ trace, result, map, bounds, title, width = 640, car = null }) {
  const { minX, maxX, minZ, maxZ } = bounds;
  const scale = width / (maxX - minX);
  const height = Math.round((maxZ - minZ) * scale);
  const X = (x) => ((x - minX) * scale).toFixed(1);
  const Z = (z) => ((z - minZ) * scale).toFixed(1);
  const inBox = (r) => r.maxX >= minX && r.minX <= maxX && r.maxZ >= minZ && r.minZ <= maxZ;
  const poly = (pts, cls) => `<polygon class="${cls}" points="${pts.map((p) => (Array.isArray(p) ? `${X(p[0])},${Z(p[1])}` : `${X(p.x)},${Z(p.z)}`)).join(' ')}"/>`;
  const parts = [];
  for (const b of BLOCKS) if (inBox(b)) parts.push(poly(b.poly, b.park > 0.6 && !b.median ? 'park' : 'pavement'));
  for (const p of map.plazas) if (inBox(p)) parts.push(poly(p.pts, 'plaza'));
  const buildingCells = new Set();
  for (const cell of map.buildings.cells.values()) {
    for (const c of cell) {
      if (buildingCells.has(c) || !inBox(c)) continue;
      buildingCells.add(c);
      if (c.polygon) parts.push(poly(c.polygon.outer, 'building'));
      else parts.push(`<rect class="building" x="${X(c.minX)}" y="${Z(c.minZ)}" width="${((c.maxX - c.minX) * scale).toFixed(1)}" height="${((c.maxZ - c.minZ) * scale).toFixed(1)}"/>`);
    }
  }
  // The path, a polyline per stretch of one beat, thinned to a point every half metre
  const step = Math.max(0.5, 1.5 / scale);
  let current = null;
  const runs = [];
  let lastPt = null;
  for (const f of trace.frames) {
    if (f.x < minX - 50 || f.x > maxX + 50 || f.z < minZ - 50 || f.z > maxZ + 50) {
      current = null;
      continue;
    }
    const beat = beatOfFrame(f, result);
    if (!current || current.beat !== beat) {
      current = { beat, pts: lastPt && current ? [lastPt] : [] };
      runs.push(current);
    }
    if (!lastPt || Math.hypot(f.x - lastPt[0], f.z - lastPt[1]) >= step) {
      lastPt = [f.x, f.z];
      current.pts.push(lastPt);
    }
  }
  for (const r of runs) {
    if (r.pts.length < 2) continue;
    parts.push(`<polyline class="path" stroke="var(--s${BEAT_SLOT[r.beat]})" points="${r.pts.map(([x, z]) => `${X(x)},${Z(z)}`).join(' ')}"/>`);
  }
  // The cop where it parked, the start, the corners, the failure points
  const cop = result.cop;
  if (cop) parts.push(`<rect class="cop" x="${(X(cop.x) - 1.0 * scale)}" y="${(Z(cop.z) - 2.4 * scale)}" width="${2 * scale}" height="${4.8 * scale}" transform="rotate(90 ${X(cop.x)} ${Z(cop.z)})"/><text class="lbl" x="${+X(cop.x) + 6}" y="${+Z(cop.z) - 6}">cop</text>`);
  const f0 = trace.frames[0];
  if (f0) parts.push(`<circle class="start" cx="${X(f0.x)}" cy="${Z(f0.z)}" r="5"/><text class="lbl" x="${+X(f0.x) + 7}" y="${+Z(f0.z) + 4}">P</text>`);
  const corners = result.beats.find((b) => b.id === 7)?.corners ?? [];
  for (const c of corners) {
    if (c.x < minX || c.x > maxX || c.z < minZ || c.z > maxZ) continue;
    parts.push(`<circle class="corner" cx="${X(c.x)}" cy="${Z(c.z)}" r="${Math.max(4, T.cornerReach * scale)}"/>`);
  }
  // The car's box at one frame (a failure's close-up): the swim car's 0.97 × 2.52 m half extents at its heading
  if (car) {
    const s = Math.sin(car.h), c = Math.cos(car.h);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([lx, lz]) => {
      const ax = lx * CAR_HALF_WIDTH, az = lz * CAR_HALF_LENGTH;
      return { x: car.x + c * ax + s * az, z: car.z - s * ax + c * az };
    });
    const nose = { x: car.x + s * CAR_HALF_LENGTH, z: car.z + c * CAR_HALF_LENGTH };
    parts.push(`${poly(corners, 'carbox')}<line class="nose" x1="${X(car.x)}" y1="${Z(car.z)}" x2="${X(nose.x)}" y2="${Z(nose.z)}"/>`);
  }
  if (!car) {
    result.failures.forEach((fail, i) => {
      const f = nearestFrame(trace, fail.t);
      if (!f || f.x < minX || f.x > maxX || f.z < minZ || f.z > maxZ) return;
      parts.push(`<g class="fail"><circle cx="${X(f.x)}" cy="${Z(f.z)}" r="7"/><text x="${X(f.x)}" y="${+Z(f.z) + 4}" text-anchor="middle">${i + 1}</text></g>`);
    });
  }
  return `<figure class="card" style="margin:0"><div class="sub" style="margin-bottom:6px">${esc(title)}</div>
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}" style="width:100%;height:auto;background:var(--road);border-radius:6px">
<style>.pavement{fill:var(--pavement)}.park{fill:var(--park)}.plaza{fill:var(--plaza)}.building{fill:var(--building)}
.path{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.cop{fill:var(--ink)}.start{fill:var(--surface-1);stroke:var(--ink);stroke-width:2}
.corner{fill:none;stroke:var(--muted);stroke-dasharray:3 3}.lbl{font-size:11px;fill:var(--ink);paint-order:stroke;stroke:var(--surface-1);stroke-width:3px}
.fail circle{fill:var(--critical);stroke:var(--surface-1);stroke-width:2}.fail text{font-size:10px;fill:#fff;font-weight:700}
.carbox{fill:none;stroke:var(--critical);stroke-width:2}.nose{stroke:var(--critical);stroke-width:2}</style>
${parts.join('\n')}</svg></figure>`;
}

function nearestFrame(trace, t) {
  let best = null;
  for (const f of trace.frames) if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
  return best;
}

function pathBounds(frames, margin, maxSide = Infinity, centre = null) {
  if (centre) return { minX: centre.x - margin, maxX: centre.x + margin, minZ: centre.z - margin * 0.75, maxZ: centre.z + margin * 0.75 };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const f of frames) {
    minX = Math.min(minX, f.x); maxX = Math.max(maxX, f.x); minZ = Math.min(minZ, f.z); maxZ = Math.max(maxZ, f.z);
  }
  const side = Math.min(maxSide, Math.max(maxX - minX, maxZ - minZ) + 2 * margin);
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  return { minX: cx - side / 2, maxX: cx + side / 2, minZ: cz - side / 2, maxZ: cz + side / 2 };
}

// ---------------------------------------------------------------------------------------------------------------------
// A line chart over the run's time: one series, its thresholds as labelled dashed rules, the beat changes as ticks
function lineChart({ trace, result, value, label, unit, thresholds = [], height = 200, width = 1100 }) {
  const pad = { l: 44, r: 12, t: 16, b: 26 };
  const frames = trace.frames;
  if (!frames.length) return '';
  const tMax = frames[frames.length - 1].t || 1;
  const values = frames.map(value);
  const vMax = Math.max(...values, ...thresholds.map((t) => t.value)) * 1.08 || 1;
  const vMin = Math.min(0, ...values);
  const X = (t) => pad.l + (t / tMax) * (width - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - vMin) / (vMax - vMin)) * (height - pad.t - pad.b);
  const every = Math.max(1, Math.floor(frames.length / 1500));
  const pts = [];
  for (let i = 0; i < frames.length; i += every) pts.push(`${X(frames[i].t).toFixed(1)},${Y(values[i]).toFixed(1)}`);
  const hover = [];
  const hoverEvery = Math.max(1, Math.floor(frames.length / 400));
  for (let i = 0; i < frames.length; i += hoverEvery) {
    const f = frames[i];
    hover.push([+X(f.t).toFixed(1), 0, `t ${fmt(f.t)} s · <b>${fmt(values[i])} ${unit}</b><br>${esc(f.phase)}${f.dp ? ` / ${esc(f.dp)}` : ''} · ${esc(f.where ?? '')} · keys ${esc(f.k || '–')}`]);
  }
  const grid = [];
  const tickStep = vMax > 100 ? 20 : vMax > 40 ? 10 : 5;
  for (let v = Math.ceil(vMin / tickStep) * tickStep; v <= vMax; v += tickStep) {
    grid.push(`<line x1="${pad.l}" x2="${width - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/><text x="${pad.l - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${v}</text>`);
  }
  for (let t = 0; t <= tMax; t += tMax > 100 ? 20 : 10) grid.push(`<text x="${X(t)}" y="${height - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${t} s</text>`);
  const marks = trace.events.filter((e) => e.kind === 'phase' && e.t > 0).map((e) => `<line x1="${X(e.t)}" x2="${X(e.t)}" y1="${pad.t}" y2="${height - pad.b}" stroke="var(--axis)"/><text x="${X(e.t) + 3}" y="${pad.t + 10}" font-size="10" fill="var(--ink-2)">${esc(e.to)}</text>`);
  const rules = thresholds.map((th) => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${Y(th.value)}" y2="${Y(th.value)}" stroke="var(--muted)" stroke-dasharray="4 4"/><text x="${width - pad.r - 4}" y="${Y(th.value) - 4}" text-anchor="end" font-size="10" fill="var(--ink-2)">${esc(th.label)}</text>`);
  return `<div class="card"><div class="sub">${esc(label)} (${esc(unit)}) over the run</div>
<div class="chart" data-points='${esc(JSON.stringify(hover))}'><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
${grid.join('')}<line x1="${pad.l}" x2="${width - pad.r}" y1="${Y(vMin)}" y2="${Y(vMin)}" stroke="var(--axis)"/>${marks.join('')}${rules.join('')}
<polyline fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round" points="${pts.join(' ')}"/>
<line class="cross" y1="${pad.t}" y2="${height - pad.b}" stroke="var(--ink-2)" style="display:none"/></svg><div class="tip"></div></div></div>`;
}

function beatTable(result) {
  const rows = result.beats.map((b) => {
    const crit = b.criteria.map((c) => `<div class="crit${c.pass === false ? ' fail' : ''}"><span class="mark">${c.pass === false ? '✗' : c.pass === null ? '?' : '✓'}</span>${esc(c.name)}: <b>${esc(c.value)}${esc(c.unit)}</b> <span style="color:var(--muted)">(want ${esc(c.want)}${esc(c.unit)})</span></div>`).join('');
    return `<tr><td class="num">${b.id}</td><td>${esc(b.title)}${b.id > 1 && BEAT_SLOT[b.id] ? ` <span class="sw" style="display:inline-block;width:14px;height:4px;border-radius:2px;background:var(--s${BEAT_SLOT[b.id]})"></span>` : ''}</td><td>${verdictBadge(b.verdict)}</td><td>${crit || `<div class="crit">${esc(b.summary)}</div>`}</td></tr>`;
  });
  return `<table><thead><tr><th>#</th><th>Beat</th><th>Verdict</th><th>Measured (want)</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function legend() {
  const beats = [[2, 'roll'], [3, 'launch'], [4, 'donuts'], [5, 'drift out'], [6, 'the run (7th, 42nd, 8th, 57th)'], [8, 'roam']];
  return `<div class="legend">${beats.map(([b, n]) => `<span><span class="sw" style="background:var(--s${BEAT_SLOT[b]})"></span>${b}. ${esc(n)}</span>`).join('')}
<span><span class="box" style="background:var(--pavement)"></span>pavement</span><span><span class="box" style="background:var(--plaza)"></span>plaza</span>
<span><span class="box" style="background:var(--building)"></span>building</span><span><span class="box" style="background:var(--road)"></span>road</span>
<span>● P start · ▬ cop · ◌ corner (${T.cornerReach} m) · <b style="color:var(--critical)">●</b> failure (numbered)</span></div>`;
}

function runPage({ result, trace, map, run, failureShots }) {
  const header = run ? `${esc(run.scenario.name)} · build ${esc(run.sha)} · clock ${esc(run.scenario.profile)} · traffic seed ${run.scenario.trafficSeed} · seed ${run.scenario.seed}${run.scenario.warmup ? ` · ${run.scenario.warmup} s warm-up` : ''}${run.scenario.inject ? ` · injected: ${esc(run.scenario.inject.label)}` : ''}${run.scenario.patches?.length ? ` · <b>patched build (broken on purpose): ${run.scenario.patches.map((p) => `${esc(p.file)}: ${esc(p.from)} → ${esc(p.to.split(' //')[0])}`).join('; ')}</b>` : ''}` : esc(result.label);
  const opening = mapSvg({ trace, result, map, bounds: pathBounds([], 55, Infinity, result.cop ?? trace.frames[0]), title: 'The opening, Times Square (±55 m round the cop)' });
  const whole = mapSvg({ trace, result, map, bounds: pathBounds(trace.frames, 40, 3200), title: 'The whole run' });
  const failures = result.failures.map((f, i) => `<tr><td class="num">${i + 1}</td><td class="num">${fmt(f.t, 2)} s</td><td>beat ${f.beat}</td><td>${esc(f.label)}</td></tr>`).join('');
  // Each failure seen from above: the car's box at that frame on the game's own kerbs, plaza and buildings (the
  // show's camera is often the driver's seat, which can't show where the wheels are)
  const closeUps = result.failures.slice(0, MAX_CLOSE_UPS).map((fail, i) => {
    const f = nearestFrame(trace, fail.t);
    if (!f) return '';
    const bounds = { minX: f.x - CLOSE_UP, maxX: f.x + CLOSE_UP, minZ: f.z - CLOSE_UP * 0.75, maxZ: f.z + CLOSE_UP * 0.75 };
    return mapSvg({ trace, result, map, bounds, title: `${i + 1}. t ${fmt(f.t, 2)} s · beat ${fail.beat} · ${fail.label} · under the car: ${[...new Set(f.foot ?? [])].join(' + ')}`, width: 420, car: f });
  }).join('');
  const shots = [
    ...(run?.shots ?? []).map((s) => ({ file: `shots/${s.file}`, caption: `${s.label} · t ${fmt(s.t, 2)} s${s.kind === 'incident' ? ' (contact)' : ''}`, fail: s.kind === 'incident' })),
    ...failureShots.map((s) => ({ file: s.file, caption: `failure ${s.n}: ${s.label} · t ${fmt(s.t, 2)} s (from the video)`, fail: true }))
  ];
  const c = result.contacts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(result.label)} · swim show eval</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${STYLE}</style></head><body><div class="viz-root">
<h1>${esc(result.label)}</h1><div class="sub">${header}</div>
<div class="sub">${trace.source === 'session' ? `session file ${esc(trace.file)}` : `${fmt(result.duration)} s of show after P · ${result.frames} frames`} · contacts: cop ${c.cop} frames, buildings ${c.building} frames, traffic ${c.traffic}${run?.video ? ` · <a href="${esc(run.video)}">video</a>` : ''}</div>
${(trace.meta?.notes ?? []).map((n) => `<div class="sub">${esc(n)}</div>`).join('')}
<h2>The beats</h2><div class="card">${beatTable(result)}</div>
<h2>Where it drove</h2>${legend()}<div class="maps">${opening}${whole}</div>
${failures ? `<h2>Failure points</h2><div class="card"><table><thead><tr><th>#</th><th>t</th><th>Beat</th><th>What</th></tr></thead><tbody>${failures}</tbody></table></div>
<div class="sub">Each from above (±${CLOSE_UP} m), the car's box in red at that frame, its nose the short line:</div>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px">${closeUps}</div>` : ''}
<h2>Speed and drift angle</h2>
${lineChart({ trace, result, value: (f) => f.g * MPH, label: 'Speed over the ground', unit: 'mph', thresholds: [{ value: T.rollMaxMph, label: '12 mph (roll)' }, { value: T.exitMph, label: '50 mph (way out)' }, { value: T.swimMph, label: '70 mph (swim)' }] })}
${lineChart({ trace, result, value: (f) => Math.abs(f.slip) * 180 / Math.PI, label: 'Drift angle', unit: '°', thresholds: [{ value: 30, label: '30° (donut min)' }, { value: 50, label: '50° (donut max)' }] })}
${shots.length ? `<h2>Screenshots</h2><div class="shots">${shots.map((s) => `<figure class="${s.fail ? 'fail' : ''}"><a href="${esc(s.file)}"><img src="${esc(s.file)}" alt="${esc(s.caption)}"></a><figcaption>${esc(s.caption)}</figcaption></figure>`).join('')}</div>` : ''}
</div><script>${CHART_SCRIPT}</script></body></html>`;
}

// ---------------------------------------------------------------------------------------------------------------------
const SEVERITY = { 'NOT VERIFIED': 3, INCONCLUSIVE: 2, VERIFIED: 1, 'N/A': 0 };

// A key number of each run, read off its verdict (null where the run didn't get there)
const METRICS = [
  { name: 'roll time', unit: 's', beat: 2, read: (r) => num(r, 2, 'roll time'), want: [T.rollMinTime, T.rollMaxTime] },
  { name: 'roll top speed', unit: 'mph', beat: 2, read: (r) => num(r, 2, 'top speed'), want: [null, T.rollMaxMph] },
  { name: 'laps round the cop', unit: '', beat: 4, read: (r) => r.beats[3].laps ?? null, want: [T.donutLaps, null] },
  { name: 'circle centre off the cop', unit: 'm', beat: 4, read: (r) => num(r, 4, 'circle centre off the cop'), want: [null, T.donutCentre] },
  { name: 'circle radius', unit: 'm', beat: 4, read: (r) => num(r, 4, 'circle radius'), want: [T.donutRadiusMin, T.donutRadiusMax] },
  { name: 'donut frames off the road', unit: '%', beat: 4, read: (r) => share(r, 4, 'frames on kerb/pavement/plaza'), want: [null, 0] },
  { name: 'time to 50 mph', unit: 's', beat: 5, read: (r) => num(r, 5, 'time to 50 mph'), want: [null, T.exitTime] },
  { name: 'top speed on 7th Ave', unit: 'mph', beat: 6, read: (r) => num(r, 6, 'top speed on 7th Ave'), want: [T.swimMph, null] },
  { name: 'traffic contacts', unit: '', beat: 6, read: (r) => num(r, 6, 'traffic contacts'), want: [null, 0] },
  { name: 'roam stopped', unit: '%', beat: 8, read: (r) => (r.beats[7].stoppedShare ?? null) === null ? null : r.beats[7].stoppedShare * 100, want: [null, T.stoppedShare * 100] }
];

function num(result, beat, name) {
  const c = result.beats[beat - 1].criteria.find((q) => q.name === name);
  const v = c ? parseFloat(c.value) : NaN;
  return Number.isFinite(v) ? v : null;
}

function share(result, beat, name) {
  const c = result.beats[beat - 1].criteria.find((q) => q.name === name);
  const m = c && /^(\d+)\/(\d+)/.exec(c.value);
  return m && Number(m[2]) ? (Number(m[1]) / Number(m[2])) * 100 : null;
}

// One metric's spread across runs: a dot per run on a line, the wanted range shaded, min/median/max beside it
function strip(metric, entries, width = 420) {
  const vals = entries.map((e) => ({ v: metric.read(e.result), name: e.result.label })).filter((e) => e.v !== null);
  if (!vals.length) return `<tr><td>${esc(metric.name)}</td><td colspan="2" class="sub">no run got there</td></tr>`;
  const all = vals.map((e) => e.v).concat(metric.want.filter((w) => w !== null));
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-6) hi = lo + 1;
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const X = (v) => 10 + ((v - lo) / (hi - lo)) * (width - 20);
  const [wLo, wHi] = metric.want;
  const band = `<rect x="${X(wLo ?? lo)}" y="6" width="${Math.max(2, X(wHi ?? hi) - X(wLo ?? lo))}" height="20" fill="var(--good)" opacity="0.15"/>`;
  const dots = vals.map((e) => `<circle cx="${X(e.v).toFixed(1)}" cy="16" r="5" fill="var(--s1)" stroke="var(--surface-1)" stroke-width="2"><title>${esc(e.name)}: ${fmt(e.v, 2)} ${esc(metric.unit)}</title></circle>`).join('');
  const sorted = vals.map((e) => e.v).sort((a, b) => a - b);
  const want = `${wLo !== null ? `≥ ${wLo}` : ''}${wLo !== null && wHi !== null ? ' and ' : ''}${wHi !== null ? `≤ ${wHi}` : ''}`;
  return `<tr><td>${esc(metric.name)} <span class="sub">(beat ${metric.beat}; want ${want} ${esc(metric.unit)})</span></td>
<td class="num">${fmt(sorted[0], 2)} / ${fmt(sorted[Math.floor(sorted.length / 2)], 2)} / ${fmt(sorted[sorted.length - 1], 2)} <span class="sub">(n ${sorted.length})</span></td>
<td><svg viewBox="0 0 ${width} 32" width="${width}" height="32" role="img" aria-label="${esc(metric.name)} per run">${band}<line x1="10" x2="${width - 10}" y1="16" y2="16" stroke="var(--axis)"/>${dots}</svg></td></tr>`;
}

function summaryPage({ entries, title, note }) {
  const head = BEATS.map((b) => `<th style="text-align:center">${b.id}. ${esc(b.name)}</th>`).join('');
  const rows = entries.map((e) => `<tr><td><a href="${esc(e.href)}">${esc(e.result.label)}</a><div class="sub">${esc(e.blurb ?? '')}</div></td>${e.result.beats.map((b) => `<td class="cell" title="${esc(b.summary)}">${verdictBadge(b.verdict)}</td>`).join('')}</tr>`);
  const worst = BEATS.map((b, i) => {
    const vs = entries.map((e) => e.result.beats[i].verdict).filter((v) => v !== 'N/A');
    if (!vs.length) return `<td class="cell">${verdictBadge('N/A')}</td>`;
    const w = vs.reduce((m, v) => (SEVERITY[v] > SEVERITY[m] ? v : m), vs[0]);
    return `<td class="cell">${verdictBadge(w)}</td>`;
  });
  const counts = BEATS.map((b, i) => {
    const n = { VERIFIED: 0, 'NOT VERIFIED': 0, INCONCLUSIVE: 0, 'N/A': 0 };
    for (const e of entries) n[e.result.beats[i].verdict]++;
    return `<td class="cell num" style="font-size:12px">✓ ${n.VERIFIED} · ✗ ${n['NOT VERIFIED']} · ? ${n.INCONCLUSIVE}${n['N/A'] ? ` · – ${n['N/A']}` : ''}</td>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${STYLE}</style></head><body><div class="viz-root">
<h1>${esc(title)}</h1><div class="sub">${esc(note ?? '')}</div><div class="sub">${entries.length} runs · judged by the worst run · ✓ VERIFIED, ✗ NOT VERIFIED, ? INCONCLUSIVE (not a pass), – not part of that scenario</div>
<h2>Scenarios × beats</h2><div class="card" style="overflow-x:auto"><table class="matrix"><thead><tr><th>Run</th>${head}</tr></thead>
<tbody>${rows.join('')}<tr><th>Worst case</th>${worst.join('')}</tr><tr><th>Counts</th>${counts.join('')}</tr></tbody></table></div>
<h2>Spread of the key numbers</h2><div class="card strip"><table><thead><tr><th>Number</th><th>min / median / max</th><th>per run (shaded: wanted)</th></tr></thead>
<tbody>${METRICS.map((m) => strip(m, entries)).join('')}</tbody></table></div>
</div></body></html>`;
}

export { BEATS, SEVERITY, runPage, summaryPage };
