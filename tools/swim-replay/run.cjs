#!/usr/bin/env node
// swim-replay: runs the swimming car headless in the real game and says whether it drives the same path again.
//
//   node tools/swim-replay/run.cjs show [--fps 120,60,30,mix] [--seconds 60]
//       The AI show (P) once per frame clock, each traced tick by tick; every run compared with the first.
//   node tools/swim-replay/run.cjs session <session.jsonl|.json> [--fps 60,30] [--run N]
//       A recorded session's run (by default its last) played again at each frame clock: from its recorded start (the
//       car, its driver, the cop, the traffic seed and the city's clock as they were), the player's keys and the
//       events (T, Z, X, I, P) pressed tick by tick as recorded. Each replay is compared with the recording (which is
//       rounded: to the millimetre in x and z) and the replays with each other (exactly).
//   node tools/swim-replay/run.cjs script <keys.json> [--fps 120,60,30,mix]
//       A seed and a key list: { "seed": 5, "start": { "x": -600, "z": -300, "heading": 0 }, "elapsed": 40,
//       "seconds": 20, "keys": [[0, "W"], [240, "WA"], [300, "W"], ...] } (tick, keys held from it on: W S A D and H for
//       the handbrake). The car put at the start and the city laid out from the seed, then the keys tick by tick.
//       Every frame clock compared with the first; each run's recorded session saved, for `session`.
//   node tools/swim-replay/run.cjs drive <keys.json> [--fps 120] [--replay 60,30]
//       The same key list pressed as a player does, through the real keyboard, each press when the page's clock is
//       seen to reach its tick (polled, so the ticks the keys land on are the browser's doing, not the list's): the
//       recorder's session is saved, then replayed at each --replay frame clock and compared with what was recorded.
//
// Common options: --root dir (the checkout to serve, default this repo), --out dir (default tools/swim-replay/runs/
// <time>), --page-seed N (the page's Math.random, default 1), --mix-seed N (the mix clock's draws), --until s (compare
// up to this sim time), --tolerance m (default 1e-6; against a recording, 1e-3, its rounding). Exits 1 if any
// comparison is over its tolerance. Needs Chrome and playwright-core (PLAYWRIGHT_CORE=path, or the clawpost copy).
// A run takes a minute or more: the page builds the whole city and renders every frame.
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { openGame } = require('./browser.cjs');
const { compare, describe } = require('./trajectory.cjs');
const { readSession, replayPlan } = require('./session.cjs');

const RECORDING_TOLERANCE = 1e-3; // m: the recorder keeps x and z to the millimetre
const DRIVE_TICK = 1 / 120; // s: the swim clock's tick (js/swim-clock.js), to turn a key list's seconds into ticks

function parseArgs(argv) {
  const args = { mode: argv[0], file: null, fps: null, replay: ['60', '30'], seconds: 60, root: resolve(__dirname, '../..'),
    out: null, pageSeed: 1, mixSeed: 1, until: Infinity, tolerance: null, run: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--fps') args.fps = next().split(',');
    else if (a === '--replay') args.replay = next().split(',');
    else if (a === '--seconds') args.seconds = Number(next());
    else if (a === '--root') args.root = resolve(next());
    else if (a === '--out') args.out = resolve(next());
    else if (a === '--page-seed') args.pageSeed = Number(next());
    else if (a === '--mix-seed') args.mixSeed = Number(next());
    else if (a === '--until') args.until = Number(next());
    else if (a === '--tolerance') args.tolerance = Number(next());
    else if (a === '--run') args.run = Number(next());
    else args.file = resolve(a);
  }
  if (!['show', 'session', 'script', 'drive'].includes(args.mode) || (args.mode !== 'show' && !args.file)) {
    throw new Error('usage: run.cjs show | session <file> | script <keys.json> | drive <keys.json> [--fps ...] [--root dir] [--out dir]');
  }
  args.fps ??= { session: ['60', '30'], drive: ['120'] }[args.mode] ?? ['120', '60', '30', 'mix'];
  return args;
}

// In the page: trace every physics step the swimming car takes (the recorder's frame hook runs once per step, with
// the state the step starts from and the keys it is given) once `start()` says so, for `seconds` or `ticks`
function installTrace({ seconds = Infinity, ticks = Infinity }) {
  const recorder = globalThis.__cm.swimRecorder;
  const frame = recorder.frame.bind(recorder);
  const trace = globalThis.__trace = { samples: [], t: 0, on: false, done: false, start: null };
  const bits = { forward: 1, backward: 2, left: 4, right: 8, handbrake: 16 };
  recorder.frame = (car, keys, dt, ...rest) => {
    frame(car, keys, dt, ...rest);
    if (!trace.on && trace.start?.()) trace.on = true;
    if (!trace.on || trace.done) return;
    let k = 0;
    for (const key in bits) if (keys[key]) k |= bits[key];
    const d = car.drift ?? {};
    trace.samples.push([trace.t, car.position.x, car.position.z, car.heading, car.speed, d.slipAngle ?? 0, car.vx, car.vz,
      car.angularVel, k]);
    trace.t += dt;
    if (trace.t >= seconds - 1e-9 || trace.samples.length >= ticks) trace.done = true;
  };
}

async function waitDone(page) {
  await page.waitForFunction(() => globalThis.__trace?.done, null, { timeout: 0, polling: 500 });
  return page.evaluate(() => globalThis.__trace.samples);
}

// Into swim mode (5) and one frame on, so the mode's own run has started
async function enterSwimMode(page) {
  await page.keyboard.press('Digit5');
  await page.waitForFunction(() => globalThis.__cm.swimClock?.run, null, { timeout: 60000, polling: 100 });
}

// The AI show, as a player starts it: P
async function runShow(game, args) {
  const { page } = game;
  await page.evaluate(installTrace, { seconds: args.seconds });
  await page.evaluate(() => {
    globalThis.__trace.start = () => globalThis.__swim.show.running;
    globalThis.__frameClock.timing = true;
  });
  await page.keyboard.press('KeyP');
  const samples = await waitDone(page);
  game.frameTimes = await page.evaluate(() => globalThis.__frameClock.times);
  return samples;
}

// The real time each frame's script took (ms): how many, mean, median, 95th and 99th percentile, worst
function frameStats(times) {
  if (!times?.length) return null;
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = times.reduce((sum, t) => sum + t, 0) / times.length;
  return { frames: times.length, mean, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] };
}

// In the page: play a run again from its start, the player's keys and events tick by tick. plan: { start, keys (bits
// per tick), events [[tick, name]] }. A show run starts as the player started it (P), on the recorded city clock; any
// other run from the recorded state of the car, its driver and the cop.
async function pageReplay(plan) {
  const cm = globalThis.__cm;
  const director = globalThis.__swim;
  const clock = cm.swimClock;
  const { replayEvent } = await import('/js/swim-controls.js');
  const start = plan.start;
  const events = new Map();
  for (const [n, name] of plan.events) events.set(n, [...(events.get(n) ?? []), name]);
  const replay = globalThis.__replay = { armed: false, first: null, done: false };
  const onRun = clock.onRun;
  clock.onRun = (run, car) => {
    onRun?.(run, car);
    if (run.reason === (start.reason === 'show' ? 'show' : 'replay')) replay.armed = true;
  };
  const startRun = clock.startRun.bind(clock);
  clock.startRun = (options) => startRun({ ...options, elapsed: start.elapsed });
  globalThis.__trace.start = () => replay.armed;
  clock.beforeTick = (tick) => {
    if (!replay.armed) return;
    replay.first ??= tick;
    const n = tick - replay.first;
    if (n >= plan.keys.length) {
      replay.done = true;
      for (const key of ['forward', 'backward', 'left', 'right', 'up']) cm.keys[key] = 0;
      return;
    }
    for (const name of events.get(n) ?? []) replayEvent(name, cm.entities.swim, director);
    const bits = plan.keys[n];
    cm.keys.forward = bits & 1 ? 1 : 0;
    cm.keys.backward = bits & 2 ? 1 : 0;
    cm.keys.left = bits & 4 ? 1 : 0;
    cm.keys.right = bits & 8 ? 1 : 0;
    cm.keys.up = bits & 16 ? 1 : 0;
  };
  if (start.reason === 'show') return 'P';
  if (!start.car) return 'script'; // (the key list's own start: pageScriptStart)
  // The car, its driver and the cop as the run found them; the run itself (the city laid out) at the next frame
  const car = cm.entities.swim;
  const { position, drift, chassis, ...numbers } = start.car;
  Object.assign(car, numbers);
  car.position.set(position.x, position.y, position.z);
  Object.assign(car.drift, drift);
  if (chassis && car.chassisPivot) {
    car.chassisPivot.rotation.x = chassis.pitch;
    car.chassisPivot.rotation.z = chassis.roll;
    car.chassisPivot.position.y = chassis.heave;
  }
  if (cm.swimDriver) Object.assign(cm.swimDriver, start.driver);
  const cop = start.cruiser;
  if (cop && cop.state !== 'hidden') {
    director.cruiser.park(cop.x, cop.z, cop.heading);
    director.cruiser.retired = cop.retired;
  } else {
    director.cruiser.hide();
  }
  startRun({ seed: start.seed, x: start.x, z: start.z, reason: 'replay', elapsed: start.elapsed });
  return null;
}

// Plays `plan` in the game and returns the trace of its ticks
async function runPlan(game, plan) {
  const { page } = game;
  await enterSwimMode(page);
  await page.evaluate(installTrace, { ticks: plan.keys.length });
  const press = await page.evaluate(pageReplay, { start: plan.start, keys: plan.keys, events: plan.events });
  if (press === 'P') await page.keyboard.press('KeyP');
  return waitDone(page);
}

// A key list ({ seed, start, elapsed, seconds, keys: [[tick, "WA"], ...] }) as a plan: a run from the car at rest at
// `start`, the keys held from each tick on
function scriptPlan(script) {
  const ticks = Math.round((script.seconds ?? 20) / DRIVE_TICK);
  const keys = new Array(ticks).fill(0);
  const bit = { W: 1, S: 2, A: 4, D: 8, H: 16 };
  const list = [...script.keys].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < list.length; i++) {
    const [from, held] = list[i];
    const to = i + 1 < list.length ? list[i + 1][0] : ticks;
    let bits = 0;
    for (const key of held) bits |= bit[key] ?? 0;
    for (let n = from; n < Math.min(to, ticks); n++) keys[n] = bits;
  }
  return { keys, events: [], list };
}

// In the page: the car at rest at `start`, the run from `seed` there on the given city clock, at the next frame
function pageScriptStart({ seed, start, elapsed }) {
  const cm = globalThis.__cm;
  cm.teleportActiveTo(start.x, start.z, start.heading ?? 0);
  globalThis.__swim.cruiser.hide();
  const car = cm.entities.swim;
  cm.swimClock.startRun({ seed, x: car.position.x, z: car.position.z, reason: 'replay', elapsed: elapsed ?? 0 });
}

async function runScript(game, script) {
  const { page } = game;
  const plan = scriptPlan(script);
  await enterSwimMode(page);
  await page.evaluate(installTrace, { ticks: plan.keys.length });
  // the keys by tick, through the replay hook, from the run the script starts
  await page.evaluate(pageReplay, { start: { reason: 'replay', elapsed: script.elapsed ?? 0, car: null }, keys: plan.keys, events: [] });
  await page.evaluate(pageScriptStart, { seed: script.seed, start: script.start, elapsed: script.elapsed });
  const samples = await waitDone(page);
  return { samples, session: await page.evaluate(() => globalThis.__cm.swimRecorder.snapshot()) };
}

// The key list pressed through the real keyboard, at wall-clock pace: what a player's session is
async function runDrive(game, script) {
  const { page } = game;
  const plan = scriptPlan(script);
  await enterSwimMode(page);
  await page.evaluate(pageScriptStart, { seed: script.seed, start: script.start, elapsed: script.elapsed });
  await page.waitForFunction(() => globalThis.__cm.swimClock.run?.reason === 'replay', null, { timeout: 60000, polling: 50 });
  const codes = { W: 'KeyW', S: 'KeyS', A: 'KeyA', D: 'KeyD', H: 'Space' };
  const held = new Set();
  const first = await page.evaluate(() => globalThis.__cm.swimClock.run.tick);
  // (paced on the game's own ticks, polled: a headless page runs slower than the wall clock, and the poll lands each
  // press a few ticks either side of its mark, as a player's fingers would)
  const reach = (tick) => page.waitForFunction((t) => globalThis.__cm.swimClock.ticks >= t, first + tick,
    { timeout: 0, polling: 20 });
  for (const [tick, keys] of plan.list) {
    await reach(tick);
    for (const key of [...held]) if (!keys.includes(key)) {
      await page.keyboard.up(codes[key]);
      held.delete(key);
    }
    for (const key of keys) if (codes[key] && !held.has(key)) {
      await page.keyboard.down(codes[key]);
      held.add(key);
    }
  }
  await reach(plan.keys.length);
  for (const key of held) await page.keyboard.up(codes[key]);
  // a few ticks more, so the last keys' ticks are in, and the build's hash (fetched as the page started)
  await reach(plan.keys.length + 30);
  await page.waitForFunction(() => globalThis.__cm.swimRecorder.build, null, { timeout: 30000, polling: 200 }).catch(() => {});
  return page.evaluate(() => globalThis.__cm.swimRecorder.snapshot());
}

function report(label, reference, runs, tolerance, until) {
  let worst = 0;
  const rows = [];
  for (const run of runs) {
    const c = compare(reference, run, { until });
    worst = Math.max(worst, c.maxPosition);
    rows.push({ reference: reference.label, run: run.label, ...c });
    console.log(describe(`${run.label} vs ${reference.label}`, c));
  }
  const ok = worst <= tolerance;
  console.log(`${label}: ${ok ? 'SAME PATH' : 'DIVERGED'}: worst gap ${worst.toExponential(3)} m (tolerance ${tolerance} m)`);
  return { rows, ok, worst };
}

async function withGame(args, fps, body) {
  const started = Date.now();
  const game = await openGame({ root: args.root, fps, pageSeed: args.pageSeed, mixSeed: args.mixSeed });
  const loaded = Date.now();
  try {
    return await body(game);
  } finally {
    if (game.errors.length) console.log(`page errors at ${fps}:`, game.errors.slice(0, 5));
    await game.close();
    console.log(`${fps}: load ${((loaded - started) / 1000).toFixed(0)} s, run ${((Date.now() - loaded) / 1000).toFixed(0)} s`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = args.out ?? join(__dirname, 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(out, { recursive: true });
  const results = [];
  const save = (name, value) => writeFileSync(join(out, name), typeof value === 'string' ? value : JSON.stringify(value));

  if (args.mode === 'show' || args.mode === 'script') {
    const script = args.mode === 'script' ? JSON.parse(readFileSync(args.file, 'utf8')) : null;
    const runs = [];
    for (const fps of args.fps) {
      let frames = null;
      const samples = await withGame(args, fps, async (game) => {
        if (!script) {
          const traced = await runShow(game, args);
          frames = frameStats(game.frameTimes);
          if (frames) console.log(`${fps}: frame script ms over ${frames.frames} frames: mean ${frames.mean.toFixed(2)}, p50 ${frames.p50.toFixed(2)}, p95 ${frames.p95.toFixed(2)}, p99 ${frames.p99.toFixed(2)}, max ${frames.max.toFixed(1)}`);
          return traced;
        }
        const result = await runScript(game, script);
        save(`session-${fps}.json`, result.session);
        return result.samples;
      });
      const run = { label: fps, mode: args.mode, root: args.root, fps, pageSeed: args.pageSeed, mixSeed: args.mixSeed, frames, samples };
      save(`${args.mode}-${fps}.json`, run);
      runs.push(run);
    }
    results.push(report(`${args.mode} across frame clocks`, runs[0], runs.slice(1), args.tolerance ?? 1e-6, args.until));
  } else {
    let file = args.file;
    let fpsList = args.fps;
    if (args.mode === 'drive') {
      const script = JSON.parse(readFileSync(args.file, 'utf8'));
      const session = await withGame(args, args.fps[0], (game) => runDrive(game, script));
      file = join(out, `drive-${args.fps[0]}.json`);
      save(`drive-${args.fps[0]}.json`, session);
      fpsList = args.replay;
    }
    const plan = replayPlan(readSession(file), args.run);
    console.log(`${plan.session}: run ${plan.number + 1} of ${plan.runs} (${plan.start.reason}), ${plan.keys.length} ticks, ${plan.events.length} events, build ${JSON.stringify(plan.build)}`);
    const recorded = { label: 'recorded', samples: plan.recorded };
    const replays = [];
    for (const fps of fpsList) {
      const samples = await withGame(args, fps, (game) => runPlan(game, plan));
      const run = { label: `replay ${fps}`, mode: 'session', fps, samples };
      save(`replay-${fps}.json`, run);
      replays.push(run);
    }
    results.push(report('replay vs recording', recorded, replays, args.tolerance ?? RECORDING_TOLERANCE, args.until));
    if (replays.length > 1) results.push(report('replays vs each other', replays[0], replays.slice(1), 1e-6, args.until));
  }
  save('compare.json', JSON.stringify(results, null, 1));
  console.log(`out: ${out}`);
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
