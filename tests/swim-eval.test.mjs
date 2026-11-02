// Swimming in Slop: the show's eval harness (tools/swim-eval). Its checker is a test of the show, so it is tested
// here: every beat check passes a made-up ideal show and fails each deliberate break of it, the map tells the plaza
// from the road where the show starts, the session reader finds musa's launch, and main.js still has the lines the
// runner hooks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkTrace } from '../tools/swim-eval/lib/check.mjs';
import { COP, SHOW_SPOT, kasaFit } from '../tools/swim-eval/lib/geometry.mjs';
import { SwimMap } from '../tools/swim-eval/lib/map.mjs';
import { MAIN_HOOKS, rewriteMain } from '../tools/swim-eval/lib/runner.mjs';
import { launchFamily, turned } from '../tools/swim-eval/lib/scenarios.mjs';
import { toTrace } from '../tools/swim-eval/lib/session.mjs';
import { selftest } from '../tools/swim-eval/selftest.mjs';

const fixture = JSON.parse(readFileSync(new URL('../tools/swim-eval/test/map-fixture.json', import.meta.url), 'utf8'));

test('every beat check passes the ideal show and fails its own break', () => {
  const { rows, ok } = selftest(fixture);
  for (const row of rows) assert.ok(row.ok, `${row.name}: beat ${row.beat} gave ${row.got}`);
  assert.ok(ok);
  assert.ok(rows.length > 8);
});

test('the show starts on the Times Square plaza, 13 m off 7th Ave, by the game\'s own map', () => {
  const map = new SwimMap(fixture);
  assert.equal(map.classify(SHOW_SPOT.x, SHOW_SPOT.z), 'plaza');
  assert.equal(map.classify(-584.8, SHOW_SPOT.z), 'road');
  assert.equal(map.street(SHOW_SPOT.x, SHOW_SPOT.z).name, '7th Ave');
  // (the plaza port against the page's own plaza footprints: the fixture keeps the ones round the show's path)
  assert.ok(map.plazaCheck().matchedFootprints >= 3, 'the plaza pieces match footprints of the page');
});

test('the footprint sees a kerb corner inside the car\'s box (Codex round 1\'s pose at 8th Ave & 42nd St)', () => {
  const map = new SwimMap(fixture);
  assert.ok(map.footprint(-869.2117, 9.9556, 0.95144).includes('pavement'));
  // (round 2's: the kerb corner pokes in between the outline's points, caught by the corner-in-box test)
  assert.ok(map.footprint(-869.45432, 9.234603, 0.95144).includes('pavement'));
  assert.deepEqual([...new Set(map.footprint(-584.8, -200, 0))], ['road']);
});

test('the Kasa fit finds a circle', () => {
  const pts = Array.from({ length: 50 }, (_, i) => [3 + 10 * Math.sin(i / 8), -4 + 10 * Math.cos(i / 8)]);
  const fit = kasaFit(pts);
  assert.ok(Math.abs(fit.cx - 3) < 1e-6 && Math.abs(fit.cz + 4) < 1e-6 && Math.abs(fit.r - 10) < 1e-6);
});

test('a session is read back into roll, launch and donuts', () => {
  const frame = (t, x, z, speed, keys, slip = 0) => ({
    t, dt: 0.02, ai: 1, x, z, heading: 0, speed, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, slipAngle: slip, wheelspin: 0,
    gear: 1, forward: keys.includes('W') ? 1 : 0, backward: 0, left: keys.includes('A') ? 1 : 0, right: 0, handbrake: 0, camera: 'chase'
  });
  const frames = [];
  for (let i = 0; i < 200; i++) frames.push(frame(i * 0.02, SHOW_SPOT.x, SHOW_SPOT.z + i * 0.08, Math.min(4, i * 0.1), i < 20 ? 'W' : ''));
  for (let i = 0; i < 100; i++) frames.push(frame(4 + i * 0.02, SHOW_SPOT.x, SHOW_SPOT.z + 16 + i * 0.1, 5 + i * 0.05, 'WA', i > 30 ? -0.6 : 0));
  const trace = toTrace({ path: 'test', session: 'test', frames, drivers: new Map() });
  assert.equal(trace.frames[0].phase, 'roll');
  assert.equal(trace.frames[200].phase, 'donuts');
  assert.equal(trace.frames[199].phase, 'roll');
  assert.equal(trace.frames[290].dp, 'drift');
  assert.deepEqual(trace.cop, COP);
});

test('the bad launches keep the car\'s ground velocity and turn or move it as named', () => {
  const family = launchFamily();
  const musa = family['launch-musa'];
  const ground = (s) => Math.hypot(Math.sin(s.heading) * s.speed + s.vx, Math.cos(s.heading) * s.speed + s.vz);
  for (const name of ['launch-overrotated', 'launch-spun', 'launch-close', 'launch-far']) {
    assert.ok(Math.abs(ground(family[name]) - ground(musa)) < 1e-9, name);
  }
  assert.ok(Math.abs(family['launch-spun'].slipAngle) > Math.PI / 2, 'spun past 90°');
  assert.ok(Math.abs(Math.hypot(family['launch-close'].x - COP.x, family['launch-close'].z - COP.z) - 5.5) < 1e-9);
  // (to the recorder's rounding: its speed and sideways velocity were stored to 4 decimals, so not quite square)
  const back = turned(turned(musa, 0.3), -0.3);
  assert.ok(Math.abs(back.speed - musa.speed) < 1e-4 && Math.abs(back.vx - musa.vx) < 1e-4);
});

test('main.js still has every line the eval runner hooks, once', () => {
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const { body, applied } = rewriteMain(main);
  assert.equal(applied.length, MAIN_HOOKS.length);
  assert.ok(body.includes('globalThis.__swim = new SwimDirector'));
});
