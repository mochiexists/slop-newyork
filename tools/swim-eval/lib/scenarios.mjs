// The scenarios: what a run sets before the show's beats (never during them).
//   profile      the frame times: 120 | 60 | 30 (fixed), mix (each frame 1/120 or 1/60 s, half and half, as musa's Mac
//                ran the show on 2026-11-01), musa (the dt column of musa's AI segment, cycled)
//   trafficSeed  the seed the show reseeds its staged traffic with (swim-show.js SHOW_TRAFFIC_SEED is 1)
//   seed         Math.random's seed, set at load and again at the P frame (pedestrians, cosmetics: everything traffic.js
//                and pedestrian-system.js draw), so a run replays from its seed and inputs
//   clockSeed    the mix profile's own sequence
//   warmup       s of driving before P (swim mode, the Squeeze start, W with the wheel swung side to side every second)
//   inject       a start state written at the P frame (musa's launch and the bad launches round it)
//   duration     s of show to run after P
import { COP, DRIFT_RADIUS, wrapAngle } from './geometry.mjs';
import { musaLaunchState } from './session.mjs';

const RAD = Math.PI / 180;
const FULL_SHOW = 165; // s: roll, donuts, the run down 7th Ave, 42nd St, up 8th Ave, 57th St, then a minute of roam
const LAUNCH_SHOW = 45; // s: the donuts from the injected launch, the way out and the start of the run
const PROFILES = ['120', '60', '30', 'mix', 'musa'];

// The car turned about its own centre by `turn`, its velocity over the ground kept (so the slip angle grows by it)
function turned(state, turn) {
  const s = Math.sin(state.heading), c = Math.cos(state.heading);
  const wx = s * state.speed + state.vx, wz = c * state.speed + state.vz;
  const heading = state.heading + turn;
  const s2 = Math.sin(heading), c2 = Math.cos(heading);
  const speed = wx * s2 + wz * c2;
  const lateral = wx * c2 - wz * s2;
  // (drift-physics.js's sign: musa's left-hand donut reads -45°; past 90° the car is going backwards)
  return { ...state, heading, speed, vx: wx - s2 * speed, vz: wz - c2 * speed, slipAngle: Math.atan2(lateral, speed) };
}

// The car moved along the line from the cop, to `distance` from it
function atDistance(state, distance) {
  const dx = state.x - COP.x, dz = state.z - COP.z;
  const now = Math.hypot(dx, dz);
  return { ...state, x: COP.x + (dx / now) * distance, z: COP.z + (dz / now) * distance };
}

function scaled(state, share) {
  return { ...state, speed: state.speed * share, vx: state.vx * share, vz: state.vz * share, angularVel: state.angularVel * share };
}

// musa's launch and the family of bad launches round it: each starts mid-donut, each must recover. Each is recorded
// round the cop as it stood on 2026-11-01 (copAt: 7th Ave & 45th St); a run places it round the build's own cop
// (placeLaunch), the too-close and too-far ones at their share of the build's drift radius (radiusShare).
function launchFamily() {
  const musa = { ...musaLaunchState(), copAt: { ...COP } };
  const sideways = Math.sign(musa.slipAngle) || -1; // the way this slide is sideways (the session's slip sign)
  return {
    'launch-musa': { ...musa, label: 'musa\'s over-rotated launch (session frame 10800)' },
    'launch-overrotated': { ...turned(musa, 30 * RAD * -sideways), angularVel: musa.angularVel * 1.4, label: 'over-rotated: 30° further round, yaw ×1.4' },
    'launch-slow': { ...scaled(musa, 0.35), label: 'slow: 35% of musa\'s speed and yaw' },
    'launch-spun': { ...turned(musa, 60 * RAD * -sideways), label: 'spun past 90°: turned 60° on, slip ~105°' },
    'launch-close': { ...atDistance(musa, 5.5), radiusShare: 5.5 / DRIFT_RADIUS, label: 'too close: 5.5 m from the cop (half the drift radius)' },
    'launch-far': { ...atDistance(musa, 19), radiusShare: 19 / DRIFT_RADIUS, label: 'too far: 19 m from the cop (1.7 drift radii)' }
  };
}

// What the car must not start over (check.mjs KERB)
const KERB = new Set(['pavement', 'plaza', 'median', 'park', 'building']);
const CLAMP_STEP = 0.25; // m the start is moved toward the cop at a time, off the kerb

// An injected launch placed round the build's cop (`build`: { cop, radius }, the page's COP_SPOT and DRIFT_RADIUS):
// moved by the cop's move, heading and velocity kept; a launch named for its distance from the cop at that share of the
// build's radius. A start with the car's footprint over the kerb is moved toward the cop until it is clear (the
// carriageway round a cop at 42nd St is narrower than Times Square's), and run.json says by how much.
function placeLaunch(state, build, map) {
  const from = state.copAt ?? COP;
  const cop = build.cop;
  let x = state.x - from.x + cop.x, z = state.z - from.z + cop.z;
  if (state.radiusShare) {
    const d = Math.hypot(x - cop.x, z - cop.z);
    const r = state.radiusShare * build.radius;
    x = cop.x + ((x - cop.x) / d) * r;
    z = cop.z + ((z - cop.z) / d) * r;
  }
  const placed = { recordedCop: from, cop: { x: cop.x, z: cop.z }, x, z, distance: Math.hypot(x - cop.x, z - cop.z), clamped: 0 };
  const overKerb = (px, pz) => map.footprint(px, pz, state.heading).some((c) => KERB.has(c));
  const d0 = placed.distance;
  while (map && overKerb(x, z) && placed.clamped + CLAMP_STEP < d0) {
    placed.clamped += CLAMP_STEP;
    x = cop.x + ((placed.x - cop.x) * (d0 - placed.clamped)) / d0;
    z = cop.z + ((placed.z - cop.z) * (d0 - placed.clamped)) / d0;
  }
  placed.overKerb = map ? overKerb(x, z) : null;
  return { ...state, x, z, placed: { ...placed, x, z, distance: Math.hypot(x - cop.x, z - cop.z) } };
}

function scenario(name, fields) {
  return {
    name, profile: '120', trafficSeed: 1, seed: 1, clockSeed: 7, warmup: 0, inject: null, duration: FULL_SHOW, ...fields
  };
}

// The baseline suite: fresh P on three traffic seeds × four clocks, two after a warm-up drive, musa's launch and the
// bad launches (each on musa's own clock)
function baselineSuite() {
  const list = [];
  for (const trafficSeed of [1, 2, 3]) {
    for (const profile of ['120', '30', 'mix', 'musa']) {
      list.push(scenario(`fresh-s${trafficSeed}-${profile}`, { profile, trafficSeed, seed: trafficSeed, clockSeed: 100 + trafficSeed }));
    }
  }
  list.push(scenario('warm-s1-mix', { profile: 'mix', trafficSeed: 1, seed: 11, clockSeed: 211, warmup: 60 }));
  list.push(scenario('warm-s2-musa', { profile: 'musa', trafficSeed: 2, seed: 12, clockSeed: 212, warmup: 60 }));
  const family = launchFamily();
  for (const [name, inject] of Object.entries(family)) {
    list.push(scenario(name, { profile: 'musa', trafficSeed: 1, seed: 21, inject, duration: LAUNCH_SHOW }));
  }
  // musa's launch on the other clocks too: is a recovery a property of the clock?
  for (const profile of ['120', 'mix']) {
    list.push(scenario(`launch-musa-${profile}`, { profile, trafficSeed: 1, seed: 21, clockSeed: 221, inject: family['launch-musa'], duration: LAUNCH_SHOW }));
  }
  return list;
}

// The suite for a deterministic build (2771a69 on: a fixed 1/120 s clock, so a seed's run is the same tick for tick at
// any frame rate): one run per seed, on the 30 Hz clock (it renders a quarter of the frames for the same ticks), on
// more traffic seeds; each scenario kind once more on another clock, to show the run doesn't change with it
function deterministicSuite() {
  const list = [];
  for (let trafficSeed = 1; trafficSeed <= 8; trafficSeed++) {
    list.push(scenario(`fresh-s${trafficSeed}-30`, { profile: '30', trafficSeed, seed: trafficSeed }));
  }
  list.push(scenario('fresh-s1-120', { profile: '120', trafficSeed: 1, seed: 1 }));
  list.push(scenario('fresh-s1-musa', { profile: 'musa', trafficSeed: 1, seed: 1 }));
  list.push(scenario('warm-s1-30', { profile: '30', trafficSeed: 1, seed: 11, warmup: 60 }));
  list.push(scenario('warm-s2-30', { profile: '30', trafficSeed: 2, seed: 12, warmup: 60 }));
  list.push(scenario('warm-s3-30', { profile: '30', trafficSeed: 3, seed: 13, warmup: 90 }));
  const family = launchFamily();
  for (const [name, inject] of Object.entries(family)) {
    list.push(scenario(`${name}-30`, { profile: '30', trafficSeed: 1, seed: 21, inject, duration: LAUNCH_SHOW }));
  }
  list.push(scenario('launch-musa-musa', { profile: 'musa', trafficSeed: 1, seed: 21, inject: family['launch-musa'], duration: LAUNCH_SHOW }));
  return list;
}

// Deliberately broken builds (patched in the page, lib/runner.mjs), to see the live checks fail: not in the baseline
function brokenBuilds() {
  return [
    scenario('broken-roll-and-radius', {
      duration: 30,
      patches: [
        { file: 'js/swim-show.js', from: 'const DRIFT_RADIUS = 11;', to: 'const DRIFT_RADIUS = 16; // (swim-eval: broken on purpose)' },
        { file: 'js/swim-show.js', from: 'rollSpeed: 5,', to: 'rollSpeed: 8, // (swim-eval: broken on purpose)' }
      ]
    })
  ];
}

function findScenario(name) {
  const known = [...baselineSuite(), ...deterministicSuite(), ...brokenBuilds()].find((s) => s.name === name);
  if (known) return known;
  // fresh-s<seed>-<profile>[-w<warmup>], made up on the spot
  const match = /^fresh-s(\d+)-(\w+?)(?:-w(\d+))?$/.exec(name);
  if (match && PROFILES.includes(match[2])) {
    return scenario(name, { trafficSeed: Number(match[1]), seed: Number(match[1]), profile: match[2], warmup: Number(match[3] ?? 0) });
  }
  return null;
}

export { FULL_SHOW, LAUNCH_SHOW, PROFILES, baselineSuite, deterministicSuite, findScenario, launchFamily, placeLaunch, scenario, turned, wrapAngle };
