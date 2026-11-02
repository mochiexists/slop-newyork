// A made-up trace of the show as musa's checklist wants it, and one deliberate break per beat. The checker must pass
// the ideal one on every beat (so no check is impossible to meet) and fail each broken one on its beat (so no check
// is one that can't fail). The ideal show: rolling down a 7th Ave lane toward the cop at 10 mph for 4 s, floored, two
// and a bit laps round the cop at 8.2 m and 40° (centred 1 m east of it: the circle that stays clear of the kerb there, by
// the game's map),
// out down 7th Ave to 75 mph with a split and a close call, drifting the run's corners (42nd St, 8th Ave, 57th St, 9th
// Ave) and roaming down 9th Ave.
import { avenueX, streetZ } from '../../../js/city-config.js';
import { COP, wrapAngle } from './geometry.mjs';

const RAD = Math.PI / 180;
const DT = 1 / 60;
const IDEAL_RADIUS = 8.2;
const IDEAL_CENTRE = { x: COP.x + 1, z: COP.z }; // (where a 40° circle clears the kerb all the way round)
const IDEAL_SLIP = 40 * RAD;
const CORNER_SLIP = 25 * RAD;
const CORNER_SLIDE = 18; // m either side of a corner that the car is sideways
const CORNER_RADIUS = 10; // m, the arc each corner of the run is driven on
const DRIFTED = 'drifted (one unbroken spell ≥ 15°, ≥ 0.5 s, ≥ 50% of the turn)'; // beat 7's criterion
const PATH_STEP = 0.25; // m between the points of the run's path
// z (m) of 7th Ave's stretch with Times Square's plaza east of it (45th-43rd St, 10-16 m off the avenue's line)
const PLAZA_EAST_OF_7TH = [-205, -125];

function frameAt(state, t) {
  // The car body turned `slip` off the direction of travel; its velocity over the ground along that direction
  const h = state.travel - state.slip;
  const wx = Math.sin(state.travel) * state.speed, wz = Math.cos(state.travel) * state.speed;
  const v = wx * Math.sin(h) + wz * Math.cos(h);
  return {
    f: Math.round(t / DT), t: +t.toFixed(4), dt: DT, wall: null, phase: state.phase, dp: state.dp ?? null, laps: null,
    x: state.x, z: state.z, h, v, vx: wx - Math.sin(h) * v, vz: wz - Math.cos(h) * v, w: 0, st: 0,
    slip: -state.slip, spin: state.spin ?? 0, gear: 2, k: state.keys, thr: state.thr ?? 0, brk: 0, hb: 0,
    cx: COP.x, cz: COP.z, ch: -Math.PI / 2, cs: state.copState ?? 'parked', tGap: 5, tHit: 0, bHit: 0, copHit: 0,
    seg: 0, rev: 0, queued: 0, cam: 0
  };
}

function idealTrace() {
  const frames = [];
  const events = [];
  let t = 0;
  const push = (state) => {
    t += DT;
    frames.push(frameAt(state, t));
  };
  // Roll: down 7th Ave's middle lane at 10 mph (4.5 m/s), 4 s, from 30 m short of the cop's line
  const x7 = avenueX('7');
  let z = COP.z - 34;
  for (let i = 0; i < 4 / DT; i++) {
    const speed = Math.min(4.5, 0.5 + i * DT * 3);
    z += speed * DT;
    push({ phase: 'roll', dp: 'roll', x: x7, z, travel: 0, slip: 0, speed, keys: i % 20 < 8 ? 'W' : '', thr: 0.3 });
  }
  events.push({ kind: 'phase', t, from: 'roll', to: 'donuts' });
  // Launch onto the circle (joining it due north of the cop... on the line round), floored: 0.6 s
  // Donuts: 2.3 laps anticlockwise seen from above at IDEAL_RADIUS, 8 m/s, 40° sideways
  const startBearing = Math.atan2(x7 - IDEAL_CENTRE.x, z - IDEAL_CENTRE.z);
  const laps = 2.3;
  const speed = 8;
  const total = (laps * 2 * Math.PI * IDEAL_RADIUS) / speed;
  for (let i = 0; i < total / DT; i++) {
    const a = startBearing + (i * DT * speed) / IDEAL_RADIUS;
    const launching = i * DT < 0.6;
    const x = IDEAL_CENTRE.x + Math.sin(a) * IDEAL_RADIUS, zz = IDEAL_CENTRE.z + Math.cos(a) * IDEAL_RADIUS;
    const travel = a + Math.PI / 2;
    push({
      phase: 'donuts', dp: launching ? 'launch' : 'drift', x, z: zz, travel, slip: launching ? (i * DT / 0.6) * IDEAL_SLIP : IDEAL_SLIP,
      speed: launching ? 4.5 + (i * DT / 0.6) * 3.5 : speed, keys: 'WA', thr: 1, spin: 0.8
    });
  }
  // The way out: power out down 7th Ave, 0 → 75 mph
  const exitStart = frames[frames.length - 1];
  let x = exitStart.x, zz = exitStart.z;
  let v = 8;
  for (let i = 0; i < 0.5 / DT; i++) {
    x += (x7 - x) * 0.1;
    zz += v * DT;
    push({ phase: 'donuts', dp: 'powerOut', x, z: zz, travel: 0, slip: IDEAL_SLIP * (1 - i * DT / 0.5), speed: v, keys: 'W', thr: 1 });
    v += 9 * DT;
  }
  events.push({ kind: 'phase', t, from: 'donuts', to: 'escape' });
  const run = [
    { x: x7, z: streetZ(42) - 5.5 }, { x: avenueX('8'), z: streetZ(42) - 3.5 }, { x: avenueX('8'), z: streetZ(57) - 3.5 },
    { x: avenueX('9'), z: streetZ(57) - 3.5 }, { x: avenueX('9'), z: streetZ(42) + 30 }
  ];
  events.push({ kind: 'path', t, points: [[x, zz], [x7, COP.z + 40], ...run.map((p) => [p.x, p.z])] });
  // Along the run's legs, each corner rounded on an arc: up to 75 mph on the straights, 15 m/s through the corners,
  // sideways round them
  const path = roundedPath([{ x: x7, z: zz }, ...run], CORNER_RADIUS);
  const end = path.points[path.points.length - 1].s;
  let phase = 'escape';
  let splitDone = false;
  for (let s = 0, i = 0; s < end;) {
    const next = path.corners.find((c) => c > s);
    const cap = next === undefined ? 20 : Math.min(33.5, 15 + Math.max(0, next - s - CORNER_RADIUS) * 0.6);
    v = Math.min(cap, v + 9 * DT);
    s += v * DT;
    while (i < path.points.length - 2 && path.points[i + 1].s < s) i++;
    const p = path.points[i];
    const nearest = Math.min(...path.corners.map((c) => Math.abs(c - s)));
    if (p.leg >= 4) phase = 'swim';
    push({ phase, x: p.x, z: p.z, travel: p.h, slip: nearest < CORNER_SLIDE ? CORNER_SLIP : 0, speed: v, keys: 'W', thr: 1, copState: 'chasing' });
    if (!splitDone && p.leg === 0 && v > 30) {
      splitDone = true;
      events.push({ kind: 'split', t, x: p.x, z: p.z, mph: Math.round(v * 2.237), phase });
      events.push({ kind: 'close', t: t + 0.5, x: p.x, z: p.z + 15, mph: Math.round(v * 2.237), phase });
    }
  }
  return { source: 'run', label: 'synthetic ideal show', cop: { ...COP }, frames, events, meta: { synthetic: true, lapsBefore: 0 } };
}

// A polyline with each corner rounded on an arc of `radius`: points every PATH_STEP m ({ x, z, h, s: m along, leg }),
// and the m along it of each arc's middle
function roundedPath(pts, radius) {
  const points = [];
  const corners = [];
  let s = 0;
  const add = (x, z, h, leg) => {
    const last = points[points.length - 1];
    if (last) s += Math.hypot(x - last.x, z - last.z);
    points.push({ x, z, h, s, leg });
  };
  const line = (a, b, leg) => {
    const h = Math.atan2(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / PATH_STEP));
    for (let k = 0; k < n; k++) add(a.x + ((b.x - a.x) * k) / n, a.z + ((b.z - a.z) * k) / n, h, leg);
  };
  let from = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i];
    const hIn = Math.atan2(b.x - from.x, b.z - from.z);
    if (i === pts.length - 1) {
      line(from, b, i - 1);
      add(b.x, b.z, hIn, i - 1);
      break;
    }
    const c = pts[i + 1];
    const hOut = Math.atan2(c.x - b.x, c.z - b.z);
    const turn = wrapAngle(hOut - hIn);
    const cut = radius * Math.tan(Math.abs(turn) / 2); // m from the corner to where the arc meets each leg
    const enter = { x: b.x - Math.sin(hIn) * cut, z: b.z - Math.cos(hIn) * cut };
    line(from, enter, i - 1);
    // the arc's centre: to the side the road turns to (+ turn is to the left, heading atan2(x, z))
    const side = Math.sign(turn);
    const cx = enter.x + Math.cos(hIn) * radius * side, cz = enter.z - Math.sin(hIn) * radius * side;
    const n = Math.max(2, Math.ceil((radius * Math.abs(turn)) / PATH_STEP));
    for (let k = 0; k < n; k++) {
      const h = hIn + (turn * k) / n;
      add(cx - Math.cos(h) * radius * side, cz + Math.sin(h) * radius * side, h, k < n / 2 ? i - 1 : i);
      if (k === Math.floor(n / 2)) corners.push(s);
    }
    from = { x: b.x + Math.sin(hOut) * cut, z: b.z + Math.cos(hOut) * cut };
  }
  return { points, corners };
}

// One break per beat: what it changes, and the beat it must fail
const BREAKS = [
  { beat: 1, name: 'start on the plaza', apply: (tr) => shiftWhere(tr, (f) => f.phase === 'roll', -13, 0) },
  { beat: 1, name: 'start heading away from the cop', apply: (tr) => { tr.frames[0].h += Math.PI; } },
  { beat: 2, name: 'roll at 16 mph', apply: (tr) => scaleSpeedWhere(tr, (f) => f.phase === 'roll', 1.6) },
  { beat: 2, name: 'roll only 1.5 s', apply: (tr) => { const roll = tr.frames.filter((f) => f.phase === 'roll'); for (const f of roll.slice(90)) f.phase = 'off'; tr.frames = tr.frames.filter((f) => f.phase !== 'off'); } },
  { beat: 2, name: 'burnout in the roll', apply: (tr) => { for (const f of tr.frames.filter((q) => q.phase === 'roll').slice(60, 90)) f.spin = 1; } },
  { beat: 3, name: 'launch off the gas', apply: (tr) => { for (const f of tr.frames.filter((q) => q.dp === 'launch')) { f.k = ''; f.thr = 0; f.spin = 0; } } },
  { beat: 4, name: 'circle 5 m off the cop', apply: (tr) => shiftWhere(tr, (f) => f.phase === 'donuts' && f.dp !== 'powerOut', 5, 0) },
  { beat: 4, name: 'one lap only', apply: (tr) => { const d = tr.frames.filter((f) => f.phase === 'donuts' && f.dp === 'drift'); for (const f of d.slice(Math.floor(d.length * 0.45))) f.dp = 'cut'; tr.frames = tr.frames.filter((f) => f.dp !== 'cut'); retime(tr); } },
  { beat: 4, name: 'touches the cop', apply: (tr) => { tr.frames.find((f) => f.dp === 'drift').copHit = 1; } },
  { beat: 4, name: 'circle radius 14 m (over the kerb)', apply: (tr) => scaleRadius(tr, 14 / IDEAL_RADIUS) },
  { beat: 4, name: 'drift angle 15°', apply: (tr) => { for (const f of tr.frames.filter((q) => q.dp === 'drift')) f.slip = -15 * RAD; } },
  // (Codex round 1's false passes, kept as breaks)
  { beat: 4, name: 'donut gripping 90 % of the way round', apply: (tr) => { const d = tr.frames.filter((q) => q.dp === 'drift'); d.forEach((f, i) => { if (i % 10) f.slip = 0; }); } },
  { beat: 4, name: 'an ellipse (5.7 × 10.3 m) round the cop', apply: (tr) => { for (const f of tr.frames.filter((q) => q.phase === 'donuts' && q.dp !== 'powerOut')) { f.x = COP.x + 1 + (f.x - COP.x - 1) * (5.7 / IDEAL_RADIUS); f.z = COP.z + (f.z - COP.z) * (10.3 / IDEAL_RADIUS); } } },
  { beat: 5, name: 'contacts while powering out', apply: (tr) => { for (const f of tr.frames.filter((q) => q.dp === 'powerOut')) f.bHit = 1; } },
  { beat: 8, name: 'the run cut before the roam (no roam proper)', expect: 'INCONCLUSIVE', apply: (tr) => { tr.frames = tr.frames.filter((f) => f.t <= 75); } },
  { beat: 5, name: 'slow way out (40% speed)', apply: (tr) => { const e = tr.frames.findIndex((f) => f.dp === 'powerOut'); for (const f of tr.frames.slice(e, e + 300)) f.v *= 0.4, f.vx *= 0.4, f.vz *= 0.4; } },
  { beat: 6, name: 'hits traffic on 7th Ave', apply: (tr) => { const f = tr.frames.find((q) => q.phase === 'escape' && q.v > 25); tr.events.push({ kind: 'contact-traffic', t: f.t, x: f.x, z: f.z, mph: 60, phase: 'escape' }); } },
  // (Codex round 3: a contact the traffic resolves inside the tick shows only as the game's own impact report)
  { beat: 6, name: 'a traffic impact only the game reported', apply: (tr) => { const f = tr.frames.find((q) => q.phase === 'escape' && q.v > 25); tr.events.push({ kind: 'impact-traffic', t: f.t, x: f.x, z: f.z, speed: 3, phase: 'escape' }); } },
  { beat: 6, name: '7th Ave at 60 mph', apply: (tr) => { for (const f of tr.frames.filter((q) => q.phase === 'escape' && q.z < streetZ(42) - 20 && q.z > COP.z)) { const k = Math.min(1, 26.8 / Math.max(1, Math.hypot(f.v, f.vx, f.vz))); f.v *= k; f.vx *= k; f.vz *= k; } } },
  { beat: 6, name: 'no splits', apply: (tr) => { tr.events = tr.events.filter((e) => e.kind !== 'split'); } },
  // (Codex 2026-11-03 #8's false passes, kept as breaks: passes scored off the 7th Ave stretch, a detour off its
  // carriageway at speed, and 70 mph reached for one frame only)
  { beat: 6, name: 'splits and close calls only on Eighth', criterion: 'splits on 7th Ave', apply: (tr) => movePassesTo(tr, (f) => Math.abs(f.x - avenueX('8')) < 1 && f.z < streetZ(42) - 30 && f.z > streetZ(57) + 30) },
  { beat: 6, name: 'fast straight detours over plaza', criterion: 'frames off 7th Ave or over the kerb on it', apply: (tr) => shiftWhere(tr, (f) => f.phase === 'escape' && Math.abs(f.x - avenueX('7')) < 0.5 && f.z > PLAZA_EAST_OF_7TH[0] && f.z < PLAZA_EAST_OF_7TH[1], 13, 0) },
  { beat: 6, name: '70 mph touched for one frame on 7th Ave', criterion: 'held ≥ 70 mph unbroken on 7th Ave', apply: (tr) => oneFastFrame(tr, 29, 32.2) },
  { beat: 7, name: 'a corner gripped', apply: (tr) => { for (const f of tr.frames) if (Math.hypot(f.x - avenueX('8'), f.z - (streetZ(42) - 3.5)) < 40) f.slip = 0; } },
  // (Codex 2026-11-03 #9's false pass, and the other ways a corner can be sideways without being drifted)
  { beat: 7, name: 'all corners grip except one slip-spike frame per corner', criterion: DRIFTED, apply: (tr) => slipNearCorners(tr, (near) => { near.forEach((f) => { f.slip = 0; }); near[Math.floor(near.length / 2)].slip = -CORNER_SLIP; }) },
  { beat: 7, name: 'every corner sideways only 0.3 s', criterion: DRIFTED, apply: (tr) => slipNearCorners(tr, (near) => { const mid = Math.floor(near.length / 2); near.forEach((f, i) => { f.slip = Math.abs(i - mid) < 0.15 / DT ? -CORNER_SLIP : 0; }); }) },
  { beat: 7, name: 'every corner\'s slide broken every 0.2 s', criterion: DRIFTED, apply: (tr) => slipNearCorners(tr, (near) => { near.forEach((f, i) => { if (Math.floor((i * DT) / 0.2) % 2) f.slip = 0; }); }) },
  { beat: 7, name: 'every corner gripped round, sideways only once out of it', criterion: DRIFTED, apply: (tr) => slipNearCorners(tr, (near, c) => { near.forEach((f) => { const past = (f.x - c[0]) * Math.sin(f.h) + (f.z - c[1]) * Math.cos(f.h); f.slip = past > 12 ? -CORNER_SLIP : 0; }); }) },
  { beat: 7, name: 'the route turns where the car drives straight on', criterion: 'turns completed', apply: (tr) => { const p = tr.events.find((e) => e.kind === 'path'); p.points.splice(2, 0, [avenueX('7'), streetZ(44)], [avenueX('7') + 60, streetZ(44)], [avenueX('7'), streetZ(44) + 1]); } },
  { beat: 7, name: 'a corner cut over the pavement', apply: (tr) => shiftWhere(tr, (f) => Math.hypot(f.x - avenueX('8'), f.z - (streetZ(57) - 3.5)) < 25, 11, 11) },
  { beat: 8, name: 'roam stuck 15 s', apply: (tr) => stall(tr, 15) }
];

function shiftWhere(tr, test, dx, dz) {
  for (const f of tr.frames) if (test(f)) { f.x += dx; f.z += dz; }
}

// Each of the run's corners: its frames within 40 m, handed to `edit` with the corner
function slipNearCorners(tr, edit) {
  const path = tr.events.find((e) => e.kind === 'path').points;
  for (const c of path.slice(2, -1)) {
    const near = tr.frames.filter((f) => f.phase !== 'donuts' && Math.hypot(f.x - c[0], f.z - c[1]) < 40);
    if (near.length) edit(near, c);
  }
}

// Every split and close call moved onto frames that pass `test` (a third of the way along them, a second apart)
function movePassesTo(tr, test) {
  const frames = tr.frames.filter(test);
  let i = 0;
  for (const e of tr.events.filter((q) => q.kind === 'split' || q.kind === 'close')) {
    const f = frames[Math.min(frames.length - 1, Math.floor(frames.length / 3) + 60 * i++)];
    Object.assign(e, { t: f.t, x: f.x, z: f.z });
  }
}

// The 7th Ave stretch held under `cap` m/s but for one frame at `peak` m/s
function oneFastFrame(tr, cap, peak) {
  const stretch = tr.frames.filter((f) => f.phase === 'escape' && Math.abs(f.x - avenueX('7')) < 0.5 && f.z < streetZ(42) - 25);
  const scaleTo = (f, mps) => {
    const k = mps / Math.max(1e-6, Math.hypot(Math.sin(f.h) * f.v + f.vx, Math.cos(f.h) * f.v + f.vz));
    f.v *= k; f.vx *= k; f.vz *= k;
  };
  for (const f of stretch) if (Math.hypot(Math.sin(f.h) * f.v + f.vx, Math.cos(f.h) * f.v + f.vz) > cap) scaleTo(f, cap);
  scaleTo(stretch[Math.floor(stretch.length * 0.8)], peak);
}

function scaleSpeedWhere(tr, test, k) {
  for (const f of tr.frames) if (test(f)) { f.v *= k; f.vx *= k; f.vz *= k; }
}

function scaleRadius(tr, k) {
  for (const f of tr.frames) {
    if (f.phase !== 'donuts' || f.dp === 'powerOut') continue;
    f.x = COP.x + (f.x - COP.x) * k;
    f.z = COP.z + (f.z - COP.z) * k;
  }
}

function retime(tr) {
  let t = 0;
  for (const f of tr.frames) {
    t += f.dt;
    f.t = +t.toFixed(4);
  }
}

// The car standing still for `seconds` in the middle of its roam (frames inserted, the rest of the run later)
function stall(tr, seconds) {
  const roamStart = tr.frames.findIndex((f) => f.phase === 'swim');
  const at = roamStart + Math.floor((tr.frames.length - roamStart) / 2);
  const still = tr.frames[at];
  const inserted = Array.from({ length: Math.round(seconds / DT) }, () => ({ ...still, v: 0, vx: 0, vz: 0, slip: 0, k: '' }));
  tr.frames.splice(at, 0, ...inserted);
  retime(tr);
}

// The ideal trace with one break applied (a fresh copy each time)
function brokenTrace(brk) {
  const tr = idealTrace();
  brk.apply(tr);
  tr.label = `synthetic: ${brk.name}`;
  return tr;
}

export { BREAKS, IDEAL_RADIUS, brokenTrace, idealTrace, wrapAngle };
