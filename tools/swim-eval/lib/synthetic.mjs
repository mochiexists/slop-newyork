// A made-up trace of the show as musa's checklist wants it, and one deliberate break per beat. The checker must pass
// the ideal one on every beat (so no check is impossible to meet) and fail each broken one on its beat (so no check
// is one that can't fail). The ideal show: rolling down a 7th Ave lane toward the cop at 10 mph for 4 s, floored, two
// and a bit laps round the cop at 8.2 m and 40° (centred 1 m east of it: the circle that stays clear of the kerb there, by
// the game's map),
// out down 7th Ave to 75 mph with a split and a close call, drifting the run's corners (42nd St, 8th Ave, 57th St, 9th
// Ave) and roaming down 9th Ave. That is the show as it stood to e7f9c83 (the cop at 7th Ave & 45th St); the same show
// is also laid out the way worker C moves it (2026-11-03: the cop at 7th & 42nd, the run's first turn at 34th St), so
// the checker is seen judging both by the trace's own cop and route.
import { avenueX, streetZ } from '../../../js/city-config.js';
import { COP, wrapAngle } from './geometry.mjs';

const RAD = Math.PI / 180;
const DT = 1 / 60;
const BIRD_LAPS = [1.15, 1.85]; // swim-show.js: the bird out of the window between these laps
const IDEAL_RADIUS = 8.2;
const IDEAL_SLIP = 40 * RAD;
const CORNER_SLIP = 25 * RAD;
const CORNER_SLIDE = 18; // m either side of a corner that the car is sideways
const CORNER_RADIUS = 10; // m, the arc each corner of the run is driven on
const MID_BLOCK = 0.47; // the share of the roam where the car is mid-block on 9th Ave (50th-49th St)
const STUCK = 'stuck, not at a red light (10 s inside 5 m)'; // beat 8's criterion
const DRIFTED = 'drifted (one unbroken spell ≥ 15°, ≥ 0.5 s, ≥ 50% of the turn)'; // beat 7's criterion
const PATH_STEP = 0.25; // m between the points of the run's path
// z (m) of 7th Ave's stretch with Times Square's plaza east of it (45th-43rd St, 10-16 m off the avenue's line)
const PLAZA_EAST_OF_7TH = [-205, -125];
const WESTBOUND = -3.5; // m off a two-way street's line: its westbound half (swim-show.js)

// Where the show is staged: the cop, the circle round it, the run's corners after the way out down 7th Ave
const LAYOUTS = {
  // (the circle centred 1 m east of the cop: where a 40° circle clears the kerb all the way round)
  '45th': {
    cop: COP, centre: { x: COP.x + 1, z: COP.z }, radius: IDEAL_RADIUS,
    run: [[avenueX('7'), streetZ(42) - 5.5], [avenueX('8'), streetZ(42) + WESTBOUND], [avenueX('8'), streetZ(57) + WESTBOUND], [avenueX('9'), streetZ(57) + WESTBOUND], [avenueX('9'), streetZ(42) + 30]]
  },
  // (the seat's donut-fit: a circle of 8-9 m round a cop at 7th & 42nd keeps the whole car on the road)
  '42nd': {
    cop: { x: -585.5, z: 1.0 }, centre: { x: -585.5, z: 1.0 }, radius: 8.5,
    run: [[avenueX('7'), streetZ(34) + WESTBOUND], [avenueX('8'), streetZ(34) + WESTBOUND], [avenueX('8'), streetZ(57) + WESTBOUND], [avenueX('9'), streetZ(57) + WESTBOUND], [avenueX('9'), streetZ(42) + 30]]
  }
};

function frameAt(state, t, cop) {
  // The car body turned `slip` off the direction of travel; its velocity over the ground along that direction
  const h = state.travel - state.slip;
  const wx = Math.sin(state.travel) * state.speed, wz = Math.cos(state.travel) * state.speed;
  const v = wx * Math.sin(h) + wz * Math.cos(h);
  return {
    f: Math.round(t / DT), t: +t.toFixed(4), dt: DT, wall: null, phase: state.phase, dp: state.dp ?? null, laps: null,
    x: state.x, z: state.z, h, v, vx: wx - Math.sin(h) * v, vz: wz - Math.cos(h) * v, w: 0, st: 0,
    slip: -state.slip, spin: state.spin ?? 0, gear: 2, k: state.keys, thr: state.thr ?? 0, brk: 0, hb: 0,
    cx: cop.x, cz: cop.z, ch: -Math.PI / 2, cs: state.copState ?? 'parked', tGap: 5, tHit: 0, bHit: 0, copHit: 0,
    seg: 0, rev: 0, queued: 0, cam: 0, pk: '', pilot: 1, bird: state.bird ?? 0, birdSeen: 1, sig: null
  };
}

function idealTrace(layoutName = '45th') {
  const layout = LAYOUTS[layoutName];
  const { cop, centre, radius } = layout;
  const frames = [];
  const events = [];
  let t = 0;
  const push = (state) => {
    t += DT;
    frames.push(frameAt(state, t, cop));
  };
  // Roll: down 7th Ave's middle lane at 10 mph (4.5 m/s), 4 s, from 30 m short of the cop's line
  const x7 = avenueX('7');
  let z = cop.z - 34;
  for (let i = 0; i < 4 / DT; i++) {
    const speed = Math.min(4.5, 0.5 + i * DT * 3);
    z += speed * DT;
    push({ phase: 'roll', dp: 'roll', x: x7, z, travel: 0, slip: 0, speed, keys: i % 20 < 8 ? 'W' : '', thr: 0.3 });
  }
  events.push({ kind: 'phase', t, from: 'roll', to: 'donuts' });
  // Launch onto the circle (joining it due north of the cop... on the line round), floored: 0.6 s
  // Donuts: 2.3 laps anticlockwise seen from above at the layout's radius, 8 m/s, 40° sideways
  const startBearing = Math.atan2(x7 - centre.x, z - centre.z);
  const laps = 2.3;
  const speed = 8;
  const total = (laps * 2 * Math.PI * radius) / speed;
  for (let i = 0; i < total / DT; i++) {
    const a = startBearing + (i * DT * speed) / radius;
    const launching = i * DT < 0.6;
    const x = centre.x + Math.sin(a) * radius, zz = centre.z + Math.cos(a) * radius;
    const travel = a + Math.PI / 2;
    const lap = (i * DT * speed) / (2 * Math.PI * radius);
    push({
      bird: lap > BIRD_LAPS[0] && lap < BIRD_LAPS[1] ? 1 : 0,
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
  const run = layout.run.map(([px, pz]) => ({ x: px, z: pz }));
  events.push({ kind: 'path', t, points: [[x, zz], [x7, cop.z + 40], ...run.map((p) => [p.x, p.z])] });
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
  // (the show's ESCAPE_ROUTE, as a run's trace carries it: from the cop to where the roam takes over)
  const route = [{ ...cop }, ...run.slice(0, 4)];
  return { source: 'run', label: `synthetic ideal show (${layoutName} St layout)`, cop: { ...cop }, route, frames, events, meta: { synthetic: true, lapsBefore: 0, layout: layoutName } };
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

// The ideal show with a player in it: 5 s into the run D takes the wheel (held 1 s, then off the keys, coasting), and
// 3 s later I hands it back: the AI roams on from where the car is, on a route starting there. 15 s of it after I.
const TAKE_AFTER_RUN = 5, TAKE_HOLD = 1, HAND_BACK_AFTER = 3, AFTER_HAND_BACK = 15; // s
function handoffTrace(layoutName = '45th') {
  const tr = idealTrace(layoutName);
  const runStart = tr.frames.find((f) => f.phase === 'escape').t;
  const take = runStart + TAKE_AFTER_RUN, back = take + HAND_BACK_AFTER;
  tr.frames = tr.frames.filter((f) => f.t <= back + AFTER_HAND_BACK);
  for (const f of tr.frames) {
    if (f.t <= take) continue;
    if (f.t <= back) {
      const held = f.t <= take + TAKE_HOLD ? 'D' : '';
      Object.assign(f, { phase: 'off', pilot: 0, k: held, pk: held, thr: 0 });
    } else {
      Object.assign(f, { phase: 'roam', pilot: 1, k: 'W', pk: '' });
    }
  }
  const at = tr.frames.filter((f) => f.t <= back).pop();
  const next = tr.frames.find((f) => f.t > back);
  tr.events = tr.events.filter((e) => e.t <= take);
  tr.events.push({ kind: 'input', key: 'KeyD', action: 'down', t: take }, { kind: 'input', key: 'KeyD', action: 'up', t: take + TAKE_HOLD });
  tr.events.push({ kind: 'input', key: 'KeyI', action: 'press', t: back });
  tr.events.push({ kind: 'phase', t: back, from: 'off', to: 'roam' });
  tr.events.push({ kind: 'path', t: next.t, points: [[+at.x.toFixed(1), +at.z.toFixed(1)], [at.x + 200, at.z]] });
  tr.label = `synthetic handoff (${layoutName} St layout)`;
  return tr;
}

// One break per beat: what it changes, and the beat it must fail; on the 45th St layout, or on both (BOTH) where the
// break reads nothing but the trace's own cop, route and phases
const BOTH = Object.keys(LAYOUTS);
const BREAKS = [
  { beat: 1, name: 'start on the plaza', apply: (tr) => shiftWhere(tr, (f) => f.phase === 'roll', -13, 0) },
  { beat: 1, name: 'start heading away from the cop', layouts: BOTH, apply: (tr) => { tr.frames[0].h += Math.PI; } },
  { beat: 2, name: 'roll at 16 mph', layouts: BOTH, apply: (tr) => scaleSpeedWhere(tr, (f) => f.phase === 'roll', 1.6) },
  { beat: 2, name: 'roll only 1.5 s', apply: (tr) => { const roll = tr.frames.filter((f) => f.phase === 'roll'); for (const f of roll.slice(90)) f.phase = 'off'; tr.frames = tr.frames.filter((f) => f.phase !== 'off'); } },
  { beat: 2, name: 'burnout in the roll', apply: (tr) => { for (const f of tr.frames.filter((q) => q.phase === 'roll').slice(60, 90)) f.spin = 1; } },
  { beat: 3, name: 'launch off the gas', apply: (tr) => { for (const f of tr.frames.filter((q) => q.dp === 'launch')) { f.k = ''; f.thr = 0; f.spin = 0; } } },
  { beat: 4, name: 'circle 5 m off the cop', layouts: BOTH, apply: (tr) => shiftWhere(tr, (f) => f.phase === 'donuts' && f.dp !== 'powerOut', 5, 0) },
  { beat: 4, name: 'one lap only', apply: (tr) => { const d = tr.frames.filter((f) => f.phase === 'donuts' && f.dp === 'drift'); for (const f of d.slice(Math.floor(d.length * 0.45))) f.dp = 'cut'; tr.frames = tr.frames.filter((f) => f.dp !== 'cut'); retime(tr); } },
  // (Codex 2026-11-03 #11: the bird is part of the donuts)
  { beat: 4, name: 'no bird during the donuts', layouts: BOTH, criterion: 'the bird shown (hand up, arms drawn)', apply: (tr) => { for (const f of tr.frames) f.bird = 0; } },
  { beat: 4, name: 'the bird up for 0.5 s only', criterion: 'the bird shown (hand up, arms drawn)', apply: (tr) => { const up = tr.frames.filter((f) => f.bird > 0); up.forEach((f, i) => { if (i * DT >= 0.5) f.bird = 0.5; }); } },
  { beat: 4, name: 'the bird up with the driver not drawn', criterion: 'the bird shown (hand up, arms drawn)', apply: (tr) => { for (const f of tr.frames) f.birdSeen = 0; } },
  { beat: 4, name: 'touches the cop', layouts: BOTH, apply: (tr) => { tr.frames.find((f) => f.dp === 'drift').copHit = 1; } },
  { beat: 4, name: 'circle radius 14 m (over the kerb)', apply: (tr) => scaleRadius(tr, 14 / IDEAL_RADIUS) },
  { beat: 4, name: 'drift angle 15°', layouts: BOTH, apply: (tr) => { for (const f of tr.frames.filter((q) => q.dp === 'drift')) f.slip = -15 * RAD; } },
  // (Codex round 1's false passes, kept as breaks)
  { beat: 4, name: 'donut gripping 90 % of the way round', apply: (tr) => { const d = tr.frames.filter((q) => q.dp === 'drift'); d.forEach((f, i) => { if (i % 10) f.slip = 0; }); } },
  { beat: 4, name: 'an ellipse (5.7 × 10.3 m) round the cop', apply: (tr) => { for (const f of tr.frames.filter((q) => q.phase === 'donuts' && q.dp !== 'powerOut')) { f.x = COP.x + 1 + (f.x - COP.x - 1) * (5.7 / IDEAL_RADIUS); f.z = COP.z + (f.z - COP.z) * (10.3 / IDEAL_RADIUS); } } },
  { beat: 5, name: 'contacts while powering out', layouts: BOTH, apply: (tr) => { for (const f of tr.frames.filter((q) => q.dp === 'powerOut')) f.bHit = 1; } },
  { beat: 8, name: 'the run cut before the roam (no roam proper)', expect: 'INCONCLUSIVE', apply: (tr) => { tr.frames = tr.frames.filter((f) => f.t <= 75); } },
  { beat: 5, name: 'slow way out (40% speed)', apply: (tr) => { const e = tr.frames.findIndex((f) => f.dp === 'powerOut'); for (const f of tr.frames.slice(e, e + 300)) f.v *= 0.4, f.vx *= 0.4, f.vz *= 0.4; } },
  { beat: 6, name: 'hits traffic on 7th Ave', layouts: BOTH, apply: (tr) => { const f = tr.frames.find((q) => q.phase === 'escape' && q.v > 25); tr.events.push({ kind: 'contact-traffic', t: f.t, x: f.x, z: f.z, mph: 60, phase: 'escape' }); } },
  // (Codex round 3: a contact the traffic resolves inside the tick shows only as the game's own impact report)
  { beat: 6, name: 'a traffic impact only the game reported', apply: (tr) => { const f = tr.frames.find((q) => q.phase === 'escape' && q.v > 25); tr.events.push({ kind: 'impact-traffic', t: f.t, x: f.x, z: f.z, speed: 3, phase: 'escape' }); } },
  // (Codex 2026-11-03 #10: a grazing sideswipe, under the impact report's 0.5 m/s and gone before the record, that only
  // the contact hook sees)
  { beat: 6, name: 'a grazing sideswipe only the contact hook saw', layouts: BOTH, criterion: 'traffic contacts', apply: (tr) => { const f = tr.frames.find((q) => q.phase === 'escape' && q.v > 25); tr.events.push({ kind: 'touch-traffic', t: f.t, x: f.x, z: f.z, depth: 0.004, closing: 0.2, mph: 60, phase: 'escape' }); } },
  // (Codex round 1: the way out reaching 50 mph well before the show's escape phase, a contact and a kerb in between)
  { beat: 6, name: 'a contact and a kerb between 50 mph and the escape phase', layouts: BOTH, criterion: 'traffic contacts', apply: (tr) => {
    const escape = tr.frames.filter((f) => f.phase === 'escape');
    // (the powering out held on 3 s into the run; 50 mph comes ~1.2 s into it)
    const late = escape.filter((f) => f.t < escape[0].t + 3);
    for (const f of late) Object.assign(f, { phase: 'donuts', dp: 'powerOut' });
    const start = tr.frames.find((f) => f.phase === 'escape').t;
    for (const e of tr.events) if (e.kind === 'path' || (e.kind === 'phase' && e.to === 'escape')) e.t = start;
    const gap = late[Math.floor(late.length * 0.85)];
    gap.x += 13;
    tr.events.push({ kind: 'touch-traffic', t: gap.t, x: gap.x, z: gap.z, depth: 0.01, closing: 0.3, mph: 60, phase: 'donuts' });
  } },
  { beat: 6, name: '7th Ave at 60 mph', apply: (tr) => { for (const f of tr.frames.filter((q) => q.phase === 'escape' && q.z < streetZ(42) - 20 && q.z > COP.z)) { const k = Math.min(1, 26.8 / Math.max(1, Math.hypot(f.v, f.vx, f.vz))); f.v *= k; f.vx *= k; f.vz *= k; } } },
  { beat: 6, name: 'no splits', layouts: BOTH, apply: (tr) => { tr.events = tr.events.filter((e) => e.kind !== 'split'); } },
  // (Codex 2026-11-03 #8's false passes, kept as breaks: passes scored off the 7th Ave stretch, a detour off its
  // carriageway at speed, and 70 mph reached for one frame only)
  { beat: 6, name: 'splits and close calls only on Eighth', layouts: BOTH, criterion: 'splits on 7th Ave', apply: (tr) => movePassesTo(tr, (f) => Math.abs(f.x - avenueX('8')) < 1 && f.z < streetZ(42) - 30 && f.z > streetZ(57) + 30) },
  { beat: 6, name: 'fast straight detours over plaza', criterion: 'frames off 7th Ave or over the kerb on it', apply: (tr) => shiftWhere(tr, (f) => f.phase === 'escape' && Math.abs(f.x - avenueX('7')) < 0.5 && f.z > PLAZA_EAST_OF_7TH[0] && f.z < PLAZA_EAST_OF_7TH[1], 13, 0) },
  { beat: 6, name: '70 mph touched for one frame on 7th Ave', layouts: BOTH, criterion: 'held ≥ 70 mph unbroken on 7th Ave', apply: (tr) => oneFastFrame(tr, 29, 32.2) },
  { beat: 7, name: 'a corner gripped', apply: (tr) => { for (const f of tr.frames) if (Math.hypot(f.x - avenueX('8'), f.z - (streetZ(42) - 3.5)) < 40) f.slip = 0; } },
  // (Codex 2026-11-03 #9's false pass, and the other ways a corner can be sideways without being drifted)
  { beat: 7, name: 'all corners grip except one slip-spike frame per corner', layouts: BOTH, criterion: DRIFTED, apply: (tr) => slipNearCorners(tr, (near) => { near.forEach((f) => { f.slip = 0; }); near[Math.floor(near.length / 2)].slip = -CORNER_SLIP; }) },
  { beat: 7, name: 'every corner sideways only 0.3 s', layouts: BOTH, criterion: DRIFTED, apply: (tr) => slipNearCorners(tr, (near) => { const mid = Math.floor(near.length / 2); near.forEach((f, i) => { f.slip = Math.abs(i - mid) < 0.15 / DT ? -CORNER_SLIP : 0; }); }) },
  { beat: 7, name: 'every corner\'s slide broken every 0.2 s', criterion: DRIFTED, apply: (tr) => slipNearCorners(tr, (near) => { near.forEach((f, i) => { if (Math.floor((i * DT) / 0.2) % 2) f.slip = 0; }); }) },
  { beat: 7, name: 'every corner gripped round, sideways only once out of it', criterion: DRIFTED, apply: (tr) => slipNearCorners(tr, (near, c) => { near.forEach((f) => { const past = (f.x - c[0]) * Math.sin(f.h) + (f.z - c[1]) * Math.cos(f.h); f.slip = past > 12 ? -CORNER_SLIP : 0; }); }) },
  { beat: 7, name: 'the route turns where the car drives straight on', criterion: 'turns completed', apply: (tr) => { const p = tr.events.find((e) => e.kind === 'path'); p.points.splice(2, 0, [avenueX('7'), streetZ(44)], [avenueX('7') + 60, streetZ(44)], [avenueX('7'), streetZ(44) + 1]); } },
  // (Codex round 1: a corner never come within 25 m of was left out of the beat, not failed)
  { beat: 7, name: 'a corner never come within 25 m of', layouts: BOTH, criterion: 'corners missed (never within 25 m, the route beyond them driven)', apply: (tr) => { const c = tr.events.find((e) => e.kind === 'path').points[3]; tr.frames = tr.frames.filter((f) => Math.hypot(f.x - c[0], f.z - c[1]) >= 26); } },
  // (Codex round 2: ...and the trace ending on the leg after it, short of the next corner)
  { beat: 7, name: 'a corner never come within 25 m of, the trace ending 100 m on', layouts: BOTH, criterion: 'corners missed (never within 25 m, the route beyond them driven)', apply: (tr) => {
    const pts = tr.events.find((e) => e.kind === 'path').points;
    const c = pts[3], next = pts[4];
    const out = Math.atan2(next[0] - c[0], next[1] - c[1]);
    tr.frames = tr.frames.filter((f) => Math.hypot(f.x - c[0], f.z - c[1]) >= 26);
    const end = tr.frames.findIndex((f) => (f.x - c[0]) * Math.sin(out) + (f.z - c[1]) * Math.cos(out) > 100 && Math.hypot(f.x - c[0], f.z - c[1]) < 110);
    tr.frames = tr.frames.slice(0, end);
  } },
  // (a corner over the kerb with the trace ending 40 m on, inside its turn's 60 m: its kerb still counts)
  { beat: 7, name: 'a corner cut over the pavement, the trace ending 40 m past it', criterion: 'on the road throughout', apply: (tr) => {
    const c = [avenueX('8'), streetZ(57) - 3.5];
    shiftWhere(tr, (f) => Math.hypot(f.x - c[0], f.z - c[1]) < 25, 11, 11);
    const end = tr.frames.findIndex((f) => f.t > 60 && Math.hypot(f.x - c[0], f.z - c[1]) > 40 && Math.hypot(f.x - c[0], f.z - c[1]) < 45 && f.x < c[0]);
    tr.frames = tr.frames.slice(0, end);
  } },
  { beat: 7, name: 'a corner cut over the pavement', apply: (tr) => shiftWhere(tr, (f) => Math.hypot(f.x - avenueX('8'), f.z - (streetZ(57) - 3.5)) < 25, 11, 11) },
  // (2026-11-03: a wait at a red light is not stuck, standing on a green is; both still count as stopped)
  { beat: 8, name: 'stuck 15 s on a green light', criterion: STUCK, apply: (tr) => stall(tr, 15, 'green') },
  { beat: 8, name: 'a 25 s wait in a red light\'s queue (not stuck; stopped too long)', criterion: STUCK, criterionPasses: true, apply: (tr) => stall(tr, 25, 'red', true) },
  // (Codex round 1: standing mid-block, in no queue, while the light happens to be red, is stuck)
  { beat: 8, name: 'an 11 s stall mid-block during a red, in no queue', criterion: STUCK, apply: (tr) => stall(tr, 11, 'red', false, MID_BLOCK) },
  // (Codex 2026-11-03 #11: any driving key takes over, I hands back; on the handoff show)
  { beat: 9, base: 'handoff', layouts: BOTH, name: 'the AI keeps driving through the player\'s key', criterion: 'the player\'s key (KeyD) wins at once', apply: (tr) => takeoverFrames(tr, (f) => Object.assign(f, { phase: 'escape', pilot: 1, k: 'W' })) },
  // (Codex round 1: a takeover wiped a contact from before it)
  { beat: 6, base: 'handoff', name: 'a traffic contact before the takeover', criterion: 'traffic contacts', apply: (tr) => { const take = tr.events.find((e) => e.kind === 'input').t; const f = tr.frames.filter((q) => q.t < take - 1).pop(); tr.events.push({ kind: 'touch-traffic', t: f.t, x: f.x, z: f.z, depth: 0.05, closing: 2, mph: 60, phase: 'escape' }); } },
  // (Codex round 2: a cop contact before the takeover, and the positive control: a run held under 70 mph until the
  // takeover cut it short is no failure of the show's)
  { beat: 6, base: 'handoff', name: 'a cop contact before the takeover', criterion: 'cop contacts (frames)', apply: (tr) => { const take = tr.events.find((e) => e.kind === 'input').t; tr.frames.filter((q) => q.t < take - 1).pop().copHit = 1; } },
  { beat: 6, base: 'handoff', name: 'the run under 70 mph until the takeover (cut short, not failed)', expect: 'N/A', apply: (tr) => { for (const f of tr.frames) { const g = Math.hypot(Math.sin(f.h) * f.v + f.vx, Math.cos(f.h) * f.v + f.vz); if (g > 26.8) { const k = 26.8 / g; f.v *= k; f.vx *= k; f.vz *= k; } } } },
  // (Codex round 3: ...but a stretch run under 70 mph all the way to its corner before the takeover is the show's failure)
  { beat: 6, base: 'handoff', layouts: BOTH, name: 'the whole 7th Ave stretch under 70 mph, the takeover after its corner', criterion: 'held ≥ 70 mph unbroken on 7th Ave', apply: (tr) => {
    const corner = tr.route[1];
    const reach = tr.frames.find((f) => f.phase !== 'roll' && f.phase !== 'donuts' && Math.hypot(f.x - corner.x, f.z - corner.z) < 25).t;
    for (const f of tr.frames) { const g = Math.hypot(Math.sin(f.h) * f.v + f.vx, Math.cos(f.h) * f.v + f.vz); if (g > 26.8) { const k = 26.8 / g; f.v *= k; f.vx *= k; f.vz *= k; } }
    retakeAt(tr, reach + 5);
  } },
  { beat: 9, base: 'handoff', name: 'the player\'s key lost for one tick', criterion: 'the player\'s key (KeyD) wins at once', apply: (tr) => takeoverFrames(tr, (f, i) => { if (i === 0) Object.assign(f, { phase: 'escape', pilot: 1, k: 'W' }); }) },
  { beat: 9, base: 'handoff', name: 'the AI grabs the wheel back before I', criterion: 'the AI lets go (ticks it still drove, to I)', apply: (tr) => takeoverFrames(tr, (f, i, all) => { if (i === Math.floor(all.length * 0.8)) Object.assign(f, { pilot: 1, k: 'W' }); }) },
  { beat: 9, base: 'handoff', name: 'I does nothing', criterion: 'I: the AI takes the wheel at once', apply: (tr) => { for (const f of handbackFrames(tr)) Object.assign(f, { phase: 'off', pilot: 0, k: '' }); tr.events = tr.events.filter((e) => !(e.kind === 'path' && e.t > handbackAt(tr))); } },
  { beat: 9, base: 'handoff', name: 'the roam starts 40 m from the car', criterion: 'I: its route starts where the car is', apply: (tr) => { const p = tr.events.filter((e) => e.kind === 'path').pop(); p.points[0][0] += 40; } },
  { beat: 9, base: 'handoff', layouts: BOTH, name: 'the car jumps 40 m at I', criterion: 'I: no jump across it', apply: (tr) => { for (const f of handbackFrames(tr)) f.x += 40; } },
  { beat: 9, base: 'handoff', name: 'the AI gives the car back 3 s after I', criterion: 'I: the AI drives on (10 s)', apply: (tr) => { for (const f of handbackFrames(tr)) if (f.t > handbackAt(tr) + 3) Object.assign(f, { phase: 'off', pilot: 0, k: '' }); } },
  { beat: 8, name: 'roam stuck 15 s', layouts: BOTH, apply: (tr) => stall(tr, 15) }
];

function shiftWhere(tr, test, dx, dz) {
  for (const f of tr.frames) if (test(f)) { f.x += dx; f.z += dz; }
}

// The handoff show's ticks between the takeover and I, and after I
function takeoverFrames(tr, edit) {
  const take = tr.events.find((e) => e.kind === 'input' && e.key === 'KeyD').t;
  const list = tr.frames.filter((f) => f.t > take && f.t <= handbackAt(tr));
  list.forEach((f, i) => edit(f, i, list));
}

// The handoff show's takeover and hand-back moved to `take` s (the frames re-labelled to match)
function retakeAt(tr, take) {
  const back = take + HAND_BACK_AFTER;
  for (const f of tr.frames) {
    if (f.t <= take) Object.assign(f, { phase: f.phase === 'off' || f.phase === 'roam' ? 'escape' : f.phase, pilot: 1, pk: '', k: f.phase === 'off' || f.phase === 'roam' ? 'W' : f.k });
    else if (f.t <= back) Object.assign(f, { phase: 'off', pilot: 0, k: f.t <= take + TAKE_HOLD ? 'D' : '', pk: f.t <= take + TAKE_HOLD ? 'D' : '' });
    else Object.assign(f, { phase: 'roam', pilot: 1, k: 'W', pk: '' });
  }
  for (const e of tr.events) {
    if (e.kind === 'input' && e.key === 'KeyD') e.t = e.action === 'up' ? take + TAKE_HOLD : take;
    if (e.kind === 'input' && e.key === 'KeyI') e.t = back;
  }
}

function handbackAt(tr) {
  return tr.events.find((e) => e.kind === 'input' && e.key === 'KeyI').t;
}

function handbackFrames(tr) {
  return tr.frames.filter((f) => f.t > handbackAt(tr));
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
  const stretch = tr.frames.filter((f) => f.phase === 'escape' && Math.abs(f.x - avenueX('7')) < 0.5 && f.z < tr.route[1].z - 25);
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

// The car standing still for `seconds` in the middle of its roam (frames inserted, the rest of the run later). With
// `light` ('red' | 'green'), the city's signal clock is logged too, set so the car's own light (an avenue's or a
// street's, by its heading) turns green 2 s before it goes again ('red'), or is green the whole stop ('green'); with
// `queued`, the AI's planner sees a queue ahead the whole stop. `share`: how far down the roam (the middle: 9th Ave, 21 m
// short of 49th St; 0.47: mid-block, ~60 m short of it).
function stall(tr, seconds, light = null, queued = false, share = 0.5) {
  const roamStart = tr.frames.findIndex((f) => f.phase === 'swim');
  const at = roamStart + Math.floor((tr.frames.length - roamStart) * share);
  const still = tr.frames[at];
  const inserted = Array.from({ length: Math.round(seconds / DT) }, () => ({ ...still, v: 0, vx: 0, vz: 0, slip: 0, k: '', queued: queued ? 1 : 0 }));
  tr.frames.splice(at, 0, ...inserted);
  retime(tr);
  if (!light) return;
  const avenue = Math.abs(Math.cos(still.h)) > Math.abs(Math.sin(still.h));
  // (city-config.js SIGNAL_TIMING: avenues green from 0 to 26 s of the 60 s cycle, red from 30; streets the other way)
  const greenFrom = avenue ? 0 : 30;
  const cycleAtStop = light === 'red' ? greenFrom - (seconds - 2) : greenFrom;
  const t0 = tr.frames[at].t;
  for (const f of tr.frames) f.sig = 600 + cycleAtStop + (f.t - t0);
}

// The ideal trace with one break applied (a fresh copy each time)
function brokenTrace(brk, layout = '45th') {
  const tr = brk.base === 'handoff' ? handoffTrace(layout) : idealTrace(layout);
  brk.apply(tr);
  tr.label = `synthetic (${layout} St layout): ${brk.name}`;
  return tr;
}

export { BREAKS, IDEAL_RADIUS, LAYOUTS, brokenTrace, handoffTrace, idealTrace, wrapAngle };
