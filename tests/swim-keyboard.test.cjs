const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const { M5_DRIFT, KeyboardDriver, stepDriftCar } = loadModule(readFileSync(join(__dirname, '../js/drift-physics.js'), 'utf8'));

// The controllers' swim loop: one keyboard frame at 60 Hz, then the physics in 240 Hz steps
const FRAME = 1 / 60;
const STEPS = 4;
const RAD = Math.PI / 180;

function keys(pressed = {}) {
  return { forward: 0, backward: 0, left: 0, right: 0, up: 0, ...pressed };
}

// Drives `seconds` of keys (a function of time) from a car rolling at `speed`; returns the extremes and when the
// driver asked for the drift circle.
function drive(speed, seconds, keysAt) {
  const car = { position: { x: 0, z: 0 }, heading: 0, speed, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0 };
  const telemetry = { slipAngle: 0, rearSlide: 0, wheelspin: 0, steer: 0, loadFront: 0, loadRear: 0, lateralAccel: 0 };
  const driver = new KeyboardDriver();
  const result = { car, maxSlip: 0, maxSpin: 0, maxSteer: 0, circleAt: null };
  for (let t = 0; t < seconds; t += FRAME) {
    const input = driver.update(car, telemetry, keysAt(t), FRAME);
    if (driver.driftCircle && result.circleAt === null) result.circleAt = t;
    result.maxSteer = Math.max(result.maxSteer, Math.abs(input.steer));
    for (let i = 0; i < STEPS; i++) stepDriftCar(car, input, FRAME / STEPS, M5_DRIFT, telemetry);
    result.maxSlip = Math.max(result.maxSlip, Math.abs(telemetry.slipAngle));
    result.maxSpin = Math.max(result.maxSpin, telemetry.wheelspin);
  }
  return result;
}

test('tapping A on the gas at 5, 10 and 15 m/s is a grip turn, not a drift', () => {
  for (const speed of [5, 10, 15]) {
    const tap = drive(speed, 2, (t) => keys({ forward: 1, left: t > 0.3 && t < 0.45 ? 1 : 0 }));
    assert.ok(tap.maxSlip < 6 * RAD, `${speed} m/s: body slip ${(tap.maxSlip / RAD).toFixed(1)}°`);
    assert.equal(tap.circleAt, null, `${speed} m/s: no drift circle`);
    assert.equal(tap.maxSpin, 0, `${speed} m/s: the traction control keeps the rears hooked up`);
    assert.ok(tap.car.heading > 2 * RAD, `${speed} m/s: the car still turns`);

    const weave = drive(speed, 2.5, (t) => {
      const phase = t > 0.3 ? (t - 0.3) % 0.8 : 1;
      return keys({ forward: 1, left: phase < 0.15 ? 1 : 0, right: phase > 0.4 && phase < 0.55 ? 1 : 0 });
    });
    assert.ok(weave.maxSlip < 6 * RAD, `${speed} m/s weave: body slip ${(weave.maxSlip / RAD).toFixed(1)}°`);
    assert.equal(weave.circleAt, null);
  }
});

test('the wheel turns in over a fraction of a second, slower at speed, and the pedal is pressed, not switched', () => {
  const slow = drive(2, 0.15, () => keys({ left: 1 }));
  const fast = drive(25, 0.15, () => keys({ left: 1 }));
  assert.ok(slow.maxSteer > 0.6 && slow.maxSteer < 0.85, `0.15 s of A at a crawl: ${slow.maxSteer.toFixed(2)}`);
  assert.ok(fast.maxSteer < 0.35, `0.15 s of A at 25 m/s: ${fast.maxSteer.toFixed(2)}`);

  const car = { position: { x: 0, z: 0 }, heading: 0, speed: 10, vx: 0, vz: 0, angularVel: 0, steerAngle: 0 };
  const driver = new KeyboardDriver();
  assert.ok(driver.update(car, { slipAngle: 0 }, keys({ forward: 1 }), FRAME).throttle < 0.1);
});

test('the handbrake with gas at 15 m/s slides the car', () => {
  const run = drive(15, 2, (t) => keys({ forward: 1, left: t < 0.8 ? 1 : 0, up: t < 0.4 ? 1 : 0 }));
  assert.ok(run.maxSlip > 25 * RAD, `slide ${(run.maxSlip / RAD).toFixed(1)}°`);
});

test('full throttle and held lock at 20 m/s powers the tail out once the driver commits', () => {
  const run = drive(20, 2.5, (t) => keys({ forward: 1, left: t > 0.5 ? 1 : 0 }));
  assert.ok(run.maxSlip > 25 * RAD, `power oversteer ${(run.maxSlip / RAD).toFixed(1)}°`);
  assert.ok(run.maxSpin > 0.5, 'with the rears spinning');
});

test('a lift-off flick at 22 m/s throws the car into a drift the throttle holds', () => {
  const run = drive(22, 2.5, (t) => keys({ forward: t > 0.85 ? 1 : 0, left: t < 0.35 ? 1 : 0, right: t >= 0.35 && t < 2 ? 1 : 0 }));
  assert.ok(run.maxSlip > 25 * RAD, `flick ${(run.maxSlip / RAD).toFixed(1)}°`);
});

test('gas and full lock held through a slide at low speed still becomes the drift circle, but not on the spot', () => {
  const run = drive(8, 3, () => keys({ forward: 1, left: 1 }));
  assert.ok(run.circleAt !== null, 'a held slide becomes the drift circle');
  assert.ok(run.circleAt > 0.6, `only after a real slide: ${run.circleAt.toFixed(2)} s`);
  const pivot = drive(12, 2.5, (t) => keys({ forward: 1, left: 1, up: t < 0.5 ? 1 : 0 }));
  assert.ok(pivot.circleAt !== null && pivot.circleAt > 0.3, 'the handbrake kicks it off sooner');
});

test('the traction control launches as hard as the old wheelspin did', () => {
  const car = { position: { x: 0, z: 0 }, heading: 0, speed: 0, vx: 0, vz: 0, angularVel: 0, steerAngle: 0 };
  const telemetry = { slipAngle: 0, wheelspin: 0 };
  const driver = new KeyboardDriver();
  let t = 0;
  while (car.speed < 60 * 0.44704 && t < 10) {
    const input = driver.update(car, telemetry, keys({ forward: 1 }), FRAME);
    for (let i = 0; i < STEPS; i++) stepDriftCar(car, input, FRAME / STEPS, M5_DRIFT, telemetry);
    t += FRAME;
  }
  assert.ok(t > 2.5 && t < 2.9, `0-60 mph in ${t.toFixed(2)} s`);
});

test('reset clears the held state between teleports', () => {
  const car = { position: { x: 0, z: 0 }, heading: 0, speed: 10, vx: 0, vz: 0, angularVel: 0, steerAngle: 0 };
  const driver = new KeyboardDriver();
  for (let i = 0; i < 60; i++) driver.update(car, { slipAngle: -0.5 }, keys({ forward: 1, left: 1 }), FRAME);
  assert.ok(driver.driftCircle);
  driver.reset();
  assert.equal(driver.driftCircle, false);
  assert.equal(driver.input.throttle, 0);
  assert.equal(driver.input.assist, 1);
});
