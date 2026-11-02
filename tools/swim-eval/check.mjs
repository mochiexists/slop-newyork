#!/usr/bin/env node
// Score a trace or a player session offline, or re-check a run's folder.
// usage: node tools/swim-eval/check.mjs <trace.json | session.jsonl | run dir> --map <map-<sha>.json> [--out dir] [--segment n]
//   A session is scored on its AI part (segment 0: the first run of AI frames); the map is a runner dump (maps/).
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkFile, checkRunDir, findMap } from './lib/check-run.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const target = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!target) {
  console.error('usage: node tools/swim-eval/check.mjs <trace.json | session.jsonl | run dir> --map <map.json> [--out dir] [--segment n]');
  process.exit(2);
}
const path = resolve(target);
let result;
if (statSync(path).isDirectory()) {
  result = await checkRunDir(path, opt('--map'));
  console.log(`report: ${path}/report.html`);
} else {
  const mapFile = opt('--map') ?? findMap(dirname(path));
  if (!mapFile || !existsSync(mapFile)) {
    console.error('no map: pass --map <maps/map-<sha>.json> (a run writes one; tools/swim-eval/run.mjs)');
    process.exit(2);
  }
  const out = resolve(opt('--out') ?? dirname(path));
  const checked = checkFile(path, { mapFile, outDir: out, segment: Number(opt('--segment') ?? 0) });
  result = checked.result;
  console.log(`report: ${checked.page}`);
}
console.log(result.label);
for (const beat of result.beats) console.log(`  ${beat.id}. ${beat.verdict.padEnd(13)} ${beat.title}: ${beat.summary}`);
