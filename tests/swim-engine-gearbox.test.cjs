const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// The engine sound following the car's own gearbox (drift-physics.js): its gear, revs and limiter cuts
const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const physics = loadModule(read('js/drift-physics.js'));
const engine = loadModule(read('js/swim-engine.js'));
const { M3_ENGINE, createEngineState, stepEngine, readGearbox } = engine;

const FRAME = 1 / 60;
const SUBSTEPS = 4; // physics steps per frame, as controllers.js runs them
const pedals = { throttle: 0, brake: 0, reverse: 0, steer: 0, handbrake: 0, burnout: 0 };

function car(speed = 0) {
  return { position: { x: 0, z: 0 }, heading: 0, speed, vx: 0, vz: 0, angularVel: 0, steerAngle: 0 };
}

// Frames as the game runs them: the physics steps, then the sound reads the car and steps its engine
function play(c, state, seconds, input, log = []) {
  const engineInput = { speed: 0, throttle: 0, wheelspin: 0, slipAngle: 0 };
  for (let t = 0; t < seconds - 1e-9; t += FRAME) {
    let telemetry;
    for (let i = 0; i < SUBSTEPS; i++) telemetry = physics.stepDriftCar(c, input, FRAME / SUBSTEPS);
    engineInput.speed = c.speed;
    engineInput.throttle = input.throttle;
    engineInput.wheelspin = telemetry.wheelspin;
    engineInput.slipAngle = telemetry.slipAngle;
    readGearbox(c, engineInput);
    stepEngine(state, engineInput, FRAME);
    log.push({ carGear: c.gear, carRpm: c.rpm, carLimiter: c.limiterTime > 0, gear: state.gear, rpm: state.rpm,
      cut: state.cut, upshift: state.upshift, downshift: state.downshift, gearbox: state.gearbox });
  }
  return log;
}

test('each physics upshift is exactly one shift in the sound, in the same frame and to the same gear', () => {
  const log = play(car(), createEngineState(), 14, { ...pedals, throttle: 1 });
  const physicsShifts = log.filter((frame, i) => i > 0 && frame.carGear > log[i - 1].carGear).length;
  const soundShifts = log.filter((frame) => frame.upshift).length;
  assert.ok(physicsShifts >= 5, `${physicsShifts} physics upshifts`);
  assert.equal(soundShifts, physicsShifts);
  log.forEach((frame, i) => {
    assert.equal(frame.gear, frame.carGear - 1, 'the sound is in the physics gear');
    assert.equal(frame.upshift, i > 0 && frame.carGear > log[i - 1].carGear, `frame ${i}`);
    assert.equal(frame.downshift, false);
  });
});

test('the revs follow the physics, easing only through a shift', () => {
  const log = play(car(), createEngineState(), 10, { ...pedals, throttle: 1 });
  let sinceShift = 0; // (and from the launch, where the converter lets the physics revs jump at once)
  for (const frame of log) {
    sinceShift = frame.upshift ? 0 : sinceShift + FRAME;
    if (sinceShift > 0.2) {
      assert.ok(Math.abs(frame.rpm - frame.carRpm) < frame.carRpm * 0.05, `${frame.rpm.toFixed(0)} vs ${frame.carRpm.toFixed(0)}`);
    }
  }
  const state = createEngineState();
  for (let i = 0; i < 30; i++) stepEngine(state, { speed: 20, throttle: 0.5, gear: 3, rpm: 4321, limiter: false }, FRAME);
  assert.ok(Math.abs(state.rpm - 4321) < 1, `${state.rpm.toFixed(1)} rpm`);
  assert.equal(state.gear, 2);
});

test('the physics limiter is the sound\'s fuel cut, frame for frame, in a burnout and in a drift', () => {
  const burnout = play(car(), createEngineState(), 2, { ...pedals, throttle: 1, burnout: 1 });
  const held = burnout.slice(burnout.length / 2);
  held.forEach((frame) => assert.equal(frame.cut, frame.carLimiter));
  const bounces = held.filter((frame, i) => i > 0 && frame.cut && !held[i - 1].cut).length;
  assert.ok(bounces >= 5, `${bounces} limiter cuts in a second of burnout`);

  // A slide in a low gear: full throttle and steering with the handbrake flicked in
  const c = car(14);
  const state = createEngineState();
  play(c, state, 0.4, { ...pedals, throttle: 1, steer: 1, handbrake: 1 });
  const drift = play(c, state, 3, { ...pedals, throttle: 1, steer: 1 });
  drift.forEach((frame) => assert.equal(frame.cut, frame.carLimiter));
  // A cut set by hand, too
  const manual = createEngineState();
  stepEngine(manual, { speed: 10, throttle: 1, gear: 2, rpm: 7200, limiter: true }, FRAME);
  assert.equal(manual.cut, true);
  assert.equal(manual.limiting, true);
  stepEngine(manual, { speed: 10, throttle: 1, gear: 2, rpm: 6800, limiter: false }, FRAME);
  assert.equal(manual.cut, false);
});

test('manual shifts are heard; a refused downshift makes no sound', () => {
  const c = car();
  const state = createEngineState();
  play(c, state, 3, { ...pedals, throttle: 1 });
  physics.toggleManual(c);
  const gear = c.gear;
  assert.equal(physics.shiftUp(c), true);
  let [frame] = play(c, state, FRAME, { ...pedals, throttle: 1 });
  assert.equal(frame.upshift, true);
  assert.equal(frame.gear, gear);
  // Two gears down from here at speed would over-rev: the first goes through, the second is refused
  play(c, state, 0.5, { ...pedals, throttle: 1 });
  assert.equal(physics.shiftDown(c), true);
  [frame] = play(c, state, FRAME, { ...pedals, throttle: 1 });
  assert.equal(frame.downshift, true);
  play(c, state, 0.5, { ...pedals, throttle: 1 });
  const before = c.gear;
  while (physics.shiftDown(c)) { /* down to the lowest gear the speed allows */ }
  assert.ok(c.gear > 1, 'a refused downshift above first');
  const refusedAt = c.gear;
  play(c, state, 0.2, { ...pedals, throttle: 1 }); // the gears dropped so far are heard
  assert.equal(physics.shiftDown(c), false);
  const after = play(c, state, 0.5, { ...pedals, throttle: 1 });
  assert.ok(after.every((step) => !step.downshift && !step.upshift), 'nothing heard for a refused shift');
  assert.equal(c.gear, refusedAt);
  assert.ok(before >= refusedAt);
});

test('without gearbox fields the model shifts on its own, exactly as before', () => {
  const plain = createEngineState();
  const cleared = createEngineState();
  const input = (speed) => ({ speed, throttle: 1, wheelspin: 0.3, slipAngle: 0 });
  for (let i = 0; i < 600; i++) {
    const speed = i * 0.08;
    stepEngine(plain, input(speed), FRAME);
    stepEngine(cleared, { ...input(speed), gear: 0, rpm: NaN, limiter: false }, FRAME);
  }
  assert.deepEqual(cleared, plain);
  assert.equal(plain.gearbox, false);
  assert.ok(plain.gear >= 3, `the model's own gear ${plain.gear + 1}`);
  // A car without a gearbox leaves the input without one
  const engineInput = { speed: 5, throttle: 1, gear: 3, rpm: 5000, limiter: true };
  assert.equal(readGearbox(car(5), engineInput), false);
  assert.equal(engineInput.gear, 0);
  assert.ok(Number.isNaN(engineInput.rpm));
  assert.equal(engineInput.limiter, false);
});

test('a car that gets its gearbox back (a reset clears car.gear) is taken over without a shift sound', () => {
  const c = car();
  const state = createEngineState();
  play(c, state, 6, { ...pedals, throttle: 1 });
  c.gear = 0; // controllers.js on a reset: the automatic picks the gear for the speed again
  const engineInput = { speed: c.speed, throttle: 1, wheelspin: 0, slipAngle: 0 };
  assert.equal(readGearbox(c, engineInput), false);
  stepEngine(state, engineInput, FRAME);
  assert.equal(state.gearbox, false);
  const [frame] = play(c, state, FRAME, { ...pedals, throttle: 1 });
  assert.equal(frame.gearbox, true);
  assert.equal(frame.gear, frame.carGear - 1);
  assert.equal(frame.upshift || frame.downshift, false);
});

test('the gearbox reads stay inside the model\'s engine', () => {
  // Every physics rpm the sound can follow sits within the loops' range the voices map from idle to limiter
  const log = play(car(), createEngineState(), 6, { ...pedals, throttle: 1, burnout: 1 });
  for (const frame of log) assert.ok(frame.rpm >= M3_ENGINE.idle * 0.9 && frame.rpm <= M3_ENGINE.limiter + 200);
});
