// The checker: a run's per-frame trace (or a player session read as one, lib/session.mjs) turned into a verdict per
// beat of musa's checklist (eval-loop BRIEF.md, items 1-8), with the numbers it measured. Verdicts:
//   VERIFIED       every criterion measured and met;
//   NOT VERIFIED   a criterion measured and missed (the numbers say which);
//   INCONCLUSIVE   the beat was reached but could not be measured (too short, no data for it); not a pass;
//   N/A            the beat is not part of this scenario (an injected mid-donut start has no roll).
// Where the car is comes from the game's own map (lib/map.mjs): road, pavement, plaza, building.
import { COP, DRIFT_RADIUS, MPH, boxClearance, groundSpeed, kasaFit, travelHeading, wrapAngle } from './geometry.mjs';
import { avenueX, streetZ } from '../../../js/city-config.js';

const RAD = Math.PI / 180;
const VERIFIED = 'VERIFIED';
const NOT_VERIFIED = 'NOT VERIFIED';
const INCONCLUSIVE = 'INCONCLUSIVE';
const NA = 'N/A';

// Every threshold, with what it reads as. Changing one is a change to the spec: say so in the log.
const T = {
  startHeadingToCop: 30 * RAD, // 1: the car points at the cop to within this at P
  startAlongAvenue: 20 * RAD, // 1: ...and along 7th Ave's one-way direction (south, heading 0) to within this
  rollMaxMph: 12, // 2: never faster than this before the launch
  rollMinTime: 3, // 2: s of roll at least ("~4 s")
  rollMaxTime: 6, // 2: s of roll at most
  burnoutSpin: 0.5, // 2: wheelspin share (drift-physics.js, 0-1) that is a burnout...
  burnoutTime: 0.2, // 2: ...held this long in total
  floorWindow: 0.5, // 3: s after the launch over which W must be down...
  floorShare: 0.9, // 3: ...for at least this share of the time
  floorThrottle: 0.95, // 3: within floorGainWindow the keyboard driver's throttle reaches this (its traction control
  // holds a W with the wheel turned back to what the tires take; a run trace logs it),
  floorSpin: 0.5, // 3: or the rears spin up this far (drift-physics.js wheelspin, 0-1)
  floorGainWindow: 1.5, // 3: s after the launch within which...
  floorSpeedGain: 2, // 3: ...the speed over the ground rises this much (m/s), or the slide starts
  floorSlide: 20 * RAD, // 3: (the slide: the donut driver's own slideAngle)
  donutLaps: 2, // 4: laps round the cop at least
  donutCentre: 2, // 4: m between the fitted circle's centre and the cop at most
  donutRadiusMin: 8, // 4: m, the fitted circle's radius
  donutRadiusMax: 12,
  donutSlipMin: 30 * RAD, // 4: the median drift angle on the circle
  donutSlipMax: 50 * RAD,
  donutFitRms: 1.5, // 4: m RMS off the fitted circle at most: a circle, not an ellipse (good runs 0.4-0.8, musa's clock 1.5)
  donutNear: 7, // 4: m, the 10th percentile of the distance to the cop at least ("~8-12 m out")
  donutFar: 13, // 4: m, the 90th percentile at most
  donutGiveUp: 35, // 5: s of donuts with no way out that is stuck in them (swim-show.js gives up at 30)
  exitMph: 50, // 5: mph reached...
  exitTime: 3.5, // 5: ...within this many s of powering out ("~3 s")
  exitOnAvenueHeading: 30 * RAD, // 5: at that moment travelling down 7th Ave (south) to within this
  swimMph: 70, // 6: mph reached on 7th Ave
  swimSplits: 1, // 6: splits scored over the run at least
  swimCloseCalls: 1, // 6: close calls scored over the run at least
  cornerTurn: 45 * RAD, // 7: a route corner this sharp is a drift corner
  cornerReach: 25, // m: the car passing within this of a corner has driven it
  cornerWindow: 30, // m round the corner whose frames are the corner's
  cornerSlip: 15 * RAD, // 7: a corner is drifted if the drift angle reaches this in it
  roamMinTime: 30, // 8: s of roam needed to judge it
  stoppedSpeed: 1, // 8: m/s under which the car is stopped
  stoppedShare: 0.1, // 8: share of the roam stopped at most
  stuckWindow: 10, // 8: s over which...
  stuckDistance: 5, // 8: ...the car moving less than this many m is stuck
  sessionCopContact: 0.02, // m of box clearance a session (no contact log) counts as touching the cop
  sessionLapSlack: 0.2 // laps a session's read-back way out may over-count (measured on a run's own recording: 0.18)
};

const ESCAPE_END = { x: avenueX('9'), z: streetZ(57) - 3.5 }; // swim-show.js ESCAPE_ROUTE's last corner
const CORNER_42ND = { x: avenueX('7'), z: streetZ(42) - 5.5 }; // ...and its first (into 42nd St)
const SEVENTH_AVE = '7th Ave';

// What the car must never be over: the kerb and everything past it. Street furniture on the road (a steam stack, the
// subway stairs: road-network.js keeps traffic off it) is counted on its own, as musa's list doesn't name it.
const KERB = new Set(['pavement', 'plaza', 'median', 'park', 'building']);

const mph = (v) => v * MPH;
const fmt = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(d));
const deg = (r) => r / RAD;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Seconds covered by frames
const span = (frames) => frames.reduce((s, f) => s + f.dt, 0);

function criterion(name, value, pass, want, unit = '') {
  return { name, value, pass, want, unit };
}

function beatResult(id, title, verdict, criteria, summary, extra = {}) {
  return { id, title, verdict, criteria, summary, ...extra };
}

function verdictOf(criteria) {
  if (criteria.some((c) => c.pass === null)) return criteria.some((c) => c.pass === false) ? NOT_VERIFIED : INCONCLUSIVE;
  return criteria.every((c) => c.pass) ? VERIFIED : NOT_VERIFIED;
}

function summaryOf(criteria) {
  return criteria.map((c) => `${c.pass === false ? '✗ ' : c.pass === null ? '? ' : ''}${c.name} ${c.value}${c.unit}`).join(' · ');
}

// Everything the beats read per frame: ground speed, where on the map the centre and the footprint are, the lane
function annotate(trace, map) {
  const cop = trace.cop ?? COP;
  for (const f of trace.frames) {
    f.g = groundSpeed(f);
    f.travel = travelHeading(f);
    f.where = map.classify(f.x, f.z);
    f.foot = map.footprint(f.x, f.z, f.h);
    f.off = f.foot.some((c) => KERB.has(c));
    f.furniture = f.foot.includes('obstacle');
    f.dCop = Math.hypot(f.x - cop.x, f.z - cop.z);
    if (f.copGap === undefined || (f.copGap === null && f.cx !== null && f.cx !== undefined)) {
      const me = { x: f.x, z: f.z, sin: Math.sin(f.h), cos: Math.cos(f.h), hw: 0.97, hl: 2.52 };
      const ch = f.ch ?? -Math.PI / 2;
      f.copGap = f.cx === null || f.cx === undefined ? null
        : boxClearance(me, { x: f.cx, z: f.cz, sin: Math.sin(ch), cos: Math.cos(ch), hw: 1.0, hl: 2.4 });
    }
  }
}

function offRoadSummary(frames) {
  const counts = {};
  // (frames per thing under the car: a frame over plaza and pavement both counts once for each)
  for (const f of frames) if (f.off) for (const c of new Set(f.foot)) if (KERB.has(c)) counts[c] = (counts[c] ?? 0) + 1;
  return Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ');
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Start on the road, in a 7th Ave lane heading toward the cop (not on the plaza or pavement)
function beatStart(ctx) {
  const { trace, map, roll } = ctx;
  if (ctx.injected) return beatResult(1, 'Start on the road', NA, [], 'the scenario starts mid-donut (injected state)');
  const f = trace.frames[0];
  const cop = trace.cop ?? COP;
  const street = map.street(f.x, f.z);
  const lane = map.lane(f.x, f.z);
  const toCop = Math.atan2(cop.x - f.x, cop.z - f.z);
  const offCop = Math.abs(wrapAngle(f.h - toCop));
  const offAvenue = Math.abs(wrapAngle(f.h - 0));
  const rollOff = roll.filter((q) => q.off);
  const criteria = [
    criterion('centre on', f.where, f.where === 'road', 'road'),
    criterion('footprint on', [...new Set(f.foot)].join('+'), !f.off, 'road only'),
    criterion('street', street ? `${street.name} (${fmt(street.dist)} m off its centreline)` : 'none', !!street && street.name === SEVENTH_AVE && street.dist <= street.width / 2, `${SEVENTH_AVE}, inside its carriageway`),
    criterion('in a lane of the road graph', lane ? `edge ${lane.edge}, ${fmt(lane.offLane)} m off lane ${fmt(lane.lane)}` : 'no', !!lane, 'yes'),
    criterion('heading off the line to the cop', fmt(deg(offCop), 0), offCop <= T.startHeadingToCop, `≤ ${Math.round(deg(T.startHeadingToCop))}`, '°'),
    criterion('heading off 7th Ave southbound', fmt(deg(offAvenue), 0), offAvenue <= T.startAlongAvenue, `≤ ${Math.round(deg(T.startAlongAvenue))}`, '°'),
    criterion('roll frames off the road', `${rollOff.length}/${roll.length}${rollOff.length ? ` (${offRoadSummary(rollOff)})` : ''}`, rollOff.length === 0, '0')
  ];
  const failures = [];
  if (f.off || f.where !== 'road') failures.push({ t: f.t, label: `start on ${f.where}`, beat: 1 });
  if (rollOff.length) failures.push({ t: rollOff[0].t, label: `roll on ${rollOff[0].foot.find((c) => KERB.has(c))}`, beat: 1 });
  return beatResult(1, 'Start on the road', verdictOf(criteria), criteria, summaryOf(criteria), { failures, at: { x: f.x, z: f.z } });
}

// 2. Slow roll under 12 mph for ~4 s, no burnout
function beatRoll(ctx) {
  const { roll } = ctx;
  if (ctx.injected) return beatResult(2, 'Slow roll', NA, [], 'the scenario starts mid-donut (injected state)');
  if (!roll.length) return beatResult(2, 'Slow roll', NOT_VERIFIED, [criterion('roll', 'none', false, '~4 s')], 'no roll: the show never rolled');
  const time = span(roll);
  const top = Math.max(...roll.map((f) => mph(f.g)));
  const spinTime = roll.filter((f) => f.spin >= T.burnoutSpin).reduce((s, f) => s + f.dt, 0);
  const both = roll.filter((f) => f.k.includes('W') && f.k.includes('S')).length;
  const criteria = [
    criterion('roll time', `${fmt(time)}${ctx.trace.meta?.launchUncertain ? ' (its end read back uncertainly)' : ''}`, ctx.trace.meta?.launchUncertain ? null : time >= T.rollMinTime && time <= T.rollMaxTime, `${T.rollMinTime}-${T.rollMaxTime}`, ' s'),
    criterion('top speed', fmt(top, 2), top < T.rollMaxMph, `< ${T.rollMaxMph}`, ' mph'),
    criterion('wheelspin ≥ 0.5', fmt(spinTime, 2), spinTime < T.burnoutTime, `< ${T.burnoutTime}`, ' s'),
    criterion('W+S frames', String(both), both === 0, '0')
  ];
  const failures = [];
  const fast = roll.find((f) => mph(f.g) >= T.rollMaxMph);
  if (fast) failures.push({ t: fast.t, label: `roll at ${fmt(mph(fast.g), 0)} mph`, beat: 2 });
  return beatResult(2, 'Slow roll', verdictOf(criteria), criteria, summaryOf(criteria), { failures });
}

// 3. Floor it
function beatFloor(ctx) {
  const { trace, launchIndex } = ctx;
  if (ctx.injected) return beatResult(3, 'Floor it', NA, [], 'the scenario starts mid-donut (injected state)');
  // (a session's launch is read back from the driving: not finding it there, or finding it only by the fallback rule,
  // says nothing sure about the show)
  if ((launchIndex < 0 || trace.meta?.launchUncertain) && trace.source === 'session') return beatResult(3, 'Floor it', INCONCLUSIVE, [criterion('launch', launchIndex < 0 ? 'not found in the driving' : 'read back uncertainly (a W held on from the roll)', null, 'one')], 'no sure launch read back from the session');
  if (launchIndex < 0) return beatResult(3, 'Floor it', NOT_VERIFIED, [criterion('launch', 'none', false, 'one')], 'it never launched');
  const frames = trace.frames;
  const l = frames[launchIndex];
  const within = (window) => frames.slice(launchIndex).filter((f) => f.t - l.t < window);
  const first = within(T.floorWindow);
  const wShare = first.filter((f) => f.k.includes('W')).reduce((s, f) => s + f.dt, 0) / Math.max(1e-6, span(first));
  const gainFrames = within(T.floorGainWindow);
  const gain = Math.max(...gainFrames.map((f) => f.g)) - l.g;
  const slid = gainFrames.some((f) => Math.abs(f.slip) >= T.floorSlide);
  const throttle = gainFrames.some((f) => f.thr !== null && f.thr !== undefined) ? Math.max(...gainFrames.map((f) => f.thr ?? 0)) : null;
  const spin = Math.max(...gainFrames.map((f) => f.spin ?? 0));
  const floored = (throttle !== null && throttle >= T.floorThrottle) || spin >= T.floorSpin;
  const criteria = [
    criterion('W down in the first 0.5 s', fmt(wShare * 100, 0), wShare >= T.floorShare, `≥ ${T.floorShare * 100}`, '%'),
    criterion('in 1.5 s: throttle / wheelspin', `${throttle === null ? 'not logged' : fmt(throttle, 2)} / ${fmt(spin, 2)}`, floored, `≥ ${T.floorThrottle} / ≥ ${T.floorSpin}`),
    criterion('speed gain in 1.5 s', `${fmt(gain)} m/s${slid ? ' (slide started)' : ''}`, gain >= T.floorSpeedGain || slid, `≥ ${T.floorSpeedGain} m/s or the slide`)
  ];
  return beatResult(3, 'Floor it', verdictOf(criteria), criteria, summaryOf(criteria), { failures: [], at: { x: l.x, z: l.z, t: l.t } });
}

// 4. Donuts around the cop: >= 2 laps, circle centred within ~2 m of the cop, ~8-12 m out, sideways 30-50°, never
//    touching the cop, kerb or pavement
function beatDonuts(ctx) {
  const { trace, donut } = ctx;
  if (!donut.length) {
    const never = ctx.launchIndex < 0 && !ctx.injected && trace.source !== 'session';
    return beatResult(4, 'Donuts round the cop', never ? NOT_VERIFIED : INCONCLUSIVE, [criterion('donut frames', '0', never ? false : null, '> 0')], 'no donut frames');
  }
  const cop = trace.cop ?? COP;
  let sweep = 0;
  let last = null;
  // (swept from where the car was as it launched, the frame before the first donut frame, to the frame it starts
  // powering out on: the donut driver counts the same stretch, and decides on that last frame that it has its laps)
  const startIndex = trace.frames.indexOf(donut[0]);
  const endIndex = trace.frames.indexOf(donut[donut.length - 1]);
  const swept = trace.frames.slice(Math.max(0, startIndex - 1), Math.min(trace.frames.length, endIndex + 2));
  // (an injected start sweeps from where the injection put the car: the first frame is logged after it has moved)
  if (startIndex === 0 && trace.meta?.injectedAt) swept.unshift(trace.meta.injectedAt);
  // (and the measurement's resolution, one frame's sweep: the trace logs a frame after its physics, the donut driver
  // reads its bearing before, so the two counts of the same laps differ by up to that much either way)
  // (the typical frame's: the median, so a gap in the trace can't widen it)
  const steps = [];
  for (const f of swept) {
    const a = Math.atan2(f.x - cop.x, f.z - cop.z);
    if (last !== null) {
      const d = wrapAngle(a - last);
      sweep += d;
      steps.push(Math.abs(d));
    }
    last = a;
  }
  const before = trace.meta?.lapsBefore ?? 0;
  const laps = Math.abs(sweep) / (2 * Math.PI) + before;
  const lapResolution = (median(steps) ?? 0) / (2 * Math.PI);
  // (the donut driver's own counter at the same frame: a run trace logs it)
  const showLaps = swept[swept.length - 1].laps ?? donut[donut.length - 1].laps ?? null;
  // (a session doesn't log the show's phases: its way out is read back from where the car leaves the circle, which on
  // a run's own recording comes up to ~0.2 laps after the donut driver powers out, so a session needs that much more)
  const readBack = trace.source === 'session';
  // The circle and the angle over every frame of the drift (from the slide's start to the way out), gripping ones too:
  // a donut that grips most of the way round is no donut (Codex round 1: filtering to the sideways frames let 90 %
  // gripping pass), and its fit must be a circle, not just have a centre and a radius (an ellipse has both)
  const drifting = donut.filter((f) => f.dp !== 'launch' && f.dp !== 'kick');
  const sliding = drifting.length >= 3 ? drifting : donut;
  const fit = kasaFit(sliding.map((f) => [f.x, f.z]));
  const offset = fit ? Math.hypot(fit.cx - cop.x, fit.cz - cop.z) : null;
  const rms = fit ? Math.sqrt(sliding.reduce((s, f) => s + (Math.hypot(f.x - fit.cx, f.z - fit.cz) - fit.r) ** 2, 0) / sliding.length) : null;
  const out = sliding.map((f) => f.dCop).sort((a, b) => a - b);
  const near = out[Math.floor(0.1 * (out.length - 1))], far = out[Math.floor(0.9 * (out.length - 1))];
  const slip = median(sliding.map((f) => Math.abs(f.slip)));
  const copHits = donut.filter((f) => (f.copHit ?? 0) > 0 || (trace.source === 'session' && f.copGap !== null && f.copGap < T.sessionCopContact));
  const minGap = Math.min(...donut.map((f) => f.copGap ?? Infinity));
  const off = donut.filter((f) => f.off);
  const buildings = donut.filter((f) => (f.bHit ?? 0) > 0);
  const time = span(donut);
  const criteria = [
    // (a session's count inside its read-back band, 2 to 2.2, can't tell a pass from a fail: INCONCLUSIVE, Codex round 2)
    criterion('laps round the cop', `${fmt(laps, 3)} ±${fmt(lapResolution, 3)} (one frame)${before ? ` (incl. ${fmt(before, 2)} before the injection)` : ''}${showLaps === null ? '' : `; the show's own count ${fmt(showLaps, 3)}`}${readBack ? ` (way out read back from the driving: up to ${T.sessionLapSlack} too many)` : ''}`,
      laps + lapResolution < T.donutLaps ? false : readBack && laps < T.donutLaps + T.sessionLapSlack ? null : true, `≥ ${T.donutLaps}${readBack ? ` (a session: ≥ ${T.donutLaps + T.sessionLapSlack} to pass, between: inconclusive)` : ''}`),
    criterion('circle centre off the cop', fmt(offset), offset === null ? null : offset <= T.donutCentre, `≤ ${T.donutCentre}`, ' m'),
    criterion('circle radius', fmt(fit?.r), fit ? fit.r >= T.donutRadiusMin && fit.r <= T.donutRadiusMax : null, `${T.donutRadiusMin}-${T.donutRadiusMax}`, ' m'),
    criterion('off the fitted circle (RMS)', fmt(rms, 2), rms === null ? null : rms <= T.donutFitRms, `≤ ${T.donutFitRms}`, ' m'),
    criterion('distance from the cop, 10th-90th percentile', `${fmt(near)}-${fmt(far)}`, near >= T.donutNear && far <= T.donutFar, `${T.donutNear}-${T.donutFar}`, ' m'),
    criterion('median drift angle', fmt(slip === null ? null : deg(slip), 0), slip === null ? null : slip >= T.donutSlipMin && slip <= T.donutSlipMax, `${Math.round(deg(T.donutSlipMin))}-${Math.round(deg(T.donutSlipMax))}`, '°'),
    criterion('cop contacts', `${copHits.length} frames (closest ${fmt(minGap, 2)} m)`, copHits.length === 0, '0'),
    criterion('frames on kerb/pavement/plaza', `${off.length}/${donut.length}${off.length ? ` (${offRoadSummary(off)})` : ''}`, off.length === 0, '0'),
    criterion('building pushes', String(buildings.length), trace.source === 'session' ? null : buildings.length === 0, '0'),
    criterion('frames over street furniture (steam stack)', `${donut.filter((f) => f.furniture).length}/${donut.length}`, true, 'measured')
  ];
  // (a session has no building log: that criterion is unknown there, not failed)
  if (trace.source === 'session') criteria.splice(criteria.findIndex((c) => c.name === 'building pushes'), 1);
  const failures = [];
  if (copHits.length) failures.push({ t: copHits[0].t, label: 'touches the cop', beat: 4 });
  if (off.length) failures.push({ t: off[0].t, label: `donut over the ${off[0].foot.find((c) => KERB.has(c))}`, beat: 4 });
  if (laps < T.donutLaps) failures.push({ t: donut[donut.length - 1].t, label: `donuts end at ${fmt(laps, 2)} laps`, beat: 4 });
  // The worst moment of the circle: furthest off the radius
  const worst = donut.reduce((m, f) => (Math.abs(f.dCop - DRIFT_RADIUS) > Math.abs(m.dCop - DRIFT_RADIUS) ? f : m), donut[0]);
  if (offset !== null && offset > T.donutCentre) failures.push({ t: worst.t, label: `circle ${fmt(worst.dCop)} m from the cop`, beat: 4 });
  return beatResult(4, 'Donuts round the cop', verdictOf(criteria), criteria, summaryOf(criteria), {
    failures, fit, laps, time, sliding: sliding.length
  });
}

// 5. Drift out onto 7th Ave; 50 mph within ~3 s
function beatExit(ctx) {
  const { trace, exitIndex, map } = ctx;
  if (exitIndex < 0) {
    // Past the show's own fallback (DONUT_TIME_LIMIT, 30 s, then it powers out wherever it is) with no way out: stuck in
    // the donuts. Shorter, the trace just ended first.
    const time = span(ctx.donut);
    const stuck = time > T.donutGiveUp;
    return beatResult(5, 'Drift out onto 7th Ave', stuck ? NOT_VERIFIED : INCONCLUSIVE, [criterion('way out', `none after ${fmt(time)} s of donuts`, stuck ? false : null, `within ${T.donutGiveUp} s`)], stuck ? 'the donuts never ended' : `not reached: the trace ends ${fmt(time)} s into the donuts`);
  }
  const frames = trace.frames;
  const e = frames[exitIndex];
  let reached = null;
  for (let i = exitIndex; i < frames.length && frames[i].t - e.t <= 10; i++) {
    if (mph(frames[i].g) >= T.exitMph) {
      reached = frames[i];
      break;
    }
  }
  const time = reached ? reached.t - e.t : null;
  const at = reached ?? frames.find((f) => f.t - e.t >= T.exitTime) ?? frames[frames.length - 1];
  const street = map.street(at.x, at.z);
  const offSouth = Math.abs(wrapAngle(at.travel - 0));
  const startSlip = Math.max(...frames.slice(exitIndex).filter((f) => f.t - e.t < 0.5).map((f) => Math.abs(f.slip)));
  const criteria = [
    // (a session's way out is read back late, ~1.5 s after the powering out begins: timed from it, the beat would pass
    // too easily, so a session only shows the number)
    criterion('time to 50 mph', `${reached ? fmt(time, 2) : `not within 10 s (top ${fmt(Math.max(...frames.slice(exitIndex).filter((f) => f.t - e.t <= 10).map((f) => mph(f.g))), 0)} mph)`}${trace.source === 'session' ? ' from where it left the circle (a session doesn\'t log the powering out)' : ''}`,
      trace.source === 'session' ? null : reached ? time <= T.exitTime : false, `≤ ${T.exitTime}`, reached ? ' s' : ''),
    criterion('street then', street ? street.name : 'none', !!street && street.name === SEVENTH_AVE && at.where === 'road', `${SEVENTH_AVE}, on the road`),
    criterion('travel off southbound', fmt(deg(offSouth), 0), offSouth <= T.exitOnAvenueHeading, `≤ ${Math.round(deg(T.exitOnAvenueHeading))}`, '°'),
    // (a number shown, not a gate: the car powers out of a slide by construction)
    criterion('drift angle powering out', fmt(deg(startSlip), 0), true, 'measured', '°')
  ];
  // The way out is the donuts' and the run's both and neither (Codex round 1): its own contacts and kerbs, from the
  // powering out to the 50 mph moment (or the time limit)
  const way = frames.slice(exitIndex, frames.indexOf(at) + 1);
  const wayOff = way.filter((f) => f.off);
  const session = trace.source === 'session';
  const hits = way.filter((f) => (f.copHit ?? 0) > 0 || (f.bHit ?? 0) > 0 || (f.tHit ?? 0) > 0);
  criteria.push(
    criterion('frames on kerb/pavement/plaza', `${wayOff.length}/${way.length}${wayOff.length ? ` (${offRoadSummary(wayOff)})` : ''}`, wayOff.length === 0, '0'),
    criterion('contacts (cop, building, traffic)', session ? 'not logged' : `${hits.length} frames`, session ? null : hits.length === 0, '0')
  );
  const failures = [];
  if (!reached || time > T.exitTime) failures.push({ t: e.t + T.exitTime, label: `${fmt(mph(at.g), 0)} mph ${T.exitTime} s after the way out`, beat: 5 });
  if (wayOff.length) failures.push({ t: wayOff[0].t, label: `way out over the ${wayOff[0].foot.find((c) => KERB.has(c))}`, beat: 5 });
  if (hits.length) failures.push({ t: hits[0].t, label: 'contact on the way out', beat: 5 });
  return beatResult(5, 'Drift out onto 7th Ave', verdictOf(criteria), criteria, summaryOf(criteria), { failures, at: { x: e.x, z: e.z, t: e.t } });
}

// 6. Swim on 7th Ave above 70 mph with splits and close calls, no contacts
function beatSwim(ctx) {
  const { trace, run, map } = ctx;
  if (!run.length) return beatResult(6, 'Swim 7th Ave > 70 mph', INCONCLUSIVE, [criterion('run frames', '0', null, '> 0')], 'not reached');
  const corner = run.findIndex((f) => Math.hypot(f.x - CORNER_42ND.x, f.z - CORNER_42ND.z) < T.cornerReach);
  const seventh = (corner >= 0 ? run.slice(0, corner) : run).filter((f) => map.street(f.x, f.z)?.name === SEVENTH_AVE);
  const top7 = seventh.length ? Math.max(...seventh.map((f) => mph(f.g))) : null;
  const t0 = run[0].t, t1 = run[run.length - 1].t;
  const inRun = (e) => e.t >= t0 && e.t <= t1;
  const splits = trace.events.filter((e) => e.kind === 'split' && inRun(e));
  const closes = trace.events.filter((e) => e.kind === 'close' && inRun(e));
  const traffic = trace.events.filter((e) => e.kind === 'contact-traffic' && inRun(e));
  const buildings = run.filter((f) => (f.bHit ?? 0) > 0);
  const cop = run.filter((f) => (f.copHit ?? 0) > 0);
  const session = trace.source === 'session';
  const top = Math.max(...run.map((f) => mph(f.g)));
  const criteria = [
    criterion('top speed on 7th Ave', `${fmt(top7, 0)} (whole run ${fmt(top, 0)})`, top7 === null ? null : top7 >= T.swimMph, `≥ ${T.swimMph}`, ' mph'),
    criterion('splits', session ? 'not logged' : String(splits.length), session ? null : splits.length >= T.swimSplits, `≥ ${T.swimSplits}`),
    criterion('close calls', session ? 'not logged' : String(closes.length), session ? null : closes.length >= T.swimCloseCalls, `≥ ${T.swimCloseCalls}`),
    criterion('traffic contacts', session ? 'not logged' : String(traffic.length), session ? null : traffic.length === 0, '0'),
    criterion('building pushes (frames)', session ? 'not logged' : String(buildings.length), session ? null : buildings.length === 0, '0'),
    criterion('cop contacts (frames)', session ? 'not logged' : String(cop.length), session ? null : cop.length === 0, '0')
  ];
  const failures = [];
  for (const e of traffic.slice(0, 6)) failures.push({ t: e.t, label: `hits traffic at ${e.mph} mph`, beat: 6 });
  if (buildings.length) failures.push({ t: buildings[0].t, label: 'hits a building', beat: 6 });
  return beatResult(6, 'Swim 7th Ave > 70 mph', verdictOf(criteria), criteria, summaryOf(criteria), {
    failures, counts: { splits: splits.length, closes: closes.length, traffic: traffic.length }, run: [t0, t1]
  });
}

// The route's corners (from the path the AI drives, as the trace logs it), or turns read off the car's heading
function cornersOf(ctx) {
  const { trace, after } = ctx;
  const seen = new Map();
  for (const e of trace.events) {
    if (e.kind !== 'path' || e.t < after - 0.5) continue;
    const pts = e.points;
    for (let i = 1; i < pts.length - 1; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i], [cx, cz] = pts[i + 1];
      const turn = wrapAngle(Math.atan2(cx - bx, cz - bz) - Math.atan2(bx - ax, bz - az));
      const key = `${Math.round(bx)},${Math.round(bz)}`;
      if (Math.abs(turn) >= T.cornerTurn && !seen.has(key)) seen.set(key, { x: bx, z: bz, turn });
    }
  }
  if (seen.size || trace.source !== 'session') return [...seen.values()];
  // A session: turns of the travel heading over 60 m of road
  const frames = ctx.run.concat(ctx.roam);
  const corners = [];
  let i = 0;
  while (i < frames.length) {
    let j = i, dist = 0;
    while (j + 1 < frames.length && dist < 60) {
      dist += Math.hypot(frames[j + 1].x - frames[j].x, frames[j + 1].z - frames[j].z);
      j++;
    }
    const turn = wrapAngle(frames[j].travel - frames[i].travel);
    if (Math.abs(turn) >= 60 * RAD && frames[i].g > 5) {
      const mid = frames[Math.floor((i + j) / 2)];
      corners.push({ x: mid.x, z: mid.z, turn });
      i = j;
    } else {
      i++;
    }
  }
  return corners;
}

// 7. Corners drifted, on the road
function beatCorners(ctx) {
  const { trace } = ctx;
  const frames = ctx.run.concat(ctx.roam);
  if (!frames.length) return beatResult(7, 'Corners drifted, on the road', INCONCLUSIVE, [criterion('run frames', '0', null, '> 0')], 'not reached');
  const corners = cornersOf(ctx);
  const driven = [];
  for (const c of corners) {
    const near = frames.filter((f) => Math.hypot(f.x - c.x, f.z - c.z) < T.cornerWindow);
    if (!near.length || Math.min(...near.map((f) => Math.hypot(f.x - c.x, f.z - c.z))) > T.cornerReach) continue;
    const slip = Math.max(...near.map((f) => Math.abs(f.slip)));
    const off = near.filter((f) => f.off);
    const hits = near.filter((f) => (f.bHit ?? 0) > 0 || (f.tHit ?? 0) > 0);
    driven.push({ ...c, slip, off: off.length, frames: near.length, hits: hits.length, t: near[0].t, offWhat: offRoadSummary(off), firstOff: off[0]?.t });
  }
  if (!driven.length) return beatResult(7, 'Corners drifted, on the road', INCONCLUSIVE, [criterion('corners driven', '0', null, '≥ 1')], 'no corner reached');
  const undrifted = driven.filter((c) => c.slip < T.cornerSlip);
  const offRoad = driven.filter((c) => c.off > 0);
  const hit = driven.filter((c) => c.hits > 0);
  const criteria = [
    criterion('corners driven', String(driven.length), true, '≥ 1'),
    criterion('drifted (≥ 15°)', `${driven.length - undrifted.length}/${driven.length}`, undrifted.length === 0, 'all'),
    criterion('on the road throughout', `${driven.length - offRoad.length}/${driven.length}${offRoad.length ? ` (${offRoad.map((c) => c.offWhat).join('; ')})` : ''}`, offRoad.length === 0, 'all'),
    criterion('without contacts', trace.source === 'session' ? 'not logged' : `${driven.length - hit.length}/${driven.length}`, trace.source === 'session' ? null : hit.length === 0, 'all')
  ];
  const failures = [];
  for (const c of offRoad.slice(0, 4)) failures.push({ t: c.firstOff, label: `corner (${fmt(c.x, 0)}, ${fmt(c.z, 0)}) over the ${c.offWhat.split(' ')[0]}`, beat: 7 });
  for (const c of undrifted.slice(0, 3)) failures.push({ t: c.t, label: `corner (${fmt(c.x, 0)}, ${fmt(c.z, 0)}) gripped (${fmt(deg(c.slip), 0)}°)`, beat: 7 });
  return beatResult(7, 'Corners drifted, on the road', verdictOf(criteria), criteria, summaryOf(criteria), { failures, corners: driven });
}

// 8. Endless roam: stopped < 10% of the time, never stuck. Judged over all the AI's driving after the donuts (the
//    scripted run is the roam's first legs, as the car drives them: on 89419cc it never got past 8th Ave in 165 s,
//    queued at red lights for half a minute, which a roam-only window would never have seen); the roam proper, past
//    the run's last corner, is shown on its own.
function beatRoam(ctx) {
  const roam = ctx.run.concat(ctx.roam);
  const time = span(roam);
  const proper = span(ctx.roam);
  if (time < T.roamMinTime) {
    return beatResult(8, 'Endless roam', INCONCLUSIVE, [criterion('driving after the donuts', fmt(time), null, `≥ ${T.roamMinTime}`, ' s')], `only ${fmt(time)} s of driving after the donuts (needs ${T.roamMinTime})`);
  }
  const stopped = roam.filter((f) => f.g < T.stoppedSpeed).reduce((s, f) => s + f.dt, 0);
  // Stuck: any stuckWindow over which the car got less than stuckDistance from where it was
  let stuck = null;
  let j = 0;
  for (let i = 0; i < roam.length; i++) {
    while (j < roam.length && roam[j].t - roam[i].t < T.stuckWindow) j++;
    if (j >= roam.length) break;
    let far = 0;
    for (let k = i; k <= j; k++) far = Math.max(far, Math.hypot(roam[k].x - roam[i].x, roam[k].z - roam[i].z));
    if (far < T.stuckDistance) {
      stuck = roam[i];
      break;
    }
  }
  const reversing = roam.filter((f) => f.rev).reduce((s, f) => s + f.dt, 0);
  const off = ctx.trace.frames[ctx.trace.frames.length - 1].phase === 'off';
  // (and the roam proper on its own: good driving earlier must not dilute stopping in it, and the beat isn't
  // VERIFIED until the roam has been seen at all, Codex round 1)
  const properStopped = ctx.roam.filter((f) => f.g < T.stoppedSpeed).reduce((s, f) => s + f.dt, 0);
  const criteria = [
    criterion('driving after the donuts', fmt(time), true, `≥ ${T.roamMinTime}`, ' s'),
    criterion('the roam proper (past the run\'s last corner)', fmt(proper), proper >= T.roamMinTime ? true : null, `≥ ${T.roamMinTime}`, ' s'),
    criterion('stopped, all after the donuts', `${fmt((stopped / time) * 100, 0)}% (${fmt(stopped)} s)`, stopped / time < T.stoppedShare, `< ${T.stoppedShare * 100}%`),
    criterion('stopped, the roam proper', proper > 0 ? `${fmt((properStopped / proper) * 100, 0)}%` : 'no roam', proper > 0 ? properStopped / proper < T.stoppedShare : null, `< ${T.stoppedShare * 100}%`),
    criterion('stuck (10 s inside 5 m)', stuck ? `at t ${fmt(stuck.t)} (${fmt(stuck.x, 0)}, ${fmt(stuck.z, 0)})` : 'never', !stuck, 'never'),
    criterion('the AI still driving at the end', off ? 'no: the show gave the car back' : 'yes', !off, 'yes'),
    criterion('backing out', `${fmt(reversing)} s`, true, 'measured')
  ];
  const failures = [];
  if (stuck) failures.push({ t: stuck.t + T.stuckWindow / 2, label: 'stuck', beat: 8 });
  return beatResult(8, 'Endless roam', verdictOf(criteria), criteria, summaryOf(criteria), { failures, time, stoppedShare: stopped / time });
}

// The beat windows of a trace: its roll, launch, donuts, way out, the scripted run and the roam after it
function windows(trace) {
  const frames = trace.frames;
  const injected = !!trace.meta?.injected;
  const roll = frames.filter((f) => f.phase === 'roll');
  const launchIndex = frames.findIndex((f) => f.phase === 'donuts');
  const donut = frames.filter((f) => f.phase === 'donuts' && f.dp !== 'powerOut');
  let exitIndex = frames.findIndex((f) => f.phase === 'donuts' && f.dp === 'powerOut');
  if (exitIndex < 0) exitIndex = frames.findIndex((f) => f.phase === 'escape');
  const escapeIndex = frames.findIndex((f) => f.phase === 'escape' || f.phase === 'swim' || f.phase === 'roam');
  const after = escapeIndex >= 0 ? frames.slice(escapeIndex) : [];
  // The scripted run ends at its last corner (57th St & 9th Ave); a session's run is all of what follows the donuts
  let end = after.findIndex((f) => Math.hypot(f.x - ESCAPE_END.x, f.z - ESCAPE_END.z) < T.cornerReach);
  if (after[0]?.phase === 'roam') end = 0;
  const run = end >= 0 ? after.slice(0, end) : after;
  const roam = end >= 0 ? after.slice(end) : [];
  return { injected, roll, launchIndex, donut, exitIndex, run, roam, after: escapeIndex >= 0 ? frames[escapeIndex].t : Infinity };
}

function checkTrace(trace, map) {
  annotate(trace, map);
  const ctx = { trace, map, ...windows(trace) };
  const beats = [beatStart, beatRoll, beatFloor, beatDonuts, beatExit, beatSwim, beatCorners, beatRoam].map((beat) => beat(ctx));
  const failures = beats.flatMap((b) => b.failures ?? []).sort((a, b) => a.t - b.t);
  const contacts = {
    cop: trace.frames.filter((f) => (f.copHit ?? 0) > 0).length,
    building: trace.frames.filter((f) => (f.bHit ?? 0) > 0).length,
    traffic: trace.events.filter((e) => e.kind === 'contact-traffic').length
  };
  const duration = span(trace.frames);
  return {
    label: trace.label, source: trace.source, meta: trace.meta, cop: trace.cop ?? COP, duration, frames: trace.frames.length,
    beats, failures, contacts,
    windows: {
      roll: ctx.roll.length ? [ctx.roll[0].t, ctx.roll[ctx.roll.length - 1].t] : null,
      donut: ctx.donut.length ? [ctx.donut[0].t, ctx.donut[ctx.donut.length - 1].t] : null,
      run: ctx.run.length ? [ctx.run[0].t, ctx.run[ctx.run.length - 1].t] : null,
      roam: ctx.roam.length ? [ctx.roam[0].t, ctx.roam[ctx.roam.length - 1].t] : null
    }
  };
}

// The beat each frame belongs to (for colouring the path)
function beatOfFrame(f, result) {
  const w = result.windows;
  const inside = (win) => win && f.t >= win[0] && f.t <= win[1];
  if (f.phase === 'roll') return 2;
  if (f.phase === 'donuts' && f.dp === 'powerOut') return 5;
  if (f.phase === 'donuts') return f.dp === 'launch' ? 3 : 4;
  if (inside(w.roam)) return 8;
  if (inside(w.run)) return 6;
  return 0;
}

export { INCONCLUSIVE, NA, NOT_VERIFIED, T as THRESHOLDS, VERIFIED, beatOfFrame, checkTrace };
