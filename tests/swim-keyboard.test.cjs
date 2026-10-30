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
  return { forward: 0, backward: 0, left: 0, right: 0, handbrake: 0, ...pressed };
}

// Drives `seconds` of keys (a function of time) from a car rolling at `speed`; returns the extremes, the time spent
// sliding past 20°, the gears used in the slide and the frames on the limiter.
function drive(speed, seconds, keysAt) {
  const car = { position: { x: 0, z: 0 }, heading: 0, speed, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0 };
  const telemetry = { slipAngle: 0, rearSlide: 0, wheelspin: 0, steer: 0, loadFront: 0, loadRear: 0, lateralAccel: 0 };
  const driver = new KeyboardDriver();
  const result = { car, maxSlip: 0, maxSpin: 0, maxSteer: 0, sliding: 0, slideGears: new Set(), limiter: 0 };
  for (let t = 0; t < seconds; t += FRAME) {
    const input = driver.update(car, keysAt(t), FRAME);
    result.maxSteer = Math.max(result.maxSteer, Math.abs(input.steer));
    for (let i = 0; i < STEPS; i++) stepDriftCar(car, input, FRAME / STEPS, M5_DRIFT, telemetry);
    result.maxSlip = Math.max(result.maxSlip, Math.abs(telemetry.slipAngle));
    result.maxSpin = Math.max(result.maxSpin, telemetry.wheelspin);
    if (Math.abs(telemetry.slipAngle) > 20 * RAD) {
      result.sliding += FRAME;
      result.slideGears.add(telemetry.gear);
    }
    if (telemetry.limiter) result.limiter++;
  }
  return result;
}

test('tapping A on the gas at 5, 10 and 15 m/s is a grip turn, not a drift', () => {
  for (const speed of [5, 10, 15]) {
    const tap = drive(speed, 2, (t) => keys({ forward: 1, left: t > 0.3 && t < 0.45 ? 1 : 0 }));
    assert.ok(tap.maxSlip < 6 * RAD, `${speed} m/s: body slip ${(tap.maxSlip / RAD).toFixed(1)}°`);
    assert.equal(tap.maxSpin, 0, `${speed} m/s: the traction control keeps the rears hooked up`);
    assert.ok(tap.car.heading > 0.5 * RAD, `${speed} m/s: the car still turns (${(tap.car.heading / RAD).toFixed(1)}°)`);

    const weave = drive(speed, 2.5, (t) => {
      const phase = t > 0.3 ? (t - 0.3) % 0.8 : 1;
      return keys({ forward: 1, left: phase < 0.15 ? 1 : 0, right: phase > 0.4 && phase < 0.55 ? 1 : 0 });
    });
    assert.ok(weave.maxSlip < 6 * RAD, `${speed} m/s weave: body slip ${(weave.maxSlip / RAD).toFixed(1)}°`);
  }
});

test('steering winds on while A is held: a tap nudges the wheel, a long hold reaches full lock', () => {
  const car = { position: { x: 0, z: 0 }, heading: 0, speed: 10, vx: 0, vz: 0, angularVel: 0, steerAngle: 0 };
  const driver = new KeyboardDriver();
  const hold = (seconds, pressed) => {
    let input;
    for (let t = 0; t < seconds - 1e-9; t += FRAME) input = driver.update(car, keys(pressed), FRAME);
    return input.steer;
  };
  const tap = hold(0.1, { left: 1 });
  assert.ok(tap > 0.05 && tap < 0.2, `a 0.1 s tap at 10 m/s: ${(tap * 100).toFixed(0)}% of the lock`);
  assert.ok(hold(0.4, {}) === 0, 'and the wheel centres again');
  assert.equal(hold(1, { left: 1 }), 1, 'a 1 s hold reaches full lock');
  const back = hold(0.4, { right: 1 });
  assert.ok(back < 0, `the opposite key swings it back across centre quickly: ${back.toFixed(2)} after 0.4 s`);
  hold(1, {});
  const slow = hold(0.5, { left: 1 });
  hold(1, {});
  car.speed = 30;
  const fast = hold(0.5, { left: 1 });
  assert.ok(fast < slow && fast > 0.45, `a little slower at speed, still quick enough to flick lanes: ${fast.toFixed(2)} vs ${slow.toFixed(2)}`);

  const pedal = new KeyboardDriver();
  assert.ok(pedal.update(car, keys({ forward: 1 }), FRAME).throttle < 0.1, 'the pedal is pressed');
});

test('the handbrake with gas at 15 m/s slides the car', () => {
  const run = drive(15, 2, (t) => keys({ forward: 1, left: t < 0.8 ? 1 : 0, handbrake: t < 0.4 ? 1 : 0 }));
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

test('gas and lock held hold a drift that picks up speed, widens and shifts up on the limiter', () => {
  const run = drive(12, 7, () => keys({ forward: 1, left: 1 }));
  assert.ok(run.sliding > 3, `${run.sliding.toFixed(1)} s past 20°`);
  assert.ok(run.maxSlip < 65 * RAD, `not spinning: ${(run.maxSlip / RAD).toFixed(0)}°`);
  const sideways = run.car.vx * Math.cos(run.car.heading) - run.car.vz * Math.sin(run.car.heading);
  const settled = Math.abs(Math.atan2(sideways, run.car.speed)) / RAD;
  assert.ok(settled > 25 && settled < 55, `and settles into a held angle: ${settled.toFixed(0)}°`);
  assert.ok(Math.hypot(run.car.speed, run.car.vx, run.car.vz) > 18, 'faster than it started');
  assert.ok(run.slideGears.size >= 2, `shifted while sliding: ${[...run.slideGears].join(', ')}`);
  assert.ok(run.limiter > 0, 'bouncing off the limiter');

  // Letting go of A with W still held lets the rear catch up and drives out straight
  const out = drive(12, 5.5, (t) => keys({ forward: 1, left: t < 3.5 ? 1 : 0 }));
  const lateral = out.car.vx * Math.cos(out.car.heading) - out.car.vz * Math.sin(out.car.heading);
  assert.ok(Math.abs(Math.atan2(lateral, out.car.speed)) < 12 * RAD, 'straightened');
});

test('at 100 mph a tap of the handbrake with gas and lock held holds a drift: the car does not push itself straight', () => {
  const run = drive(45, 6, (t) => keys({ forward: 1, left: 1, handbrake: t > 0.5 && t < 0.65 ? 1 : 0 }));
  assert.ok(run.sliding > 4, `${run.sliding.toFixed(1)} s past 20°`);
  assert.ok(run.maxSlip < 60 * RAD, `held, not spun: ${(run.maxSlip / RAD).toFixed(0)}°`);
});

test('at 67 mph a Scandinavian flick and a power-over both drift, and lifting off W straightens the car', () => {
  // A feint right on the gas, a lift into the left turn, a touch of handbrake, then back on the gas with the lock held
  const flick = drive(30, 6, (t) => keys({ forward: t < 0.5 || t >= 0.8 ? 1 : 0, right: t < 0.5 ? 1 : 0, left: t >= 0.5 ? 1 : 0, handbrake: t >= 0.8 && t < 1 ? 1 : 0 }));
  assert.ok(flick.sliding > 3, `flick: ${flick.sliding.toFixed(1)} s past 20°`);
  const power = drive(30, 6, () => keys({ forward: 1, left: 1 }));
  assert.ok(power.sliding > 3 && power.maxSpin > 0.5, `power-over: ${power.sliding.toFixed(1)} s past 20°, on wheelspin`);
  // Lifting with the counter-steer held: the rears grip and the car comes back straight, not round the other way
  const lift = drive(30, 6, (t) => keys({ forward: t < 3 ? 1 : 0, left: t < 3 ? 1 : 0, right: t >= 3 && t < 3.4 ? 1 : 0 }));
  const lateral = lift.car.vx * Math.cos(lift.car.heading) - lift.car.vz * Math.sin(lift.car.heading);
  assert.ok(Math.abs(Math.atan2(lateral, lift.car.speed)) < 10 * RAD, 'straight again');
});

test('the traction control launches an M3 Competition in its 0-60 time', () => {
  const car = { position: { x: 0, z: 0 }, heading: 0, speed: 0, vx: 0, vz: 0, angularVel: 0, steerAngle: 0 };
  const telemetry = { slipAngle: 0, wheelspin: 0 };
  const driver = new KeyboardDriver();
  let t = 0;
  while (car.speed < 60 * 0.44704 && t < 10) {
    const input = driver.update(car, keys({ forward: 1 }), FRAME);
    for (let i = 0; i < STEPS; i++) stepDriftCar(car, input, FRAME / STEPS, M5_DRIFT, telemetry);
    t += FRAME;
  }
  // (the tuned G80 M3 Competition xDrive: about 2.8 s; M xDrive pulls on all four in a straight line)
  assert.ok(t > 2.6 && t < 3.1, `0-60 mph in ${t.toFixed(2)} s`);
});

test('reset clears the held state between teleports', () => {
  const car = { position: { x: 0, z: 0 }, heading: 0, speed: 10, vx: 0, vz: 0, angularVel: 0, steerAngle: 0 };
  const driver = new KeyboardDriver();
  car.vx = -5.5; // sliding right at about 29°: a left drift
  for (let i = 0; i < 60; i++) driver.update(car, keys({ forward: 1, left: 1 }), FRAME);
  assert.equal(driver.commit, 1);
  driver.reset();
  assert.equal(driver.commit, 0);
  assert.equal(driver.steer, 0);
  assert.equal(driver.input.throttle, 0);
  assert.equal(driver.input.assist, 1);
});
