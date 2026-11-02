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
  // Along the run's legs: up to 75 mph on the straights, 15 m/s through the corners, sideways round them
  let from = { x: x7, z: zz };
  let phase = 'escape';
  let splitDone = false;
  for (let leg = 0; leg < run.length; leg++) {
    const to = run[leg];
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    const travel = Math.atan2(to.x - from.x, to.z - from.z);
    for (let s = 0; s < length;) {
      const toCorner = length - s;
      const cornerAhead = leg < run.length - 1;
      const cap = cornerAhead ? Math.min(33.5, 15 + toCorner * 0.6) : 20;
      v = Math.min(cap, v + 9 * DT);
      if (v > cap) v = cap;
      s += v * DT;
      const k = Math.min(1, s / length);
      const px = from.x + (to.x - from.x) * k, pz = from.z + (to.z - from.z) * k;
      const sinceCorner = s, untilCorner = length - s;
      const sideways = (leg > 0 && sinceCorner < CORNER_SLIDE) || (cornerAhead && untilCorner < CORNER_SLIDE);
      if (leg >= 4) phase = 'swim';
      push({ phase, x: px, z: pz, travel, slip: sideways ? CORNER_SLIP : 0, speed: v, keys: 'W', thr: 1, copState: 'chasing' });
      if (!splitDone && leg === 0 && v > 30) {
        splitDone = true;
        events.push({ kind: 'split', t, x: px, z: pz, mph: Math.round(v * 2.237), phase });
        events.push({ kind: 'close', t: t + 0.5, x: px, z: pz + 15, mph: Math.round(v * 2.237), phase });
      }
    }
    from = to;
  }
  return { source: 'run', label: 'synthetic ideal show', cop: { ...COP }, frames, events, meta: { synthetic: true, lapsBefore: 0 } };
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
  { beat: 7, name: 'a corner cut over the pavement', apply: (tr) => shiftWhere(tr, (f) => Math.hypot(f.x - avenueX('8'), f.z - (streetZ(57) - 3.5)) < 25, 11, 11) },
  { beat: 8, name: 'roam stuck 15 s', apply: (tr) => stall(tr, 15) }
];

function shiftWhere(tr, test, dx, dz) {
  for (const f of tr.frames) if (test(f)) { f.x += dx; f.z += dz; }
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
