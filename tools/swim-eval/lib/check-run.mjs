// Check one run's folder (runner.mjs wrote it): the verdict per beat (verdict.json), a still from the video at every
// failure moment (failures/), the run's report page (report.html). Also scores a trace or session file on its own.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { checkTrace } from './check.mjs';
import { SwimMap } from './map.mjs';
import { runPage } from './report.mjs';
import { readSession, toTrace } from './session.mjs';

const MAX_FAILURE_STILLS = 12;
const LAST_FRAME_SEEK = 0.2; // s before the video's end

function loadMap(file) {
  return new SwimMap(JSON.parse(readFileSync(file, 'utf8')));
}

// The newest map dump next to an output folder (maps/map-<sha>.json)
function findMap(dir) {
  for (let d = dir, i = 0; i < 4; i++, d = dirname(d)) {
    const maps = join(d, 'maps');
    if (!existsSync(maps)) continue;
    const files = readdirSync(maps).filter((f) => f.startsWith('map-') && f.endsWith('.json'));
    if (files.length) return join(maps, files.sort().pop());
  }
  return null;
}

// A still from the video at each failure moment: the frame's wall clock, against when the video started
function failureStills(runDir, run, trace, result) {
  const video = join(runDir, 'video.webm');
  if (!existsSync(video) || !run?.videoStartWall) return [];
  mkdirSync(join(runDir, 'failures'), { recursive: true });
  const stills = [];
  result.failures.slice(0, MAX_FAILURE_STILLS).forEach((fail, i) => {
    let frame = null;
    for (const f of trace.frames) if (!frame || Math.abs(f.t - fail.t) < Math.abs(frame.t - fail.t)) frame = f;
    if (!frame?.wall) return;
    const at = Math.max(0, (frame.wall - run.videoStartWall) / 1000);
    const file = `failures/${String(i + 1).padStart(2, '0')}-beat${fail.beat}.jpg`;
    // (written now: a still left by an earlier check of this run doesn't count)
    const grab = (seek) => {
      const before = Date.now() - 1000;
      try {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...seek, '-i', video, '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '3', join(runDir, file)], { stdio: 'pipe' });
      } catch {
        // (no frame there: the table still lists the failure)
      }
      return existsSync(join(runDir, file)) && statSync(join(runDir, file)).mtimeMs >= before;
    };
    // (a moment at the run's very end can fall past the video's last frame, where ffmpeg writes nothing: then the last
    // frame stands in)
    if (grab(['-ss', at.toFixed(2)]) || grab(['-sseof', String(-LAST_FRAME_SEEK)])) stills.push({ file, n: i + 1, label: fail.label, t: fail.t });
  });
  return stills;
}

async function checkRunDir(runDir, mapFile = null) {
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  const trace = JSON.parse(readFileSync(join(runDir, 'trace.json'), 'utf8'));
  const map = loadMap(mapFile ?? run.mapFile ?? findMap(runDir));
  // (where the injection put the car, for traces written before the runner logged it in the trace itself)
  if (run.injected && !trace.meta.injectedAt) trace.meta.injectedAt = { x: run.injected.x, z: run.injected.z };
  const result = checkTrace(trace, map);
  const failureShots = failureStills(runDir, run, trace, result);
  writeFileSync(join(runDir, 'verdict.json'), JSON.stringify({ ...result, scenario: run.scenario.name, sha: run.sha, failureShots }, null, 1));
  writeFileSync(join(runDir, 'report.html'), runPage({ result, trace, map, run, failureShots }));
  return result;
}

// A trace.json or a session .jsonl scored on its own, its page written to outDir
function checkFile(file, { mapFile, outDir, segment = 0 }) {
  const map = loadMap(mapFile);
  const trace = file.endsWith('.jsonl') ? toTrace(readSession(file), segment) : JSON.parse(readFileSync(file, 'utf8'));
  if (!trace) throw new Error(`${file}: no AI frames`);
  const result = checkTrace(trace, map);
  mkdirSync(outDir, { recursive: true });
  const name = basename(file).replace(/\.(jsonl|json)$/, '');
  writeFileSync(join(outDir, `${name}.verdict.json`), JSON.stringify(result, null, 1));
  writeFileSync(join(outDir, `${name}.html`), runPage({ result, trace, map, run: null, failureShots: [] }));
  return { result, page: join(outDir, `${name}.html`) };
}

export { checkFile, checkRunDir, findMap, loadMap };
