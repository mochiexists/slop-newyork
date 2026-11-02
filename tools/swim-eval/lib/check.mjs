// The checker: a run's per-frame trace (or a player session read as one, lib/session.mjs) turned into a verdict per
// beat of musa's checklist (eval-loop BRIEF.md, items 1-8), with the numbers it measured. Verdicts:
//   VERIFIED       every criterion measured and met;
//   NOT VERIFIED   a criterion measured and missed (the numbers say which);
//   INCONCLUSIVE   the beat was reached but could not be measured (too short, no data for it); not a pass;
//   N/A            the beat is not part of this scenario (an injected mid-donut start has no roll).
// Where the car is comes from the game's own map (lib/map.mjs): road, pavement, plaza, building. Where the show puts
// its cop and its run comes from the trace (the page's own COP_SPOT and ESCAPE_ROUTE), else from geometry.mjs.
import { COP, DRIFT_RADIUS, ESCAPE_ROUTE, MPH, boxClearance, groundSpeed, kasaFit, travelHeading, wrapAngle } from './geometry.mjs';
import { CARRIAGEWAY_SLACK } from './map.mjs';
import { ALL_AVENUES, ALL_STREETS, SIGNAL_TIMING, signalPhase } from '../../../js/city-config.js';

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
  birdUp: 0.9, // 4: the driver's hand this far up (m5-cockpit.js birdAmount, 0-1) is the bird out of the window...
  birdTime: 1, // 4: ...shown, the arms drawn, this many s of the donuts at least (2026-11-03, Codex #11; the show holds
  // it from 1.15 to 1.85 laps, ~6 s)
  donutGiveUp: 35, // 5: s of donuts with no way out that is stuck in them (swim-show.js gives up at 30)
  exitMph: 50, // 5: mph reached...
  exitTime: 3.5, // 5: ...within this many s of powering out ("~3 s")
  exitOnAvenueHeading: 30 * RAD, // 5: at that moment travelling down 7th Ave (south) to within this
  swimMph: 70, // 6: mph on 7th Ave...
  swimHold: 1, // 6: ...held unbroken this many s at least (2026-11-03, Codex #8: one frame over 70 passed; at 70 mph
  // that is 31 m of the 7th Ave stretch, which runs 240 m from 45th to 42nd St and ~650 m from 42nd to 34th)
  swimSplits: 1, // 6: splits scored on the 7th Ave stretch at least (2026-11-03: the stretch's, not the run's)
  swimCloseCalls: 1, // 6: close calls scored on the 7th Ave stretch at least
  cornerTurn: 45 * RAD, // 7: a route corner this sharp is a drift corner
  cornerReach: 25, // m: the car passing within this of a corner has driven it
  cornerWindow: 30, // m round the corner whose frames are the corner's
  cornerSlip: 15 * RAD, // 7: the drift angle that is sideways...
  // ...and a corner is drifted only if the turn completes (cornerExitAlign) and one unbroken spell that sideways lasts
  // cornerDriftTime and covers cornerDriftShare of the distance the car's travel turns over (2026-11-03, Codex #9: one
  // 16.7 ms slip spike made a gripped corner "drifted"). Calibrated on musa's own driving: REPORT.md, fixes/harness.
  cornerDriftTime: 0.5, // s
  cornerDriftShare: 0.5,
  cornerTurnFrom: 0.1, // the turning distance: from where the travel has turned this share of the corner's turn...
  cornerTurnTo: 0.9, // ...to where it has turned this share
  cornerExitAlign: 45 * RAD, // 7: leaving the corner's window travelling this close to the way out, and...
  cornerExitPast: 15, // ...this many m down the way out from the corner: the turn completed
  turnMinSpeed: 2, // m/s: slower, the direction of travel is too noisy to read a turn from
  roamMinTime: 30, // 8: s of roam needed to judge it
  stoppedSpeed: 1, // 8: m/s under which the car is stopped
  stoppedShare: 0.1, // 8: share of the roam stopped at most
  stuckWindow: 10, // 8: s over which...
  stuckDistance: 5, // 8: ...the car moving less than this many m is stuck, unless it is waiting at a red light:
  queueDischarge: 10, // 8: s into its green that a car may still stand (the queue ahead getting going); standing longer,
  // or with no signal clock logged, or not along an avenue or a street, it is stuck (2026-11-03, Codex: a red light's
  // wait was called stuck; the < 10 % stopped gate still bounds every wait)
  axisAlign: 30 * RAD, // 8: heading this close to an avenue's or a street's line reads as on it
  stopLineReach: 20, // 8: m short of the next crossing ahead that a car waits at its light...
  queueShare: 0.5, // 8: ...or this share of the stop in a queue the AI's planner sees (drift-autopilot.js queued)
  // (Codex round 1: a stall mid-block during a red was called a wait)
  handbackStart: 0.5, // 9: m between the car and the first point of the route the AI takes on with at I (logged to 0.1 m)
  handbackJump: 0.05, // 9: m the car may move across the I press beyond what its speed carries it (no teleport)
  handbackWindow: 10, // 9: s after I over which...
  handbackDistance: 20, // 9: ...the AI drives the car on this many m at least, never giving it back
  sessionCopContact: 0.02, // m of box clearance a session (no contact log) counts as touching the cop
  sessionLapSlack: 0.2 // laps a session's read-back way out may over-count (measured on a run's own recording: 0.18)
};

const SEVENTH_AVE = '7th Ave';

// The show's run (swim-show.js ESCAPE_ROUTE, as the trace carries it): its last point, where the roam takes over, and
// its first corner, where the 7th Ave stretch ends (the first point it turns at: 42nd St up to e7f9c83)
function routeOf(trace) {
  const route = trace.route ?? ESCAPE_ROUTE;
  let first = route.length - 1;
  for (let i = 1; i < route.length - 1; i++) {
    const a = route[i - 1], b = route[i], c = route[i + 1];
    if (Math.abs(wrapAngle(Math.atan2(c.x - b.x, c.z - b.z) - Math.atan2(b.x - a.x, b.z - a.z))) >= T.cornerTurn) {
      first = i;
      break;
    }
  }
  return { route, end: route[route.length - 1], firstCorner: route[first] };
}

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

// Contacts with traffic between t0 and t1: every contact traffic.js accepted, logged before it pushed the cars apart
// and whatever the speed (touch-traffic, the probe's hook: Codex 2026-11-03 #10, a grazing sideswipe escaped both of
// the others), the boxes overlapping at a record (any speed), or the game's own impact report (over 0.5 m/s). One
// contact per touch: one within CONTACT_MERGE s of another is the same one.
const CONTACT_MERGE = 0.5; // s
const TRAFFIC_CONTACT = new Set(['touch-traffic', 'contact-traffic', 'impact-traffic']);
function trafficContacts(trace, t0, t1) {
  const all = trace.events.filter((e) => TRAFFIC_CONTACT.has(e.kind) && e.t >= t0 && e.t <= t1)
    .sort((a, b) => a.t - b.t);
  const contacts = [];
  for (const e of all) {
    const last = contacts[contacts.length - 1];
    if (last && e.t - last.lastT <= CONTACT_MERGE) {
      last.lastT = e.t;
      continue;
    }
    contacts.push({ ...e, mph: e.mph ?? Math.round((e.speed ?? 0) * MPH), lastT: e.t });
  }
  return contacts;
}

function streetLabel(street) {
  if (!street) return 'none';
  return `${street.name} (${fmt(street.dist)} m off its centreline)`;
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
  // (7th Ave among the roads there, not just the nearest: a start at a crossing has the cross street as near)
  const street = map.street(f.x, f.z);
  const seventh = map.onStreet(f.x, f.z, SEVENTH_AVE);
  const lane = map.lane(f.x, f.z);
  const toCop = Math.atan2(cop.x - f.x, cop.z - f.z);
  const offCop = Math.abs(wrapAngle(f.h - toCop));
  const offAvenue = Math.abs(wrapAngle(f.h - 0));
  const rollOff = roll.filter((q) => q.off);
  const criteria = [
    criterion('centre on', f.where, f.where === 'road', 'road'),
    criterion('footprint on', [...new Set(f.foot)].join('+'), !f.off, 'road only'),
    criterion('street', streetLabel(seventh ? { name: SEVENTH_AVE, ...seventh } : street), !!seventh, `${SEVENTH_AVE}, inside its carriageway`),
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
    criterion('frames over street furniture (steam stack)', `${donut.filter((f) => f.furniture).length}/${donut.length}`, true, 'measured'),
    birdCriterion(donut)
  ];
  // (a session has no building log nor the cockpit's: those criteria are unknown there, not failed)
  if (trace.source === 'session') {
    for (const name of ['building pushes', BIRD]) criteria.splice(criteria.findIndex((c) => c.name === name), 1);
  }
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

// The bird over the donuts: the s the hand is up and the arms are drawn (a trace from before the probe logged the
// cockpit can't say: unknown)
const BIRD = 'the bird shown (hand up, arms drawn)';
function birdCriterion(donut) {
  if (!donut.some((f) => f.bird !== undefined && f.bird !== null)) return criterion(BIRD, 'not logged', null, `≥ ${T.birdTime}`, ' s');
  const time = donut.filter((f) => f.bird >= T.birdUp && f.birdSeen).reduce((sum, f) => sum + f.dt, 0);
  const peak = Math.max(...donut.map((f) => f.bird ?? 0));
  return criterion(BIRD, `${fmt(time, 2)}${time ? '' : ` (highest ${fmt(peak, 2)})`}`, time >= T.birdTime, `≥ ${T.birdTime}`, ' s');
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
  const seventh = map.onStreet(at.x, at.z, SEVENTH_AVE, CARRIAGEWAY_SLACK);
  const street = seventh ? { name: SEVENTH_AVE } : map.street(at.x, at.z);
  const offSouth = Math.abs(wrapAngle(at.travel - 0));
  // (where the way out ends, beat 6's 7th Ave stretch starts: every frame from the powering out to the first corner is
  // judged once)
  ctx.wayEnd = at.t;
  const startSlip = Math.max(...frames.slice(exitIndex).filter((f) => f.t - e.t < 0.5).map((f) => Math.abs(f.slip)));
  const criteria = [
    // (a session's way out is read back late, ~1.5 s after the powering out begins: timed from it, the beat would pass
    // too easily, so a session only shows the number)
    criterion('time to 50 mph', `${reached ? fmt(time, 2) : `not within 10 s (top ${fmt(Math.max(...frames.slice(exitIndex).filter((f) => f.t - e.t <= 10).map((f) => mph(f.g))), 0)} mph)`}${trace.source === 'session' ? ' from where it left the circle (a session doesn\'t log the powering out)' : ''}`,
      trace.source === 'session' ? null : reached ? time <= T.exitTime : false, `≤ ${T.exitTime}`, reached ? ' s' : ''),
    criterion('street then', street ? street.name : 'none', !!seventh && at.where === 'road', `${SEVENTH_AVE}, on the road`),
    criterion('travel off southbound', fmt(deg(offSouth), 0), offSouth <= T.exitOnAvenueHeading, `≤ ${Math.round(deg(T.exitOnAvenueHeading))}`, '°'),
    // (a number shown, not a gate: the car powers out of a slide by construction)
    criterion('drift angle powering out', fmt(deg(startSlip), 0), true, 'measured', '°')
  ];
  // The way out is the donuts' and the run's both and neither (Codex round 1): its own contacts and kerbs, from the
  // powering out to the 50 mph moment (or the time limit)
  const way = frames.slice(exitIndex, frames.indexOf(at) + 1);
  const wayOff = way.filter((f) => f.off);
  const session = trace.source === 'session';
  const hits = way.filter((f) => (f.copHit ?? 0) > 0 || (f.bHit ?? 0) > 0)
    .concat(way.length ? trafficContacts(trace, way[0].t, way[way.length - 1].t) : []);
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

// The frames beat 6 judges: from the frame after the way out ends (beat 5's last) to the end of the run, whatever the
// show's phase (Codex round 1: a way out reaching 50 mph before the show's escape phase left the frames between in
// neither beat)
function swimFrames(ctx) {
  const end = ctx.run.length ? ctx.run[ctx.run.length - 1].t : -Infinity;
  const from = ctx.wayEnd ?? (ctx.run.length ? ctx.run[0].t - ctx.run[0].dt : Infinity);
  return ctx.trace.frames.filter((f) => f.t > from && f.t <= end);
}

// The run's 7th Ave stretch: those frames up to the route's first corner (before the car comes within cornerReach of
// it). Fixed by the route, not by where the car is, so a detour off 7th Ave is in it and counts against it (Codex #8:
// a window of "frames on 7th Ave" let a detour over the plaza drop out of the beat).
function seventhAveStretch(ctx, frames) {
  const { firstCorner } = ctx;
  const reach = frames.findIndex((f) => Math.hypot(f.x - firstCorner.x, f.z - firstCorner.z) < T.cornerReach);
  return { frames: reach >= 0 ? frames.slice(0, reach) : frames, reachedCorner: reach >= 0 };
}

// The longest unbroken spell of frames meeting `test`: its s and its first frame
function longestSpell(frames, test) {
  let best = { time: 0, from: null }, time = 0, from = null;
  for (const f of frames) {
    if (!test(f)) {
      time = 0;
      from = null;
      continue;
    }
    from ??= f;
    time += f.dt;
    if (time > best.time) best = { time, from };
  }
  return best;
}

// 6. Swim on 7th Ave above 70 mph with splits and close calls, no contacts. Speed, passes and the kerb are all judged
//    on one window, the 7th Ave stretch (Codex #8: splits scored on 8th Ave and a run detouring over the plaza passed)
function beatSwim(ctx) {
  const { trace, map } = ctx;
  const run = swimFrames(ctx);
  if (!ctx.run.length || !run.length) return beatResult(6, 'Swim 7th Ave > 70 mph', INCONCLUSIVE, [criterion('run frames', '0', null, '> 0')], 'not reached');
  const session = trace.source === 'session';
  const t0 = run[0].t - run[0].dt, t1 = run[run.length - 1].t;
  const traffic = trafficContacts(trace, t0, t1);
  const buildings = run.filter((f) => (f.bHit ?? 0) > 0);
  const cop = run.filter((f) => (f.copHit ?? 0) > 0);
  const contactCriteria = [
    criterion('traffic contacts', session ? 'not logged' : String(traffic.length), session ? null : traffic.length === 0, '0'),
    criterion('building pushes (frames)', session ? 'not logged' : String(buildings.length), session ? null : buildings.length === 0, '0'),
    criterion('cop contacts (frames)', session ? 'not logged' : String(cop.length), session ? null : cop.length === 0, '0')
  ];
  const failures = [];
  for (const e of traffic.slice(0, 6)) failures.push({ t: e.t, label: `hits traffic at ${e.mph} mph`, beat: 6 });
  if (buildings.length) failures.push({ t: buildings[0].t, label: 'hits a building', beat: 6 });
  if (cop.length) failures.push({ t: cop[0].t, label: 'touches the cop', beat: 6 });
  const { frames: stretch, reachedCorner } = seventhAveStretch(ctx, run);
  if (!stretch.length) {
    // (the corner came before the way out had ended: no 7th Ave left to swim; or the trace ended first)
    const criteria = [criterion('the 7th Ave stretch', reachedCorner ? 'none: the first corner came before the way out ended' : 'not reached', reachedCorner ? false : null, 'the way out to the first corner'), ...contactCriteria];
    return beatResult(6, 'Swim 7th Ave > 70 mph', verdictOf(criteria), criteria, summaryOf(criteria), { failures, run: [t0, t1] });
  }
  const s0 = stretch[0].t - stretch[0].dt, s1 = stretch[stretch.length - 1].t;
  const on7th = (x, z) => !!map.onStreet(x, z, SEVENTH_AVE, CARRIAGEWAY_SLACK);
  const astray = stretch.filter((f) => f.off || !on7th(f.x, f.z));
  const offAve = astray.filter((f) => !on7th(f.x, f.z)).length;
  const length = stretch.reduce((s, f, i) => (i ? s + Math.hypot(f.x - stretch[i - 1].x, f.z - stretch[i - 1].z) : s), 0);
  const held = longestSpell(stretch, (f) => mph(f.g) >= T.swimMph);
  const top7 = Math.max(...stretch.map((f) => mph(f.g)));
  const top = Math.max(...run.map((f) => mph(f.g)));
  // Passes on the stretch: in its time and on 7th Ave where they were scored
  const passes = (kind) => trace.events.filter((e) => e.kind === kind && e.t >= t0 && e.t <= t1);
  const onStretch = (e) => e.t >= s0 && e.t <= s1 && on7th(e.x, e.z);
  const splitsAll = passes('split'), closesAll = passes('close');
  const splits = splitsAll.filter(onStretch), closes = closesAll.filter(onStretch);
  const elsewhere = (all, here) => (all.length > here.length ? ` (${all.length - here.length} more elsewhere in the run)` : '');
  const criteria = [
    criterion('the 7th Ave stretch (way out to the first corner)', `${fmt(s1 - s0)} s, ${fmt(length, 0)} m`, true, 'measured'),
    criterion('frames off 7th Ave or over the kerb on it', `${astray.length}/${stretch.length}${astray.length ? ` (${[offAve ? `off 7th Ave ${offAve}` : '', offRoadSummary(astray)].filter(Boolean).join(', ')})` : ''}`, astray.length === 0, '0'),
    criterion(`held ≥ ${T.swimMph} mph unbroken on 7th Ave`, fmt(held.time, 2), held.time >= T.swimHold, `≥ ${T.swimHold}`, ' s'),
    criterion('top speed on 7th Ave', `${fmt(top7, 0)} (whole run ${fmt(top, 0)})`, true, 'measured', ' mph'),
    criterion('splits on 7th Ave', session ? 'not logged' : `${splits.length}${elsewhere(splitsAll, splits)}`, session ? null : splits.length >= T.swimSplits, `≥ ${T.swimSplits}`),
    criterion('close calls on 7th Ave', session ? 'not logged' : `${closes.length}${elsewhere(closesAll, closes)}`, session ? null : closes.length >= T.swimCloseCalls, `≥ ${T.swimCloseCalls}`),
    ...contactCriteria
  ];
  if (astray.length) failures.push({ t: astray[0].t, label: `7th Ave stretch ${on7th(astray[0].x, astray[0].z) ? `over the ${astray[0].foot.find((c) => KERB.has(c))}` : 'off 7th Ave'}`, beat: 6 });
  if (held.time < T.swimHold) {
    const fastest = stretch.reduce((m, f) => (f.g > m.g ? f : m), stretch[0]);
    // (a shortfall over the whole stretch, not a moment's event: a takeover that cuts the stretch short doesn't keep it)
    failures.push({ t: fastest.t, label: `7th Ave top ${fmt(mph(fastest.g), 0)} mph, held ${fmt(held.time, 2)} s`, beat: 6, overall: true });
  }
  return beatResult(6, 'Swim 7th Ave > 70 mph', verdictOf(criteria), criteria, summaryOf(criteria), {
    failures, counts: { splits: splits.length, closes: closes.length, traffic: traffic.length }, run: [t0, t1], stretch: [s0, s1], held: held.time
  });
}

// The route's corners (from the path the AI drives, as the trace logs it), or turns read off the car's heading
function cornersOf(ctx) {
  const { trace, after } = ctx;
  const seen = new Map();
  const paths = trace.events.filter((e) => e.kind === 'path').sort((a, b) => a.t - b.t);
  paths.forEach((e, n) => {
    if (e.t < after - 0.5) return;
    const pts = e.points;
    // (while this path was the AI's: until the next one replaced it)
    const until = n + 1 < paths.length ? paths[n + 1].t : Infinity;
    for (let i = 1; i < pts.length - 1; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i], [cx, cz] = pts[i + 1];
      const turn = wrapAngle(Math.atan2(cx - bx, cz - bz) - Math.atan2(bx - ax, bz - az));
      const key = `${Math.round(bx)},${Math.round(bz)}`;
      const inH = Math.atan2(bx - ax, bz - az), outH = Math.atan2(cx - bx, cz - bz);
      if (Math.abs(turn) < T.cornerTurn) continue;
      if (!seen.has(key)) seen.set(key, { x: bx, z: bz, turn, inH, outH, beyond: [] });
      // (the route past it, as each path had it from when it was set, sampled along its legs from cornerWindow past
      // the corner: driving any of that without the corner is driving past the corner, Codex rounds 1 and 2)
      seen.get(key).beyond.push({ t: e.t, until, points: routeBeyond([bx, bz], pts.slice(i + 1)) });
    }
  });
  if (seen.size || trace.source !== 'session') return [...seen.values()];
  return turnsOf(ctx.run.concat(ctx.roam));
}

// Points every BEYOND_STEP m along the legs from `corner` through `rest`, from cornerWindow m past the corner on
const BEYOND_STEP = 5; // m
function routeBeyond(corner, rest) {
  const out = [];
  let along = 0;
  let from = corner;
  for (const to of rest) {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    for (let d = 0; d < length; d += BEYOND_STEP) {
      if (along + d >= T.cornerWindow) out.push([from[0] + ((to[0] - from[0]) * d) / length, from[1] + ((to[1] - from[1]) * d) / length]);
    }
    along += length;
    from = to;
  }
  if (along >= T.cornerWindow) out.push(from);
  return out;
}

// Turns read off the car's direction of travel over 60 m of road (a session, which has no route): where each is, and
// the headings in and out
function turnsOf(frames) {
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
      corners.push({ x: mid.x, z: mid.z, turn, inH: frames[i].travel, outH: frames[j].travel });
      i = j;
    } else {
      i++;
    }
  }
  return corners;
}

// The car's first pass through corner c: the frames from coming within cornerWindow of it to leaving, if it got
// within cornerReach; `left` false when the frames end inside the window (the trace ended mid-corner)
function cornerPass(frames, c) {
  const d = (f) => Math.hypot(f.x - c.x, f.z - c.z);
  const closest = frames.findIndex((f) => d(f) < T.cornerReach);
  if (closest < 0) return null;
  let a = closest, b = closest;
  while (a > 0 && d(frames[a - 1]) < T.cornerWindow) a--;
  while (b < frames.length - 1 && d(frames[b + 1]) < T.cornerWindow) b++;
  return { frames: frames.slice(a, b + 1), left: b < frames.length - 1 };
}

// How a pass drives corner c (headings inH → outH): whether the turn completed, the distance the car's travel turned
// over (cornerTurnFrom to cornerTurnTo of the corner's turn), and the unbroken spell at ≥ cornerSlip that covers most
// of it: its s and the share of the turning distance it covers. Exported for the calibration on player sessions.
function cornerDrift(pass, c) {
  const frames = pass.frames;
  const turn = wrapAngle(c.outH - c.inH);
  // (the share of the corner's turn the travel has made, held over frames too slow to read it from)
  let progress = 0;
  const shares = frames.map((f) => {
    if (f.g >= T.turnMinSpeed) progress = wrapAngle(f.travel - c.inH) / turn;
    return progress;
  });
  const from = shares.findIndex((s) => s >= T.cornerTurnFrom);
  const to = shares.findIndex((s) => s >= T.cornerTurnTo);
  const last = frames[frames.length - 1];
  const past = (last.x - c.x) * Math.sin(c.outH) + (last.z - c.z) * Math.cos(c.outH);
  const completed = pass.left && to >= 0 && past >= T.cornerExitPast && Math.abs(wrapAngle(last.travel - c.outH)) <= T.cornerExitAlign;
  // The turning stretch and its length
  const stepLength = (i) => (i > 0 ? Math.hypot(frames[i].x - frames[i - 1].x, frames[i].z - frames[i - 1].z) : 0);
  const turning = from >= 0 && to >= from ? [from, to] : null;
  let turnLength = 0;
  if (turning) for (let i = turning[0] + 1; i <= turning[1]; i++) turnLength += stepLength(i);
  // Every unbroken sideways spell: its time and how much of the turning stretch it covers
  let best = { time: 0, covered: 0, peak: 0 };
  let spell = null;
  const close = () => {
    if (spell && (spell.covered > best.covered || (spell.covered === best.covered && spell.time > best.time))) best = spell;
    spell = null;
  };
  frames.forEach((f, i) => {
    if (Math.abs(f.slip) < T.cornerSlip) return close();
    spell ??= { time: 0, covered: 0, peak: 0, t: f.t };
    spell.time += f.dt;
    spell.peak = Math.max(spell.peak, Math.abs(f.slip));
    if (turning && i > turning[0] && i <= turning[1] && Math.abs(frames[i - 1].slip) >= T.cornerSlip) spell.covered += stepLength(i);
  });
  close();
  const share = turnLength > 0 ? best.covered / turnLength : 0;
  const peak = Math.max(...frames.map((f) => Math.abs(f.slip)));
  const drifted = completed && best.time >= T.cornerDriftTime && share >= T.cornerDriftShare;
  return { completed, turnLength, spell: best.time, share, peak, drifted, spellAt: best.t ?? frames[0].t };
}

// 7. Corners drifted, on the road
function beatCorners(ctx) {
  const { trace } = ctx;
  const frames = ctx.run.concat(ctx.roam);
  if (!frames.length) return beatResult(7, 'Corners drifted, on the road', INCONCLUSIVE, [criterion('run frames', '0', null, '> 0')], 'not reached');
  const corners = cornersOf(ctx);
  const driven = [];
  const missed = [];
  let unfinished = 0;
  for (const c of corners) {
    const pass = cornerPass(frames, c);
    if (!pass) {
      // A corner never come within cornerReach of, though the car went on to the route beyond it: missed (cut wide
      // or skipped), not "not reached"
      const past = (c.beyond ?? []).some((b) => frames.some((f) => f.t >= b.t && f.t < b.until && b.points.some(([x, z]) => Math.hypot(f.x - x, f.z - z) < T.cornerReach)));
      if (past) missed.push(c);
      continue;
    }
    // (the trace ending inside the corner's window: not driven yet, so not judged)
    if (!pass.left) {
      unfinished++;
      continue;
    }
    const near = pass.frames;
    const drift = cornerDrift(pass, c);
    const off = near.filter((f) => f.off);
    const hits = near.filter((f) => (f.bHit ?? 0) > 0);
    const touches = trafficContacts(trace, near[0].t, near[near.length - 1].t).filter((e) => Math.hypot(e.x - c.x, e.z - c.z) < T.cornerWindow);
    driven.push({ ...c, ...drift, slip: drift.peak, off: off.length, frames: near.length, hits: hits.length + touches.length, t: near[0].t, offWhat: offRoadSummary(off), firstOff: off[0]?.t });
  }
  const missedCriterion = criterion(`corners missed (never within ${T.cornerReach} m, the route beyond them driven)`, missed.length ? `${missed.length}: ${missed.map((c) => `(${fmt(c.x, 0)}, ${fmt(c.z, 0)})`).join(', ')}` : '0', missed.length === 0, '0');
  if (!driven.length) {
    const criteria = [criterion('corners driven', unfinished ? `0 (${unfinished} the trace ends in)` : '0', null, '≥ 1'), missedCriterion];
    return beatResult(7, 'Corners drifted, on the road', verdictOf(criteria), criteria, 'no corner driven');
  }
  const incomplete = driven.filter((c) => !c.completed);
  const undrifted = driven.filter((c) => !c.drifted);
  const offRoad = driven.filter((c) => c.off > 0);
  const hit = driven.filter((c) => c.hits > 0);
  const shortest = driven.reduce((m, c) => (c.spell < m.spell ? c : m), driven[0]);
  const thinnest = driven.reduce((m, c) => (c.share < m.share ? c : m), driven[0]);
  const criteria = [
    criterion('corners driven', `${driven.length}${unfinished ? ` (and ${unfinished} the trace ends in)` : ''}`, true, '≥ 1'),
    missedCriterion,
    criterion('turns completed', `${driven.length - incomplete.length}/${driven.length}`, incomplete.length === 0, 'all'),
    criterion(`drifted (one unbroken spell ≥ ${Math.round(deg(T.cornerSlip))}°, ≥ ${T.cornerDriftTime} s, ≥ ${T.cornerDriftShare * 100}% of the turn)`,
      `${driven.length - undrifted.length}/${driven.length} (shortest spell ${fmt(shortest.spell, 2)} s; least of the turn ${fmt(thinnest.share * 100, 0)}%)`, undrifted.length === 0, 'all'),
    criterion('on the road throughout', `${driven.length - offRoad.length}/${driven.length}${offRoad.length ? ` (${offRoad.map((c) => c.offWhat).join('; ')})` : ''}`, offRoad.length === 0, 'all'),
    criterion('without contacts', trace.source === 'session' ? 'not logged' : `${driven.length - hit.length}/${driven.length}`, trace.source === 'session' ? null : hit.length === 0, 'all')
  ];
  const failures = [];
  const at = (c) => `corner (${fmt(c.x, 0)}, ${fmt(c.z, 0)})`;
  for (const c of missed.slice(0, 3)) {
    const nearest = frames.reduce((m, f) => (Math.hypot(f.x - c.x, f.z - c.z) < Math.hypot(m.x - c.x, m.z - c.z) ? f : m), frames[0]);
    failures.push({ t: nearest.t, label: `${at(c)} missed (closest ${fmt(Math.hypot(nearest.x - c.x, nearest.z - c.z), 0)} m)`, beat: 7 });
  }
  for (const c of offRoad.slice(0, 4)) failures.push({ t: c.firstOff, label: `${at(c)} over the ${c.offWhat.split(' ')[0]}`, beat: 7 });
  for (const c of undrifted.slice(0, 3)) {
    const how = c.completed ? `gripped (spell ${fmt(c.spell, 2)} s, ${fmt(c.share * 100, 0)}% of the turn, peak ${fmt(deg(c.peak), 0)}°)` : 'turn not completed';
    failures.push({ t: c.spellAt, label: `${at(c)} ${how}`, beat: 7 });
  }
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
  // Stuck: a stuckWindow over which the car got less than stuckDistance from where it was, told apart from a wait at a
  // red light (a diagnosis: the stopped share is the gate on waiting)
  const spells = stuckSpells(roam);
  const deadlocks = spells.filter((q) => q.kind === 'deadlock');
  const waits = spells.filter((q) => q.kind === 'red light');
  const stuck = deadlocks[0] ?? null;
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
    criterion('stuck, not at a red light (10 s inside 5 m)', stuck ? `${deadlocks.length}×, first at t ${fmt(stuck.at.t)} (${fmt(stuck.at.x, 0)}, ${fmt(stuck.at.z, 0)}): ${stuck.why}` : 'never', !stuck, 'never'),
    criterion('waiting at a red light (10 s inside 5 m)', waits.length ? `${waits.length}× (${fmt(waits.reduce((sum, q) => sum + q.time, 0))} s; longest ${fmt(Math.max(...waits.map((q) => q.time)))} s)` : 'none', true, 'measured'),
    criterion('the AI still driving at the end', off ? 'no: the show gave the car back' : 'yes', !off, 'yes'),
    criterion('backing out', `${fmt(reversing)} s`, true, 'measured')
  ];
  const failures = [];
  for (const q of deadlocks.slice(0, 3)) failures.push({ t: q.at.t + T.stuckWindow / 2, label: `stuck (${q.why})`, beat: 8 });
  return beatResult(8, 'Endless roam', verdictOf(criteria), criteria, summaryOf(criteria), { failures, time, stoppedShare: stopped / time });
}

// Every stuck spell of the roam: a stuckWindow inside stuckDistance, grown to the whole stop (the frames within
// stuckDistance of where it began), each diagnosed
function stuckSpells(roam) {
  const spells = [];
  const near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) < T.stuckDistance;
  let j = 0;
  for (let i = 0; i < roam.length; i++) {
    while (j < roam.length && roam[j].t - roam[i].t < T.stuckWindow) j++;
    if (j >= roam.length) break;
    let inside = true;
    for (let k = i; k <= j && inside; k++) inside = near(roam[k], roam[i]);
    if (!inside) continue;
    let a = i, b = j;
    while (a > 0 && near(roam[a - 1], roam[i])) a--;
    while (b < roam.length - 1 && near(roam[b + 1], roam[i])) b++;
    const stop = roam.slice(a, b + 1);
    spells.push({ at: roam[i], time: span(stop), ...diagnoseStop(stop) });
    i = b;
    j = Math.max(j, b);
  }
  return spells;
}

// A stop is a wait at a red light if the car stood along an avenue or a street and its light was red or amber the
// whole time, but for the first queueDischarge s of a green (the queue ahead moving off); anything else is stuck
function diagnoseStop(stop) {
  if (stop.some((f) => f.sig === undefined || f.sig === null)) return { kind: 'deadlock', why: 'no signal clock logged to tell a red light' };
  const h = stop[Math.floor(stop.length / 2)].h;
  const alongAvenue = Math.abs(Math.cos(h)) >= Math.cos(T.axisAlign);
  const alongStreet = Math.abs(Math.sin(h)) >= Math.cos(T.axisAlign);
  if (!alongAvenue && !alongStreet) return { kind: 'deadlock', why: 'standing across the grid, not at a light' };
  const greenFrom = alongAvenue ? 0 : SIGNAL_TIMING.avenueRed; // s into the cycle its green starts
  let worst = 0;
  for (const f of stop) {
    if (signalPhase(f.sig, alongAvenue) !== 'green') continue;
    const intoGreen = ((((f.sig - greenFrom) % SIGNAL_TIMING.cycle) + SIGNAL_TIMING.cycle) % SIGNAL_TIMING.cycle);
    worst = Math.max(worst, intoGreen);
  }
  const axis = alongAvenue ? 'an avenue' : 'a street';
  if (worst > T.queueDischarge) return { kind: 'deadlock', why: `standing ${fmt(worst, 0)} s into its green on ${axis}` };
  // ...and at the light: near the next crossing ahead, or in a queue for it
  const f = stop[Math.floor(stop.length / 2)];
  const toCrossing = crossingAhead(f.x, f.z, h, alongAvenue);
  const queued = stop.filter((q) => q.queued).length / stop.length;
  if (toCrossing > T.stopLineReach && queued < T.queueShare) return { kind: 'deadlock', why: `standing ${fmt(toCrossing, 0)} m short of the next crossing, not in a queue, on ${axis}` };
  return { kind: 'red light', why: `waiting at ${axis}'s red light` };
}

// 9. Any driving key takes over; I hands back (2026-11-03, Codex #11). Judged where the scenario presses them (the
//    trace's input events, logged the moment each lands, between two ticks): the first tick after a driving key must
//    be the player's (the show off, the car getting exactly the player's keys), and every tick after it until I; the
//    first after I must be the AI's, on a route from where the car is, with no jump, and the AI must drive on.
const DRIVING_KEYS = { KeyW: 'W', ArrowUp: 'W', KeyS: 'S', ArrowDown: 'S', KeyA: 'A', ArrowLeft: 'A', KeyD: 'D', ArrowRight: 'D', Space: 'H', KeyE: 'H' };
function beatHandoff(ctx) {
  const { trace } = ctx;
  const inputs = trace.events.filter((e) => e.kind === 'input' && e.action !== 'up');
  const take = inputs.find((e) => DRIVING_KEYS[e.key]);
  const back = inputs.find((e) => e.key === 'KeyI' && (!take || e.t > take.t));
  if (!take && !back) return beatResult(9, 'Takeover and hand-back', NA, [], 'no key pressed mid-show in this scenario');
  const frames = trace.frames;
  const criteria = [];
  const failures = [];
  const keysOf = (f) => `car "${f.k}", player "${f.pk ?? '?'}"`;
  if (take) {
    const i = frames.findIndex((f) => f.t > take.t);
    if (i < 0) {
      criteria.push(criterion('the player\'s key wins at once', 'the trace ends first', null, 'the first tick after it'));
    } else {
      const first = frames[i];
      const until = back ? back.t : Infinity;
      const after = frames.slice(i).filter((f) => f.t <= until);
      const wins = first.phase === 'off' && !first.pilot && first.k === first.pk && first.pk.includes(DRIVING_KEYS[take.key]);
      criteria.push(criterion(`the player's key (${take.key}) wins at once`, `the first tick after it: show ${first.phase}, ${keysOf(first)}`, wins, 'show off, the car gets the player\'s keys'));
      const driving = after.filter((f) => f.phase !== 'off' || f.pilot || f.k !== f.pk);
      criteria.push(criterion(`the AI lets go (ticks it still drove, to ${back ? 'I' : 'the end'})`, `${driving.length}/${after.length}`, driving.length === 0, '0'));
      if (!wins) failures.push({ t: first.t, label: `${take.key} didn't take the wheel (${keysOf(first)})`, beat: 9 });
      if (driving.length) failures.push({ t: driving[0].t, label: `the AI drove after the takeover (${keysOf(driving[0])})`, beat: 9 });
    }
  }
  if (back) {
    const i = frames.findIndex((f) => f.t > back.t);
    const before = i > 0 ? frames[i - 1] : null;
    if (i < 0 || !before) {
      criteria.push(criterion('I: the AI takes the wheel at once', 'the trace ends first', null, 'roam'));
    } else {
      const first = frames[i];
      criteria.push(criterion('I: the AI takes the wheel at once', `the first tick after it: show ${first.phase}`, first.phase === 'roam' && !!first.pilot, 'roam'));
      const path = trace.events.find((e) => e.kind === 'path' && e.t >= back.t);
      const start = path?.points?.[0];
      const startOff = start ? Math.hypot(start[0] - before.x, start[1] - before.z) : null;
      criteria.push(criterion('I: its route starts where the car is', startOff === null ? 'no new route' : fmt(startOff, 2), startOff !== null && startOff <= T.handbackStart, `≤ ${T.handbackStart}`, startOff === null ? '' : ' m'));
      const step = Math.hypot(first.x - before.x, first.z - before.z);
      const allowed = before.g * first.dt + T.handbackJump;
      criteria.push(criterion('I: no jump across it', fmt(step, 2), step <= allowed, `≤ ${fmt(allowed, 2)} (its speed's worth)`, ' m'));
      const window = frames.slice(i).filter((f) => f.t - back.t <= T.handbackWindow);
      const ended = frames[frames.length - 1].t - back.t < T.handbackWindow;
      const covered = window.reduce((sum, f, k) => (k ? sum + Math.hypot(f.x - window[k - 1].x, f.z - window[k - 1].z) : sum), 0);
      const gaveBack = window.find((f) => f.phase === 'off' || !f.pilot);
      let drivesOn = covered >= T.handbackDistance && !gaveBack;
      if (ended && drivesOn === false && !gaveBack) drivesOn = null;
      criteria.push(criterion(`I: the AI drives on (${T.handbackWindow} s)`, `${fmt(covered, 0)} m${gaveBack ? `, gave the car back at t ${fmt(gaveBack.t)}` : ''}${ended ? ' (the trace ends first)' : ''}`, drivesOn, `≥ ${T.handbackDistance} m, still driving`));
      if (first.phase !== 'roam' || !first.pilot || startOff === null || startOff > T.handbackStart || step > allowed) failures.push({ t: first.t, label: 'I: no clean hand-back', beat: 9 });
      if (drivesOn === false) failures.push({ t: (gaveBack ?? window[window.length - 1]).t, label: `I: the AI drove ${fmt(covered, 0)} m`, beat: 9 });
    }
  }
  return beatResult(9, 'Takeover and hand-back', verdictOf(criteria), criteria, summaryOf(criteria), { failures });
}

// m from (x, z) heading h to the near edge of the next cross street ahead (along an avenue) or the next avenue (along
// a street); 0 inside one
function crossingAhead(x, z, h, alongAvenue) {
  const dir = Math.sign(alongAvenue ? Math.cos(h) : Math.sin(h)) || 1;
  // (a road without a width in the city data counts as a line)
  const lines = (alongAvenue ? ALL_STREETS.map((q) => [q.z, q.width]) : ALL_AVENUES.map((q) => [q.x, q.width]))
    .filter(([c]) => Number.isFinite(c)).map(([c, width]) => [c, Number.isFinite(width) ? width : 0]);
  const at = alongAvenue ? z : x;
  let best = Infinity;
  for (const [c, width] of lines) {
    const ahead = dir * (c - at);
    if (ahead < -width / 2) continue;
    best = Math.min(best, Math.max(0, ahead - width / 2));
  }
  return best;
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
  // The scripted run ends at its route's last point (57th St & 9th Ave up to e7f9c83); a session's run is all of what
  // follows the donuts
  const { end: routeEnd, firstCorner } = routeOf(trace);
  let end = after.findIndex((f) => Math.hypot(f.x - routeEnd.x, f.z - routeEnd.z) < T.cornerReach);
  if (after[0]?.phase === 'roam') end = 0;
  const run = end >= 0 ? after.slice(0, end) : after;
  const roam = end >= 0 ? after.slice(end) : [];
  return { injected, roll, launchIndex, donut, exitIndex, run, roam, firstCorner, after: escapeIndex >= 0 ? frames[escapeIndex].t : Infinity };
}

function checkTrace(trace, map) {
  annotate(trace, map);
  const ctx = { trace, map, ...windows(trace) };
  const beats = [beatStart, beatRoll, beatFloor, beatDonuts, beatExit, beatSwim, beatCorners, beatRoam, beatHandoff].map((beat) => beat(ctx));
  // A scenario where the player takes the wheel cuts the show short: a beat it hadn't finished by then is not the
  // show's to pass or fail (beat 9 judges the takeover itself)
  const take = trace.events.find((e) => e.kind === 'input' && e.action !== 'up' && DRIVING_KEYS[e.key]);
  if (take) {
    const launch = ctx.launchIndex >= 0 ? trace.frames[ctx.launchIndex].t : Infinity;
    const exit = ctx.exitIndex >= 0 ? trace.frames[ctx.exitIndex].t : Infinity;
    const done = { 1: 0, 2: launch, 3: launch + T.floorGainWindow, 4: exit, 5: ctx.wayEnd ?? Infinity, 6: Infinity, 7: Infinity, 8: Infinity };
    for (const b of beats) {
      if (!(b.id in done) || done[b.id] < take.t || b.verdict === NA) continue;
      // (but what went wrong before the takeover stands: Codex round 1, a contact before it was wiped)
      const before = (b.failures ?? []).filter((f) => f.t < take.t && !f.overall);
      if (before.length) {
        Object.assign(b, { verdict: NOT_VERIFIED, failures: before, summary: `cut short by the player at t ${fmt(take.t)}, after failing: ${before.map((f) => f.label).join('; ')}` });
      } else {
        Object.assign(b, { verdict: NA, criteria: [], summary: `cut short: the player took the wheel at t ${fmt(take.t)} (${take.key})`, failures: [] });
      }
    }
  }
  const failures = beats.flatMap((b) => b.failures ?? []).sort((a, b) => a.t - b.t);
  const contacts = {
    cop: trace.frames.filter((f) => (f.copHit ?? 0) > 0).length,
    building: trace.frames.filter((f) => (f.bHit ?? 0) > 0).length,
    traffic: trafficContacts(trace, -Infinity, Infinity).length
  };
  const duration = span(trace.frames);
  return {
    label: trace.label, source: trace.source, meta: trace.meta, cop: trace.cop ?? COP, route: routeOf(trace).route, duration, frames: trace.frames.length,
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

export { INCONCLUSIVE, NA, NOT_VERIFIED, T as THRESHOLDS, VERIFIED, annotate, beatOfFrame, checkTrace, cornerDrift, cornerPass, turnsOf };
