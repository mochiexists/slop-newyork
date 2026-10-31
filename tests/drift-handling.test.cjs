// The drift as the player drives it on the keys (W/A/S/D/Space through the KeyboardDriver): the key into the turn
// holds and tightens a big drift with the wheels pointing into the turn, no key lets the wheels self-align and the gas
// carry the drift, the opposite key or a lift ends it without a tank-slapper, and the gearbox holds its gear.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const { M5_DRIFT, KeyboardDriver, stepDriftCar } = loadModule(readFileSync(join(__dirname, '../js/drift-physics.js'), 'utf8'));

const FRAME = 1 / 60;
const STEPS = 4;
const RAD = Math.PI / 180;

function keys(held) {
  return { forward: held.includes('W') ? 1 : 0, backward: 0, left: held.includes('A') ? 1 : 0, right: held.includes('D') ? 1 : 0, handbrake: held.includes('_') ? 1 : 0 };
}

// Plays [seconds, keys] steps from a car rolling at `speed`; a row per frame: time, the drift angle (+ a left drift,
// tail out to the right), the front wheels (+ left of the car), speed, gear, yaw rate and the position
function play(speed, script) {
  const car = { position: { x: 0, z: 0 }, heading: 0, speed, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0, drift: {} };
  const driver = new KeyboardDriver();
  const rows = [];
  let t = 0;
  for (const [seconds, held] of script) {
    for (const end = t + seconds; t < end - 1e-9; t += FRAME) {
      const input = driver.update(car, keys(held), FRAME);
      for (let i = 0; i < STEPS; i++) stepDriftCar(car, input, FRAME / STEPS, M5_DRIFT, car.drift);
      const lateral = car.vx * Math.cos(car.heading) - car.vz * Math.sin(car.heading);
      rows.push({ t, angle: -Math.atan2(lateral, Math.abs(car.speed)) / RAD, wheels: car.steerAngle / RAD, speed: Math.hypot(car.speed, car.vx, car.vz),
        gear: car.gear, yaw: car.angularVel / RAD, x: car.position.x, z: car.position.z, course: car.heading + Math.atan2(lateral, car.speed) });
    }
  }
  return rows;
}

const between = (rows, from, to) => rows.filter((r) => r.t >= from && r.t < to);

// Radius of the path over a span: distance travelled over the change of course
function radius(rows) {
  let distance = 0;
  for (let i = 1; i < rows.length; i++) distance += Math.hypot(rows[i].x - rows[i - 1].x, rows[i].z - rows[i - 1].z);
  return distance / Math.abs(rows.at(-1).course - rows[0].course);
}

// From `from`: when the angle has been under 5° for 0.3 s, and the most it swung past straight the other way
function exit(rows, from, side) {
  const span = rows.filter((r) => r.t >= from);
  const calm = span.findIndex((_, i) => span.slice(i, i + 18).length === 18 && span.slice(i, i + 18).every((r) => Math.abs(r.angle) < 5));
  const overshoot = Math.max(0, ...span.filter((r) => r.t < from + 2.5).map((r) => -side * r.angle));
  const crossing = span.find((r) => Math.abs(r.angle) < 5);
  return { calmAfter: calm < 0 ? Infinity : span[calm].t - from, overshoot, crossingYaw: Math.abs(crossing?.yaw ?? 0) };
}

// The brief's drift: on the gas from 50 mph to ~90, a touch of A, A with a Space tap, then A held
const ENTRY = [[3, 'W'], [0.3, 'WA'], [0.25, 'WA_']];
const HELD_FROM = 3.55;

test('holding W and A in a big 90 mph drift keeps it sideways and tightens the line, the wheels pointing left', () => {
  const rows = play(22, [...ENTRY, [7, 'WA']]);
  const held = between(rows, HELD_FROM, HELD_FROM + 7);
  const sideways = held.filter((r) => r.angle > 20).length * FRAME;
  assert.ok(sideways >= 5, `sideways past 20° for ${sideways.toFixed(1)} s`);
  assert.ok(Math.max(...held.map((r) => r.angle)) < 65, 'without spinning (the handbrake entry at 90 mph is caught at the limit)');
  const left = held.filter((r) => r.wheels > 0).length / held.length;
  assert.ok(left > 0.8, `the front wheels point left of the car ${(left * 100).toFixed(0)}% of the time`);
  // the fronts scrub speed into a tighter circle, rather than the car sliding on straight and gaining speed
  const early = radius(between(rows, HELD_FROM, HELD_FROM + 2)), late = radius(between(rows, HELD_FROM + 5, HELD_FROM + 7));
  assert.ok(late < early * 0.6, `the line tightens: ${early.toFixed(0)} m -> ${late.toFixed(0)} m`);
  assert.ok(held.at(-1).speed < held[0].speed, 'scrubbing speed, not gaining it');

  // and mirrored: D holds a right drift the same way
  const right = between(play(22, [[3, 'W'], [0.3, 'WD'], [0.25, 'WD_'], [7, 'WD']]), HELD_FROM, HELD_FROM + 7);
  assert.ok(right.filter((r) => r.angle < -20).length * FRAME >= 5, 'a right drift held as long');
  assert.ok(right.filter((r) => r.wheels < 0).length / right.length > 0.8, 'with the wheels pointing right');
});

test('the gearbox holds its gear through a slide', () => {
  const rows = play(22, [...ENTRY, [7, 'WA']]);
  const slideGears = new Set(rows.filter((r) => Math.abs(r.angle) > 20).map((r) => r.gear));
  // it may come down a gear as the drift slows, never up
  const gears = rows.filter((r) => Math.abs(r.angle) > 20).map((r) => r.gear);
  assert.ok(gears.every((g, i) => i === 0 || g <= gears[i - 1]), `no upshift mid-slide: ${[...slideGears].join(', ')}`);
});

test('with no steering key the wheels self-align and the gas carries a big drift, wide and fast', () => {
  const rows = play(18, [...ENTRY, [2, 'WA'], [6, 'W']]);
  const free = between(rows, 6, 11.5);
  assert.ok(free.every((r) => r.angle > 20 && r.angle < 45), `held between 20° and 45°: ${Math.min(...free.map((r) => r.angle)).toFixed(0)}..${Math.max(...free.map((r) => r.angle)).toFixed(0)}°`);
  // counter-steered: the wheels point along the front axle's path, right of the car in a left drift
  assert.ok(free.every((r) => r.wheels < -10), 'the wheels run out to the counter-steer by themselves');
  const r = radius(free);
  assert.ok(r > 60 && r < 140, `a big circle: ${r.toFixed(0)} m`);
  assert.ok(Math.min(...free.map((x) => x.speed)) > 25, 'at speed');
});

test('the opposite key or a lift ends a drift in about a second and a half, without a tank-slapper', () => {
  const settled = { 'A held': [...ENTRY, [4, 'WA']], 'no key': [...ENTRY, [2, 'WA'], [3, 'W']] };
  for (const [name, entry] of Object.entries(settled)) {
    const start = entry.reduce((sum, [seconds]) => sum + seconds, 0);
    for (const out of ['WD', 'D', '']) {
      const rows = play(18, [...entry, [1.5, out], [2.5, 'W']]);
      const side = Math.sign(rows.find((r) => r.t >= start).angle);
      assert.equal(side, 1, `${name}: drifting left before the exit`);
      const { calmAfter, overshoot, crossingYaw } = exit(rows, start, side);
      const label = `${name}, then ${out || 'no keys'}`;
      assert.ok(calmAfter < 1.8, `${label}: straight after ${calmAfter.toFixed(2)} s`);
      assert.ok(overshoot < 8, `${label}: ${overshoot.toFixed(1)}° past straight the other way`);
      assert.ok(crossingYaw < 50, `${label}: swinging through straight at ${crossingYaw.toFixed(0)}°/s`);
      const after = between(rows, start + 2.5, start + 4);
      assert.ok(after.every((r) => Math.abs(r.angle) < 5), `${label}: and stays straight on the gas`);
    }
  }
});

test('a tight donut from a standstill keeps going round on W and A', () => {
  const rows = play(0, [[1, 'WA'], [0.3, 'WA_'], [8, 'WA']]);
  const donut = between(rows, 2, 9.3);
  assert.ok(donut.filter((r) => r.angle > 20).length * FRAME > 6, 'sideways nearly all the time');
  assert.ok(radius(donut) < 12, `round a tight circle: ${radius(donut).toFixed(1)} m`);
});

test('a lift and a handbrake tap as the car swings through straight carry a left drift into a right one', () => {
  const rows = play(18, [...ENTRY, [3, 'WA'], [1, 'D'], [0.3, 'WD_'], [2.7, 'WD']]);
  const after = between(rows, 9.5, 10.6);
  assert.ok(after.every((r) => r.angle < -20), `drifting right: ${Math.max(...after.map((r) => r.angle)).toFixed(0)}°`);
});
