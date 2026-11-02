#!/usr/bin/env node
// One scenario, end to end: serve the repo, run the show headless, check every beat, write the run's report page.
// usage: node tools/swim-eval/run.mjs <scenario> --out <dir> [--port 8792] [--duration s] [--assets <dir>] [--no-check]
//   <scenario>: a name from lib/scenarios.mjs (fresh-s1-120, warm-s1-mix, launch-musa ...), or fresh-s<seed>-<profile>
//   The server is started on --port unless one already answers there, and stopped again if this run started it.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkRunDir } from './lib/check-run.mjs';
import { findScenario } from './lib/scenarios.mjs';
import { runScenario } from './lib/runner.mjs';
import { startServer } from './lib/server.mjs';

const REPO = resolve(new URL('../..', import.meta.url).pathname);
const DEFAULT_ASSETS = '/Users/timapple/Documents/mcc/fujira/theshore/swimming-in-slop-newyork/assets';

function parseArgs(argv) {
  const args = { positional: [], port: 8792, out: null, duration: null, assets: DEFAULT_ASSETS, check: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--duration') args.duration = Number(argv[++i]);
    else if (a === '--assets') args.assets = argv[++i];
    else if (a === '--no-check') args.check = false;
    else args.positional.push(a);
  }
  return args;
}

async function serverUp(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/index.html`, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

// Serve the repo on `port` unless something already does; returns the server this call started (to stop), or null
async function ensureServer(port, assets) {
  if (await serverUp(port)) return null;
  return startServer(port, REPO, assets);
}

async function main() {
  // (Playwright closes the browser on a signal; the run stops with it rather than carrying on without one)
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(128 + (signal === 'SIGTERM' ? 15 : 2)));
  const args = parseArgs(process.argv.slice(2));
  const scenario = findScenario(args.positional[0] ?? '');
  if (!scenario || !args.out) {
    console.error('usage: node tools/swim-eval/run.mjs <scenario> --out <dir> [--port 8792] [--duration s] [--no-check]');
    process.exit(2);
  }
  if (args.duration) scenario.duration = args.duration;
  const outDir = resolve(args.out);
  mkdirSync(join(outDir, 'maps'), { recursive: true });
  const server = await ensureServer(args.port, args.assets);
  try {
    const { runDir, run } = await runScenario(scenario, { outDir, port: args.port, repo: REPO, mapDir: join(outDir, 'maps') });
    if (args.check && !run.failure) {
      const verdict = await checkRunDir(runDir);
      console.log(`report: ${join(runDir, 'report.html')}`);
      for (const beat of verdict.beats) console.log(`  ${beat.id}. ${beat.verdict.padEnd(14)} ${beat.title}: ${beat.summary}`);
    }
    if (run.failure) process.exitCode = 1;
  } finally {
    server?.close();
  }
}

export { REPO, ensureServer, serverUp };

if (import.meta.url === `file://${process.argv[1]}`) await main();
