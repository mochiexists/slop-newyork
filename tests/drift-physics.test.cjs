const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const { M5_DRIFT, tireCurve, stepDriftCar, shiftUp, shiftDown, toggleManual } = loadModule(readFileSync(join(__dirname, '../js/drift-physics.js'), 'utf8'));

const DT = 1 / 240;
const RAD = Math.PI / 180;
const idle = { throttle: 0, brake: 0, reverse: 0, steer: 0, handbrake: 0 };

function car(speed = 0) {
  return { position: { x: 0, z: 0 }, heading: 0, speed, vx: 0, vz: 0, angularVel: 0, steerAngle: 0 };
}

// Runs `seconds` of input (an object, or a function of time) and returns every step's body slip angle.
function drive(c, seconds, input) {
  const slips = [];
  for (let t = 0; t < seconds; t += DT) {
    const tel = stepDriftCar(c, typeof input === 'function' ? input(t) : input, DT);
    slips.push(tel.slipAngle);
  }
  return slips;
}

test('the tire curve peaks at its slip angle and keeps sliding grip past it', () => {
  assert.equal(tireCurve(0, M5_DRIFT), 0);
  assert.ok(Math.abs(tireCurve(M5_DRIFT.peakSlip, M5_DRIFT) - 1) < 1e-9);
  assert.ok(tireCurve(M5_DRIFT.peakSlip * 0.5, M5_DRIFT) > 0.7);
  const far = tireCurve(60 * RAD, M5_DRIFT);
  assert.ok(far < 0.95 && far >= M5_DRIFT.slideGrip, `sliding grip ${far}`);
  assert.equal(tireCurve(-0.3, M5_DRIFT), -tireCurve(0.3, M5_DRIFT));
});

test('full throttle on all four (xDrive) reaches 100 km/h in a tuned M3 Competition\'s time through the gears to its 220 mph limiter', () => {
  const c = car();
  let t = 0;
  while (c.speed < 100 / 3.6 && t < 10) {
    stepDriftCar(c, { ...idle, throttle: 1 }, DT);
    t += DT;
  }
  assert.ok(t > 2.4 && t < 2.9, `0-100 km/h in ${t.toFixed(2)} s`);
  const rearOnly = car();
  for (t = 0; rearOnly.speed < 100 / 3.6 && t < 10; t += DT) stepDriftCar(rearOnly, { ...idle, throttle: 1, xDrive: 0 }, DT);
  assert.ok(t > 3.1 && t < 3.7, `and on the rears alone (xDrive open) in ${t.toFixed(2)} s`);
  assert.equal(c.gear, 3);
  assert.equal(c.heading, 0);
  drive(c, 40, { ...idle, throttle: 1 });
  // (1,100 Nm pulls 8th past the drag to the limiter; 850 Nm ran out of shove just short of it)
  assert.ok(c.speed > 85 && c.speed < M5_DRIFT.topSpeed + 0.1, `top speed ${c.speed}`);
  assert.ok(c.gear >= 7, `in gear ${c.gear}`);
});

test('the automatic shifts up through the box and back down when the car slows, and manual holds the gear', () => {
  const c = car();
  const gears = new Set();
  for (let t = 0; t < 8; t += DT) gears.add(stepDriftCar(c, { ...idle, throttle: 1 }, DT).gear);
  assert.deepEqual([...gears].slice(0, 4), [1, 2, 3, 4]);
  drive(c, 3, { ...idle, brake: 0.6 });
  assert.ok(c.gear >= 3 && c.gear <= 6, `down to ${c.gear} braking to ${c.speed.toFixed(1)} m/s`);
  drive(c, 6, { ...idle, brake: 1 });
  assert.equal(c.gear, 1, 'and to first at a stop');

  const manual = car(10);
  assert.equal(toggleManual(manual), true);
  let telemetry;
  let limited = 0;
  for (let t = 0; t < 4; t += DT) {
    telemetry = stepDriftCar(manual, { ...idle, throttle: 1 }, DT);
    if (telemetry.limiter) limited++;
  }
  assert.equal(manual.gear, 1, 'manual holds first');
  assert.ok(limited > 0 && manual.rpm > 6500, 'on the limiter');
  assert.ok(manual.speed < 18, `first gear tops out at ${manual.speed.toFixed(1)} m/s`);
  assert.equal(shiftUp(manual), true);
  assert.equal(manual.gear, 2);
  drive(manual, 2, { ...idle, throttle: 1 });
  assert.ok(manual.speed > 18, 'second pulls on');
  assert.equal(shiftDown(manual), false, 'a downshift that would over-rev is refused');
  assert.equal(manual.gear, 2);
  assert.equal(toggleManual(manual), false);
});

test('braking stops from 100 km/h in under 40 m and the brake holds a stopped car', () => {
  const c = car(100 / 3.6);
  drive(c, 4, { ...idle, brake: 1 });
  assert.equal(c.speed, 0);
  assert.ok(c.position.z > 25 && c.position.z < 40, `stopping distance ${c.position.z}`);
  drive(c, 1, { ...idle, brake: 1 });
  assert.equal(c.speed, 0);
});

test('plain cornering grips instead of sliding', () => {
  const c = car(15);
  // A gentle 12% of the tuned engine's power: enough to hold speed through the corner without lighting the rears
  const slips = drive(c, 3, { ...idle, throttle: 0.12, steer: 0.5 });
  assert.ok(Math.max(...slips.map(Math.abs)) < 6 * RAD, 'part-throttle corner stays under 6° of slip');
  assert.ok(c.heading > 1, 'the car turns left');

  const lift = car(25);
  const liftSlips = drive(lift, 2, { ...idle, steer: 1 });
  assert.ok(Math.max(...liftSlips.map(Math.abs)) < 12 * RAD, 'full lock at speed off the throttle stays tidy');
});

test('a handbrake flick into throttle holds a drift, and letting go straightens it out', () => {
  const c = car(20);
  const slips = drive(c, 6, (t) => {
    if (t < 0.5) return { ...idle, steer: 1, handbrake: 1 };
    if (t < 3.5) return { ...idle, throttle: 0.75, steer: 0.35 };
    return { ...idle, throttle: 0.2 };
  });
  const at = (seconds) => slips[Math.round(seconds / DT)];
  // A left-hand drift: the car points inside its path, so the velocity is to its right (negative slip)
  for (const t of [1, 1.5, 2]) {
    assert.ok(at(t) < -25 * RAD, `drifting at ${t} s: ${(at(t) / RAD).toFixed(1)}°`);
  }
  assert.ok(Math.min(...slips) > -80 * RAD, 'the assist stops the slide becoming a spin');
  assert.ok(Math.abs(at(5.9)) < 3 * RAD, `recovered: ${(at(5.9) / RAD).toFixed(1)}°`);
  assert.ok(c.speed > 15, 'still moving on after the drift');
});

test('power oversteer from low speed is caught by the counter-steer assist', () => {
  const c = car(10);
  // (at full lock the keyboard driver has xDrive's centre clutch open: the rears take the drive)
  const slips = drive(c, 4, { ...idle, throttle: 1, steer: 1, xDrive: 0 });
  assert.ok(Math.min(...slips) < -25 * RAD, 'full throttle at full lock steps the tail out');
  assert.ok(Math.min(...slips) > -80 * RAD, 'without spinning round');
  assert.ok(c.speed > 8, 'and keeps driving');
});

test('a burnout spins the rears on the spot, and letting the brake go launches the car', () => {
  const c = car();
  let tel;
  for (let t = 0; t < 2; t += DT) tel = stepDriftCar(c, { ...idle, throttle: 1, burnout: 1 }, DT);
  assert.equal(c.speed, 0);
  assert.equal(c.position.z, 0);
  assert.equal(tel.wheelspin, 1);
  assert.ok(tel.rearSlide > 10, 'enough tire slide for smoke and rubber');
  drive(c, 1, { ...idle, throttle: 1 });
  assert.ok(c.speed > 7, `launched to ${c.speed.toFixed(1)} m/s`);
});

test('wheelspin builds through the driveline inertia and dies away after a lift', () => {
  const c = car(10);
  const rearDrive = { ...idle, throttle: 1, xDrive: 0 };
  const first = stepDriftCar(c, rearDrive, DT).wheelspin;
  assert.ok(first < 0.1, `one step of full throttle spins the rears up only a little: ${first}`);
  let t = 0;
  while (stepDriftCar(c, rearDrive, DT).wheelspin < 1 && t < 1) t += DT;
  assert.ok(t > 0.05 && t < 0.3, `full wheelspin after ${t.toFixed(3)} s`);
  t = 0;
  while (stepDriftCar(c, idle, DT).wheelspin > 0 && t < 1) t += DT;
  assert.ok(t > 0.02 && t < 0.3, `the tires grip again ${t.toFixed(3)} s after the lift`);
  assert.ok(c.wheelSlip < M5_DRIFT.peakSlipRatio * c.speed, `rolling with the road (${c.wheelSlip.toFixed(2)} m/s)`);
});

test('a burnout bounces the engine off the limiter', () => {
  const c = car();
  let limited = 0;
  let telemetry;
  for (let t = 0; t < 3; t += DT) {
    telemetry = stepDriftCar(c, { ...idle, throttle: 1, burnout: 1 }, DT);
    if (t > 2 && telemetry.limiter) limited++;
  }
  assert.ok(limited * DT > 0.1 && limited * DT < 0.9, `on the cut ${(limited * DT).toFixed(2)} s of the last second`);
  assert.ok(telemetry.rpm > 6000, `revs ${telemetry.rpm.toFixed(0)}`);
});

test('reverse is limited and steering a stopped car does not spin it', () => {
  const c = car();
  drive(c, 4, { ...idle, reverse: 1 });
  assert.ok(c.speed < -8 && c.speed >= -M5_DRIFT.reverseSpeed - 0.2, `reverse speed ${c.speed}`);
  const parked = car();
  drive(parked, 2, { ...idle, steer: 1 });
  assert.equal(parked.heading, 0);
  assert.equal(parked.position.x, 0);
});

test('the step keeps the controller state convention (sideways world velocity, + yaw turns left)', () => {
  const c = car(12);
  c.heading = 0.7;
  drive(c, 0.5, { ...idle, steer: 1 });
  const left = { x: Math.cos(c.heading), z: -Math.sin(c.heading) };
  const forward = { x: Math.sin(c.heading), z: Math.cos(c.heading) };
  // vx/vz carry only the sideways part of the velocity
  assert.ok(Math.abs(c.vx * forward.x + c.vz * forward.z) < 1e-9);
  assert.ok(Math.abs(c.vx * left.z - c.vz * left.x) < 1e-9);
  assert.ok(c.angularVel > 0 && c.heading > 0.7);
});
