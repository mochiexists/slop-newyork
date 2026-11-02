// One scenario in headless Chrome, driven the way musa drives it: keys pressed on exact frames of a virtual clock, P,
// and the show left alone. Writes into the run's folder: trace.json (every frame since P), run.json (the scenario,
// what was injected, the build, the page's errors), video.webm (kept, never deleted), shots/ (a screenshot at every beat
// change and every contact), session.jsonl (the game's own flight recorder, as it POSTed it).
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { midtownRegion } from './map.mjs';
import { clockInit, dumpMap, injectState, installProbe, readTrace } from './page.mjs';
import { musaFrameTimes } from './session.mjs';

const require = createRequire(import.meta.url);
const PLAYWRIGHT = process.env.SWIM_EVAL_PLAYWRIGHT ?? '/Users/timapple/Documents/mcc/fujira/theforest/clawpost/clawpost/web/node_modules/playwright-core';
const CHROME = process.env.SWIM_EVAL_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 1280, height: 800 };
const PRE_P_FRAMES = 600; // game-loop frames from the loop's start to the P press (the loading screen is gone by then)
const LOAD_TIMEOUT = 15 * 60 * 1000; // ms for the city to load (geodata, buildings, shaders)
const TRACE_SLICE = 4000; // frames per read of the trace
const WARMUP_SWING = 1; // s the wheel is held each way while warming up
const SETTLE_AFTER_WARMUP = 1; // s off the keys between the warm-up and P
const SHOT_QUALITY = 82; // JPEG quality of the screenshots

// The few lines of main.js the run needs from the page, rewritten as it is served (nothing in the repo changes): the
// director, world and controllers exposed, and the clock told when the game loop starts. Each must match exactly once.
const MAIN_HOOKS = [
  ['swimDirector = new SwimDirector({', 'swimDirector = globalThis.__swim = new SwimDirector({'],
  ["markInit('traffic');", "markInit('traffic'); globalThis.__evalWorld = { cityGrid, streetDetails, trafficSystem, allColliders };"],
  ['const controllerManager = new ThirdPersonControllerManager(scene, allColliders);',
    'const controllerManager = new ThirdPersonControllerManager(scene, allColliders); globalThis.__evalControllers = controllerManager;'],
  ['renderer.setAnimationLoop((now) => {', 'globalThis.__clock?.loopStarting(); renderer.setAnimationLoop((now) => {']
];

function rewriteMain(body) {
  const applied = [];
  for (const [from, to] of MAIN_HOOKS) {
    const count = body.split(from).length - 1;
    if (count !== 1) throw new Error(`main.js hook "${from}" matched ${count} times (want 1): the game changed under the harness`);
    body = body.replace(from, to);
    applied.push(from);
  }
  return { body, applied };
}

// The build: the last commit that changed the game (js/, css/, index.html), so a commit that only adds tooling
// doesn't read as a new build; "+dirty" when the game's files have uncommitted changes (the run is of the working tree)
function gitSha(repo) {
  try {
    const game = ['--', 'js', 'css', 'index.html'];
    const sha = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%h', ...game], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', repo, 'status', '--porcelain', ...game], { encoding: 'utf8' }).trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return 'unknown';
  }
}

function log(runDir, line) {
  const stamp = new Date().toTimeString().slice(0, 8);
  appendFileSync(join(runDir, 'run.log'), `${stamp} ${line}\n`);
  if (process.env.SWIM_EVAL_QUIET !== '1') console.log(`[${stamp}] ${line}`);
}

// Map dumps are per build: the same sha shares one
async function ensureMap(page, mapFile) {
  if (existsSync(mapFile)) return JSON.parse(readFileSync(mapFile, 'utf8'));
  const dump = await page.evaluate(dumpMap, midtownRegion());
  mkdirSync(dirname(mapFile), { recursive: true });
  writeFileSync(mapFile, JSON.stringify(dump));
  return dump;
}

async function runScenario(scenario, { outDir, port, repo, mapDir }) {
  const runDir = join(outDir, scenario.name);
  mkdirSync(join(runDir, 'shots'), { recursive: true });
  const sha = gitSha(repo);
  const started = Date.now();
  log(runDir, `scenario ${scenario.name}: profile ${scenario.profile}, traffic seed ${scenario.trafficSeed}, seed ${scenario.seed}, warm-up ${scenario.warmup} s, inject ${scenario.inject ? scenario.inject.label : 'none'}, ${scenario.duration} s, build ${sha}`);
  const cfg = {
    profile: scenario.profile === 'musa' ? 'seq' : scenario.profile, dtSequence: scenario.profile === 'musa' ? musaFrameTimes() : null,
    clockSeed: scenario.clockSeed, seed: scenario.seed, seedMath: true
  };
  const probeCfg = { trafficSeed: scenario.trafficSeed, snapBeats: true, snapIncidents: true };

  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
  });
  const videoDir = join(runDir, 'video-raw');
  const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: videoDir, size: VIEWPORT } });
  const videoStartWall = Date.now();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`); });
  await page.addInitScript(clockInit, cfg);
  let hooks = null;
  await page.route('**/js/main.js', async (route) => {
    const response = await route.fetch();
    const rewritten = rewriteMain(await response.text());
    hooks = rewritten.applied;
    await route.fulfill({ response, body: rewritten.body });
  });
  // A scratch-patched build (scenario.patches: [{ file: 'js/x.js', from, to }]): text replaced as the page fetches the
  // file, to see a check fail on a deliberately broken game. Nothing in the repo changes; each must match once.
  for (const [file, patches] of Object.entries(Object.groupBy(scenario.patches ?? [], (p) => p.file))) {
    await page.route(`**/${file}`, async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      for (const { from, to } of patches) {
        if (body.split(from).length !== 2) throw new Error(`patch of ${file}: "${from}" must match exactly once`);
        body = body.replace(from, to);
      }
      await route.fulfill({ response, body });
    });
  }
  // The game's flight recorder: its chunks, kept with the run (scored offline as a cross-check)
  await page.route('**/session-log', async (route) => {
    appendFileSync(join(runDir, 'session.jsonl'), `${route.request().postData()}\n`);
    await route.fulfill({ status: 204, body: '' });
  });
  const run = { scenario, sha, port, started: new Date(started).toISOString(), videoStartWall, errors, shots: [] };
  const shoot = async (label, at) => {
    const file = `${String(run.shots.length).padStart(2, '0')}-${label}.jpg`;
    await page.screenshot({ path: join(runDir, 'shots', file), type: 'jpeg', quality: SHOT_QUALITY });
    run.shots.push({ file, label, ...at });
  };
  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    const loadDeadline = Date.now() + LOAD_TIMEOUT;
    while (!(await page.evaluate(() => globalThis.__clock?.loopStarted))) {
      if (Date.now() > loadDeadline) throw new Error('the game loop never started');
      await page.waitForTimeout(1000);
    }
    if (!hooks) throw new Error('main.js was not rewritten');
    log(runDir, `game loop started after ${((Date.now() - started) / 1000).toFixed(0)} s; hooks: ${hooks.length}`);
    // The loading screen goes once the GPU has got through the first frame; then the city runs to PRE_P_FRAMES
    let frames = 0;
    while (!(await page.evaluate(() => document.getElementById('loading-overlay')?.classList.contains('hidden')))) {
      ({ frame: frames } = await page.evaluate((n) => globalThis.__clock.run(n), 10));
      if (frames > PRE_P_FRAMES * 5) throw new Error('the loading screen never went');
    }
    run.loadingFrames = frames;
    if (frames < PRE_P_FRAMES) ({ frame: frames } = await page.evaluate((n) => globalThis.__clock.run(n), PRE_P_FRAMES - frames));
    const probe = await page.evaluate(installProbe, probeCfg);
    run.probe = probe;
    const mapFile = join(mapDir, `map-${sha}.json`);
    await ensureMap(page, mapFile);
    run.mapFile = mapFile;

    // The warm-up: into swim mode at the Squeeze start (7th Ave & 47th St), then a drive round Midtown before P, the
    // way musa drives before pressing it: I (the AI drives on from where the car is, through the same keys a player
    // has), I again to take the car back, a second off the keys, P. (The old warm-up, W with the wheel swung side to
    // side each second as show-clock.cjs did, steered into the kerb wall in its first metres and sat there with W held
    // for the rest: 37 m in 60 s.) warmupMode 'swing' keeps it, for comparison.
    if (scenario.warmup > 0) {
      await page.keyboard.press('Digit5');
      await page.evaluate((n) => globalThis.__clock.run(n), 30);
      await page.evaluate(() => document.getElementById('swim-start-squeeze')?.click());
      await page.evaluate((n) => globalThis.__clock.run(n), 30);
      let simTime = await page.evaluate(() => globalThis.__clock.simTime);
      const end = simTime + scenario.warmup;
      if (scenario.warmupMode === 'swing') {
        await page.keyboard.down('KeyW');
        let side = 0;
        while (simTime < end) {
          const key = side % 2 ? 'KeyA' : 'KeyD';
          await page.keyboard.down(key);
          ({ simTime } = await page.evaluate((t) => globalThis.__clock.run(Infinity, t), simTime + WARMUP_SWING));
          await page.keyboard.up(key);
          ({ simTime } = await page.evaluate((t) => globalThis.__clock.run(Infinity, t), simTime + WARMUP_SWING));
          side++;
        }
        await page.keyboard.up('KeyW');
      } else {
        await page.keyboard.press('KeyI');
        // (the distance it drives, a second at a time: a warm-up that went nowhere is no warm-up)
        const where = () => page.evaluate(() => ({ x: globalThis.__swim.car.position.x, z: globalThis.__swim.car.position.z, phase: globalThis.__swim.show.phase }));
        let last = await where();
        run.warmupDistance = 0;
        run.warmupPhase = last.phase;
        while (simTime < end) {
          ({ simTime } = await page.evaluate((t) => globalThis.__clock.run(Infinity, t), Math.min(end, simTime + 1)));
          const now = await where();
          run.warmupDistance += Math.hypot(now.x - last.x, now.z - last.z);
          last = now;
        }
        await page.keyboard.press('KeyI');
      }
      ({ simTime } = await page.evaluate((t) => globalThis.__clock.run(Infinity, t), simTime + SETTLE_AFTER_WARMUP));
      run.warmupEnd = await page.evaluate(() => {
        const c = globalThis.__swim.car;
        return { x: c.position.x, z: c.position.z, heading: c.heading, speed: c.speed, mode: globalThis.__evalControllers.activeMode };
      });
      await shoot('warmup-end', { t: 0 });
      log(runDir, `warm-up ${scenario.warmup} s (${scenario.warmupMode ?? 'roam'}${run.warmupDistance === undefined ? '' : `, ${run.warmupDistance.toFixed(0)} m driven, AI ${run.warmupPhase}`}) done at (${run.warmupEnd.x.toFixed(0)}, ${run.warmupEnd.z.toFixed(0)}), ${(run.warmupEnd.speed * 2.237).toFixed(0)} mph`);
    }

    // P, on a frame of its own: Math.random reseeded and the trace started at the same instant
    const pAt = await page.evaluate((seed) => {
      globalThis.__clock.reseedMath(seed);
      globalThis.__trace.t0 = globalThis.__clock.simTime;
      globalThis.__trace.recording = true;
      return { frame: globalThis.__clock.loopFrame, simTime: globalThis.__clock.simTime };
    }, scenario.seed);
    await page.keyboard.press('KeyP');
    run.pFrame = pAt.frame;
    if (scenario.inject) {
      run.injected = await page.evaluate(injectState, scenario.inject);
      log(runDir, `injected ${scenario.inject.label}: ${JSON.stringify(run.injected)}`);
    }
    // (the P shot after the first frame of the show has rendered: until then the canvas holds the frame before P)
    const first = await page.evaluate(() => globalThis.__clock.run(1));
    await shoot('p', { t: 0, frame: first.frame });

    // The show, run to the end with a stop for a screenshot at each beat change and contact
    let simSinceP = 0;
    let lastReport = 0;
    while (simSinceP < scenario.duration) {
      const result = await page.evaluate((t) => globalThis.__clock.run(Infinity, t), pAt.simTime + scenario.duration);
      simSinceP = result.simTime - pAt.simTime;
      if (result.stop) await shoot(result.stop.label, { t: result.stop.t, frame: result.stop.frame, kind: result.stop.kind });
      if (simSinceP - lastReport >= 15 || simSinceP >= scenario.duration) {
        lastReport = simSinceP;
        const state = await page.evaluate(() => ({ phase: globalThis.__swim.show.phase, x: globalThis.__swim.car.position.x, z: globalThis.__swim.car.position.z, v: globalThis.__swim.car.speed }));
        log(runDir, `t ${simSinceP.toFixed(1)} s: ${state.phase} at (${state.x.toFixed(0)}, ${state.z.toFixed(0)}) ${(Math.abs(state.v) * 2.237).toFixed(0)} mph`);
      }
    }
    await shoot('end', { t: simSinceP });

    const head = await page.evaluate(readTrace, { from: 0, count: 0 });
    const traceFrames = [];
    for (let from = 0; from < head.frames; from += TRACE_SLICE) traceFrames.push(...(await page.evaluate(readTrace, { from, count: TRACE_SLICE })));
    const trace = {
      source: 'run', label: scenario.name, cop: probe.cop, showSpot: probe.showSpot, frames: traceFrames, events: head.events,
      meta: { sha, profile: scenario.profile, trafficSeed: scenario.trafficSeed, seed: scenario.seed, warmup: scenario.warmup, injected: scenario.inject ? scenario.inject.label : null, injectedAt: run.injected ? { x: run.injected.x, z: run.injected.z } : null, lapsBefore: scenario.inject ? (scenario.inject.swept ?? 0) / (2 * Math.PI) : 0 }
    };
    writeFileSync(join(runDir, 'trace.json'), JSON.stringify(trace));
    run.frames = traceFrames.length;
  } catch (error) {
    run.failure = String(error?.stack ?? error);
    log(runDir, `FAILED: ${run.failure}`);
  } finally {
    // (this page's own recording: a rerun into the same folder must not pick up an earlier, interrupted one's)
    run.videoRaw = await page.video()?.path().catch(() => null);
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  // The video, kept with the run under a stable name (an earlier video.webm is kept too, renamed by its time)
  if (run.videoRaw && existsSync(run.videoRaw)) {
    if (existsSync(join(runDir, 'video.webm'))) renameSync(join(runDir, 'video.webm'), join(runDir, `video-earlier-${Date.now()}.webm`));
    renameSync(run.videoRaw, join(runDir, 'video.webm'));
    run.video = 'video.webm';
  }
  run.finished = new Date().toISOString();
  run.wallSeconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 1));
  log(runDir, `done in ${run.wallSeconds} s: ${run.frames ?? 0} frames${errors.length ? `, ${errors.length} page errors` : ''}`);
  return { runDir, run };
}

export { MAIN_HOOKS, rewriteMain, runScenario };
