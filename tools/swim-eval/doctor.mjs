#!/usr/bin/env node
// Is this instance worth driving? Checks the tools, the build and a live page before an eval spends minutes on it:
// Chrome, Playwright, ffmpeg, the port, main.js's hook lines, then the game loaded headless on the virtual clock (WebGPU
// adapter, the loop started, the loading screen gone after a few frames, the director, controllers and traffic
// reachable, no page errors of the game's own). Exit 0 when every check passes.
// usage: node tools/swim-eval/doctor.mjs [--port 8792] [--assets <dir>]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { clockInit, installProbe } from './lib/page.mjs';
import { rewriteMain } from './lib/runner.mjs';
import { REPO, ensureServer, serverUp } from './run.mjs';

const require = createRequire(import.meta.url);
const PLAYWRIGHT = process.env.SWIM_EVAL_PLAYWRIGHT ?? '/Users/timapple/Documents/mcc/fujira/theforest/clawpost/clawpost/web/node_modules/playwright-core';
const CHROME = process.env.SWIM_EVAL_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_ASSETS = '/Users/timapple/Documents/mcc/fujira/theshore/swimming-in-slop-newyork/assets';
// Errors from the radio's YouTube embed (ads, tracking): not the game's
const THIRD_PARTY = /youtube|doubleclick|googlevideo|ggpht|ytimg/i;
const MIN_FPS = 10; // real frames/s under which the doctor warns that a full suite will take hours

const args = process.argv.slice(2);
const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 8792);
const assets = args.includes('--assets') ? args[args.indexOf('--assets') + 1] : DEFAULT_ASSETS;
const results = [];
// (a warning doesn't stop the drive: a slow machine gives the same run, deterministically, only later)
const check = (name, pass, detail = '', warning = false) => {
  results.push({ name, pass: pass || warning, detail });
  console.log(`${pass ? 'ok  ' : warning ? 'WARN' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

check('Chrome', existsSync(CHROME), CHROME);
check('playwright-core', existsSync(join(PLAYWRIGHT, 'package.json')), PLAYWRIGHT);
let ffmpeg = false;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
  ffmpeg = true;
} catch { /* reported below */ }
check('ffmpeg (failure stills from the video)', ffmpeg);
check('the M3 assets (model, sounds)', existsSync(join(REPO, 'assets/models/m3.glb')) || existsSync(join(assets, 'models/m3.glb')), existsSync(join(REPO, 'assets')) ? 'in the repo' : `served from ${assets}`);
const sha = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'js', 'index.html', 'css'], { encoding: 'utf8' }).trim();
check('build', true, `${sha}${dirty ? ' + uncommitted changes in js/ (the run is of the working tree, not the commit)' : ''}`);
try {
  rewriteMain(readFileSync(join(REPO, 'js/main.js'), 'utf8'));
  check('main.js hook lines (each once)', true);
} catch (error) {
  check('main.js hook lines (each once)', false, error.message);
}
const before = await serverUp(port);
check(`port ${port}`, true, before ? 'a server already answers (used as is: make sure it serves this repo)' : 'free: the doctor starts one and stops it');

const server = await ensureServer(port, assets);
const { chromium } = require(PLAYWRIGHT);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const started = Date.now();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !THIRD_PARTY.test(m.text())) errors.push(m.text().slice(0, 200)); });
  await page.addInitScript(clockInit, { profile: '60', clockSeed: 1, seed: 1, seedMath: true });
  await page.route('**/js/main.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: rewriteMain(await response.text()).body });
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  const adapter = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
  check('WebGPU adapter in headless Chrome', adapter);
  let loop = false;
  for (let i = 0; i < 600 && !loop; i++) {
    loop = await page.evaluate(() => Boolean(globalThis.__clock?.loopStarted));
    if (!loop) await page.waitForTimeout(1000);
  }
  check('the game loop started', loop, `${((Date.now() - started) / 1000).toFixed(0)} s to load`);
  if (loop) {
    const t0 = Date.now();
    let frames = 0;
    while (frames < 600 && !(await page.evaluate(() => document.getElementById('loading-overlay')?.classList.contains('hidden')))) {
      ({ frame: frames } = await page.evaluate(() => globalThis.__clock.run(10)));
    }
    check('the loading screen went', frames < 600, `after ${frames} frames`);
    ({ frame: frames } = await page.evaluate(() => globalThis.__clock.run(120)));
    const fps = 120 / ((Date.now() - t0) / 1000);
    const load = execFileSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).trim();
    check('headless frame rate (real)', fps > MIN_FPS, `${fps.toFixed(0)} frames/s (a 165 s show at 120 Hz takes ${(165 * 120 / fps / 60).toFixed(0)} min); load average ${load}`, true);
    const probe = await page.evaluate(installProbe, { trafficSeed: null, snapBeats: false, snapIncidents: false });
    check('director, controllers, traffic reachable', probe.ok && await page.evaluate(() => Boolean(globalThis.__swim?.show && globalThis.__evalControllers?.entities?.swim && globalThis.__evalWorld?.trafficSystem?.network)));
  }
  check('no page errors of the game\'s own', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server?.close();
}
const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\ndoctor: ${failed.length} check(s) failed: fix before driving` : '\ndoctor: worth driving');
process.exitCode = failed.length ? 1 : 0;
