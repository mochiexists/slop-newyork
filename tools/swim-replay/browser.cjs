// The game in headless Chrome for swim-replay: a static server for a checkout, a page on a virtual frame clock, and
// the hooks the replays read and press through. Nothing in the repo changes: main.js is served with the controller
// manager, the swim director and the swim clock exposed on globalThis (request interception).
//
// The page's frame clock is virtual: every animation frame hands the game a timestamp exactly 1/fps on from the last,
// whatever the headless browser's real frame rate, so a run is the one a 120 Hz (or 30 Hz) screen would give. "mix"
// is musa's Mac on 2026-11-01: each frame 1/120 or 1/60 s at random, half and half (its own seeded sequence).
// Math.random is seeded for the whole page (pageSeed), so the city it builds is the same every load.
const http = require('node:http');
const { createReadStream, existsSync, statSync } = require('node:fs');
const { extname, join, normalize, resolve } = require('node:path');

const PLAYWRIGHT_FALLBACK = '/Users/timapple/Documents/mcc/fujira/theforest/clawpost/clawpost/web/node_modules/playwright-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOAD_TIMEOUT = 600000; // ms: the city and its shaders, cold
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.gz': 'application/gzip', '.bin': 'application/octet-stream', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg'
};

function loadPlaywright() {
  for (const candidate of [process.env.PLAYWRIGHT_CORE, 'playwright-core', PLAYWRIGHT_FALLBACK]) {
    if (!candidate) continue;
    try {
      return require(candidate);
    } catch {
      // try the next one
    }
  }
  throw new Error('playwright-core not found: set PLAYWRIGHT_CORE to its folder');
}

// A static server for one checkout on 127.0.0.1 (a free port); the recorder's POSTs are taken and dropped
function serve(root) {
  const base = resolve(root);
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      req.resume();
      res.writeHead(204).end();
      return;
    }
    const path = normalize(decodeURIComponent(req.url.split('?')[0]));
    const file = join(base, path === '/' ? 'index.html' : path);
    if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port })));
}

// Runs in the page before its scripts: the seeded Math.random and the virtual frame clock
function pageClock({ fps, pageSeed, mixSeed }) {
  const mulberry = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  Math.random = mulberry(pageSeed);
  const mix = mulberry(mixSeed);
  let virtual = 0;
  const step = () => (fps === 'mix' ? (mix() < 0.5 ? 1000 / 120 : 1000 / 60) : 1000 / Number(fps));
  const raf = window.requestAnimationFrame.bind(window);
  // (and the real time each frame's script takes, from when `timing` is set: the frame-time cost)
  const clock = globalThis.__frameClock = { fps, timing: false, times: [] };
  window.requestAnimationFrame = (callback) => raf(() => {
    virtual += step();
    const began = performance.now();
    callback(virtual);
    if (clock.timing) clock.times.push(performance.now() - began);
  });
}

// Opens the game from `root` at `fps` and waits for the city: { page, close() }
async function openGame({ root, fps = '120', pageSeed = 1, mixSeed = 1, viewport = { width: 640, height: 400 } }) {
  const { chromium } = loadPlaywright();
  const { server, port } = await serve(root);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME ?? CHROME, headless: true,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required']
  });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(pageClock, { fps: String(fps), pageSeed, mixSeed });
  await page.route('**/js/main.js', async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    body = body.replace('swimDirector = new SwimDirector({', 'swimDirector = globalThis.__swim = new SwimDirector({');
    body = body.replace(/const controllerManager = new ThirdPersonControllerManager\(([^)]*)\);/,
      (line) => `${line} globalThis.__cm = controllerManager;`);
    await route.fulfill({ response, body });
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => document.getElementById('loading-overlay')?.classList.contains('hidden'), null,
    { timeout: LOAD_TIMEOUT, polling: 1000 });
  return {
    page,
    errors,
    async close() {
      await context.close();
      await browser.close();
      server.close();
    }
  };
}

module.exports = { openGame, serve };
