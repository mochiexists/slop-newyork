// A player session from the game's flight recorder (js/session-recorder.js): chunks of frames in FIELDS order, each
// frame the state it started from, with keyboard-driver snapshots every 30 frames. Read here for three things: the
// offline score of a session (toTrace: the AI's part as a trace the checker reads), musa's frame times (the "musa"
// clock profile) and musa's over-rotated launch (the injected start state of the launch scenarios).
import { readFileSync } from 'node:fs';
import { COP, SHOW_SPOT, groundSpeed, wrapAngle } from './geometry.mjs';

const MUSA_SESSION = '/Users/timapple/Documents/mcc/fujira/scratch/2026-11-01/sessions/2026-11-01T15-34-47-424.jsonl';
// The frame of musa's AI show (2026-11-01, 15:34 session) where the launch has over-rotated: yaw 1.91 rad/s, slip
// -45° and growing past the donut driver's 58° limit within 0.2 s, speed falling 8.4 → 6.3 m/s on its way to 2.5. It is
// a keyframe of the recorder's, so the keyboard driver's own memory at that frame is in the file too. (The brief puts
// the launch "around t 860-862"; in the file's clock the show starts at t 859.4, rolls until 863.5 and over-rotates at
// 865.2-865.9.)
const MUSA_LAUNCH_FRAME = 10800;
const SHOW_START_RADIUS = 3; // m from SHOW_SPOT: an AI segment starting here is a P press (else the I key's roam)
const LAUNCH_MIN_SPEED = 3; // m/s: the first long W after the roll is the launch (the first, from rest, is the roll's)
const LAUNCH_HOLD = 0.4; // s of W held unbroken that reads as flooring it (the roll's feathered W is shorter)
const EXIT_DISTANCE = 16; // m from the cop: off the donut circle
const EXIT_RADIAL = 2; // m/s away from the cop
const SLIDE_ANGLE = 20 * Math.PI / 180; // the donut driver's slideAngle: a launch this sideways is the drift

function readSession(path) {
  const frames = [];
  const drivers = new Map();
  let session = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line);
    session = chunk.session;
    const base = frames.length;
    for (const row of chunk.frames) {
      const f = {};
      chunk.fields.forEach((name, i) => { f[name] = row[i]; });
      frames.push(f);
    }
    for (const [i, snapshot] of chunk.drivers ?? []) drivers.set(base + i, snapshot);
  }
  return { path, session, frames, drivers };
}

// Runs of AI frames: [first, last] indices
function aiSegments(frames) {
  const segments = [];
  frames.forEach((f, i) => {
    if (!f.ai) return;
    const last = segments[segments.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else segments.push([i, i]);
  });
  return segments;
}

function keysOf(f) {
  return `${f.forward ? 'W' : ''}${f.backward ? 'S' : ''}${f.left ? 'A' : ''}${f.right ? 'D' : ''}${f.handbrake ? 'H' : ''}`;
}

// The AI's part of a session as a checker trace. A show segment (it starts at SHOW_SPOT: a P press) has its phases
// read back from the driving, since the recorder doesn't log them: the roll until the first W held unbroken for
// LAUNCH_HOLD from a rolling start (the launch), the donuts until the car runs off the circle away from the cop, then
// the run. A segment elsewhere is the I key's roam. The cop is taken as parked at COP_SPOT (the show parks it there).
function toTrace(session, segmentIndex = 0) {
  const segments = aiSegments(session.frames);
  if (!segments.length) return null;
  const [first, last] = segments[Math.min(segmentIndex, segments.length - 1)];
  const raw = session.frames.slice(first, last + 1);
  const show = Math.hypot(raw[0].x - SHOW_SPOT.x, raw[0].z - SHOW_SPOT.z) < SHOW_START_RADIUS;
  let t = 0;
  const frames = raw.map((f, i) => {
    const out = {
      f: first + i, t: +t.toFixed(4), dt: f.dt, x: f.x, z: f.z, h: f.heading, v: f.speed, vx: f.vx, vz: f.vz, w: f.angularVel,
      st: f.steerAngle, slip: f.slipAngle, spin: f.wheelspin, gear: f.gear, k: keysOf(f), thr: null,
      phase: show ? 'roll' : 'roam', dp: null, laps: null, cx: show ? COP.x : null, cz: show ? COP.z : null, ch: -Math.PI / 2,
      cs: show ? 'parked' : 'hidden', copHit: null, bHit: null, tHit: null, tGap: null, rev: null, cam: f.camera
    };
    t += f.dt;
    return out;
  });
  const notes = [];
  if (show) {
    let launch = -1;
    for (let i = 0; i < frames.length && launch < 0; i++) {
      const f = frames[i];
      if (!f.k.includes('W') || groundSpeed(f) < LAUNCH_MIN_SPEED) continue;
      if (i > 0 && frames[i - 1].k.includes('W')) continue;
      let j = i;
      while (j + 1 < frames.length && frames[j + 1].k.includes('W')) j++;
      if (frames[j].t - f.t + frames[j].dt >= LAUNCH_HOLD) launch = i;
    }
    let exit = -1;
    if (launch >= 0) {
      for (let i = launch; i < frames.length; i++) {
        const f = frames[i];
        const dx = f.x - COP.x, dz = f.z - COP.z;
        const distance = Math.hypot(dx, dz);
        const s = Math.sin(f.h), c = Math.cos(f.h);
        const radial = ((s * f.v + f.vx) * dx + (c * f.v + f.vz) * dz) / distance;
        if (distance > EXIT_DISTANCE && radial > EXIT_RADIAL) {
          exit = i;
          break;
        }
      }
    }
    let sliding = false;
    frames.forEach((f, i) => {
      if (launch >= 0 && i >= launch && (exit < 0 || i < exit)) {
        f.phase = 'donuts';
        sliding ||= Math.abs(f.slip) > SLIDE_ANGLE;
        f.dp = sliding ? 'drift' : 'launch';
      } else if (exit >= 0 && i >= exit) {
        f.phase = 'escape';
      }
    });
    notes.push(`phases read back from the driving: launch at frame ${launch >= 0 ? frames[launch].f : 'none'}, off the circle at ${exit >= 0 ? frames[exit].f : 'none (the AI part ends first)'}`);
  }
  return {
    source: 'session', label: `${session.session} AI segment ${segmentIndex + 1}/${segments.length}`, file: session.path,
    cop: show ? { ...COP } : null, frames, events: [], meta: { segment: [first, last], show, notes, lapsBefore: 0 }
  };
}

// musa's frame times on the show (the AI segment's dt column), the "musa" clock profile
function musaFrameTimes(path = MUSA_SESSION) {
  const session = readSession(path);
  const [first, last] = aiSegments(session.frames)[0];
  return session.frames.slice(first, last + 1).map((f) => f.dt);
}

// The car at musa's over-rotated launch, as the show would have it mid-donut: the car's state, the keyboard driver's
// snapshot from the same frame, and how far round the cop it had swept since the launch
function musaLaunchState(path = MUSA_SESSION, frame = MUSA_LAUNCH_FRAME) {
  const session = readSession(path);
  const trace = toTrace(session);
  const f = session.frames[frame];
  const launch = trace.frames.find((q) => q.phase === 'donuts');
  let swept = 0;
  let bearing = null;
  for (let i = launch.f; i <= frame; i++) {
    const q = session.frames[i];
    const b = Math.atan2(q.x - COP.x, q.z - COP.z);
    if (bearing !== null) swept += wrapAngle(b - bearing);
    bearing = b;
  }
  return {
    source: `${path} frame ${frame} (t ${f.t})`,
    x: f.x, z: f.z, heading: f.heading, speed: f.speed, vx: f.vx, vz: f.vz, angularVel: f.angularVel, steerAngle: f.steerAngle,
    longAccel: f.longAccel, gear: f.gear, rpm: f.rpm, wheelSlip: f.wheelSlip, limiterTime: f.limiterTime,
    slipAngle: f.slipAngle, wheelspin: f.wheelspin, driver: session.drivers.get(frame) ?? null,
    showPhase: 'donuts', donutPhase: 'drift', swept
  };
}

export { MUSA_LAUNCH_FRAME, MUSA_SESSION, aiSegments, musaFrameTimes, musaLaunchState, readSession, toTrace };
