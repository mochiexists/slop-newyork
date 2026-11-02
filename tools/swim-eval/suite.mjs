#!/usr/bin/env node
// The suite: every scenario of lib/scenarios.mjs baselineSuite() (or --only a,b), a few at a time, each checked, then
// the summary page across them. Runs already in --out with a trace are kept and only re-checked (--rerun to redo them).
// usage: node tools/swim-eval/suite.mjs --out <dir> [--jobs 2] [--only name,name] [--port 8792] [--summary-only] [--rerun]
//        [--title "..."]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { checkRunDir } from './lib/check-run.mjs';
import { summaryPage } from './lib/report.mjs';
import { runScenario } from './lib/runner.mjs';
import { baselineSuite } from './lib/scenarios.mjs';
import { REPO, ensureServer } from './run.mjs';

const DEFAULT_ASSETS = '/Users/timapple/Documents/mcc/fujira/theshore/swimming-in-slop-newyork/assets';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(name);
const out = opt('--out') && resolve(opt('--out'));
if (!out) {
  console.error('usage: node tools/swim-eval/suite.mjs --out <dir> [--jobs 2] [--only a,b] [--port 8792] [--summary-only] [--rerun]');
  process.exit(2);
}
const jobs = Number(opt('--jobs', '2'));
const port = Number(opt('--port', '8792'));
const only = opt('--only')?.split(',');
const scenarios = baselineSuite().filter((s) => !only || only.includes(s.name));
mkdirSync(join(out, 'maps'), { recursive: true });

// Stopped means stopped: Playwright closes its browsers on a signal, and without this the workers would go on to the
// next scenario with new ones (2026-11-03: a killed suite kept running beside its replacement)
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(128 + (signal === 'SIGTERM' ? 15 : 2)));

// A run is finished when it has its trace and a run.json that records no failure (a run killed while closing its
// browser can leave the first without the second)
function finished(dir) {
  if (!existsSync(join(dir, 'trace.json')) || !existsSync(join(dir, 'run.json'))) return false;
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  return !run.failure && run.frames > 0;
}

function describe(s) {
  const parts = [`clock ${s.profile}`, `traffic seed ${s.trafficSeed}`];
  if (s.warmup) parts.push(`${s.warmup} s warm-up`);
  if (s.inject) parts.push(s.inject.label);
  return parts.join(' · ');
}

if (!flag('--summary-only')) {
  const server = await ensureServer(port, opt('--assets', DEFAULT_ASSETS));
  // (the short ones first: a suite cut off by its budget still has every scenario kind in it)
  const queue = scenarios.filter((s) => flag('--rerun') || !finished(join(out, s.name)));
  queue.sort((a, b) => a.duration + a.warmup - (b.duration + b.warmup));
  console.log(`${queue.length} of ${scenarios.length} scenarios to run, ${jobs} at a time`);
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      await runScenario(s, { outDir: out, port, repo: REPO, mapDir: join(out, 'maps') });
    }
  };
  try {
    await Promise.all(Array.from({ length: jobs }, worker));
  } finally {
    server?.close();
  }
}

const entries = [];
for (const s of scenarios) {
  const dir = join(out, s.name);
  if (!finished(dir)) {
    console.log(`${s.name}: no trace (${existsSync(join(dir, 'run.json')) ? JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).failure?.split('\n')[0] : 'not run'})`);
    continue;
  }
  const result = await checkRunDir(dir);
  // (the wall clock a run cost, so the suite's size stays realistic on the machine it runs on)
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  const cost = `${Math.round(run.wallSeconds / 60)} min wall for ${run.frames} frames`;
  entries.push({ result, href: relative(out, join(dir, 'report.html')), blurb: `${describe(s)} · ${cost}`, wallSeconds: run.wallSeconds, frames: run.frames });
  console.log(`${s.name.padEnd(22)} ${result.beats.map((b) => `${b.id}:${{ VERIFIED: 'V', 'NOT VERIFIED': 'X', INCONCLUSIVE: '?', 'N/A': '-' }[b.verdict]}`).join(' ')}  (${cost})`);
}
const wall = entries.reduce((sum, e) => sum + (e.wallSeconds ?? 0), 0);
const title = opt('--title', 'Swim show eval: summary');
writeFileSync(join(out, 'summary.html'), summaryPage({ entries, title, note: `${out} · ${new Date().toLocaleString()} · ${Math.round(wall / 60)} min of browser wall clock over ${entries.length} runs (${jobs} at a time)` }));
writeFileSync(join(out, 'summary.json'), JSON.stringify(entries.map((e) => ({ label: e.result.label, wallSeconds: e.wallSeconds, frames: e.frames, beats: e.result.beats.map((b) => ({ id: b.id, verdict: b.verdict, summary: b.summary })) })), null, 1));
console.log(`${Math.round(wall / 60)} min of browser wall clock over ${entries.length} runs`);
console.log(`summary: ${join(out, 'summary.html')}`);
