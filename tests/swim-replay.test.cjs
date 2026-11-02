const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const { readSession, replayPlan } = require('../tools/swim-replay/session.cjs');
const { compare } = require('../tools/swim-replay/trajectory.cjs');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const recorderModule = loadModule(read('js/session-recorder.js'));

// A session as the recorder posts it: two runs, the second with an event, flushed in two chunks
function recordSession(dir) {
  const posts = [];
  const recorder = new recorderModule.SessionRecorder({ now: () => 0, post: (body) => posts.push(body) });
  const car = { position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 1, vx: 0, vz: 0, angularVel: 0, drift: {} };
  let tick = 0;
  const step = (player) => {
    recorder.frame(car, { forward: player & 1 }, 1 / 120, null, false, player, tick++);
    car.position.z += 0.01;
  };
  recorder.run({ tick, seed: 1, x: 0, z: 0, reason: 'start', elapsed: 3 }, car, null);
  for (let i = 0; i < 5; i++) step(0);
  recorder.run({ tick, seed: 9, x: 0, z: 0.05, reason: 'teleport', elapsed: 3.04 }, car, null);
  step(1);
  recorder.flush();
  recorder.event('manual', tick);
  step(1);
  step(5);
  recorder.flush();
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, posts.join('\n'));
  return { file, recorder };
}

test('a recorded session reads back as its runs: the last by default, its keys and events tick by tick', () => {
  const dir = mkdtempSync(join(__dirname, '.tmp-replay-'));
  try {
    const { file, recorder } = recordSession(dir);
    const session = readSession(file);
    assert.equal(session.frames.length, 8);
    assert.deepEqual(session.runs.map((r) => [r.index, r.reason]), [[0, 'start'], [5, 'teleport']]);
    const plan = replayPlan(session);
    assert.equal(plan.number, 1);
    assert.equal(plan.start.seed, 9);
    assert.equal(plan.start.elapsed, 3.04);
    assert.deepEqual(plan.keys, [1, 1, 5]);
    assert.deepEqual(plan.events, [[1, 'manual']], 'the event before the run\'s second tick');
    assert.equal(plan.recorded.length, 3);
    assert.equal(plan.recorded[1][0], 1 / 120, 'the ticks\' own times, not the rounded dt');
    const first = replayPlan(session, 0);
    assert.deepEqual(first.keys, [0, 0, 0, 0, 0]);
    // the download reads the same
    const all = join(dir, 'all.json');
    writeFileSync(all, recorder.snapshot());
    assert.deepEqual(replayPlan(readSession(all)).keys, [1, 1, 5]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the trajectory check passes a run against itself and fails one a hair off, sample by sample on a fixed clock', () => {
  const samples = Array.from({ length: 50 }, (_, i) => [i / 120, i * 0.1, 2, 0, 5, 0, 0, 0, 0, 1]);
  const run = { samples };
  const same = compare(run, { samples: samples.map((s) => s.slice()) });
  assert.equal(same.sameClock, true);
  assert.equal(same.identical, 50);
  assert.equal(same.maxPosition, 0);
  const nudged = samples.map((s, i) => (i >= 30 ? [s[0], s[1] + 2e-6, ...s.slice(2)] : s.slice()));
  const off = compare(run, { samples: nudged });
  assert.ok(off.maxPosition > 1e-6);
  assert.equal(off.firstMicro, 30 / 120);
  // a frame clock's run is read at the reference's times
  const half = { samples: samples.filter((_, i) => i % 2 === 0).map((s) => s.slice()) };
  const read = compare(run, half);
  assert.equal(read.sameClock, false);
  assert.ok(read.maxPosition < 1e-12, 'a straight line interpolates exactly');
});
