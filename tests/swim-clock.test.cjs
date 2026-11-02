const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');

// The swim clock (swim-clock.js) with the real car step (swim-car.js stepSwim), drift model, keyboard driver and the
// show's AI, the scene's parts stubbed: the run of the AI show's opening, traced tick by tick, must be the same at any
// frame rate, where the frame loop it replaces (updateSwim stepping each frame's dt) is not.
let physics, swimCar, clockModule, show, traffic;
test.before(async () => {
  const config = await import('../js/city-config.js');
  const roam = await import('../js/swim-roam.js');
  const carriageway = await import('../js/swim-carriageway.js');
  physics = loadModule(read('js/drift-physics.js'));
  const autopilot = loadModule(read('js/drift-autopilot.js'), { imports: { './drift-physics.js': physics } });
  swimCar = loadModule(read('js/swim-car.js'), {
    imports: {
      'three/webgpu': {}, 'three/tsl': {}, './city-config.js': config, './drift-physics.js': physics, './tsl-materials.js': {},
      './cars.js': {}, './vehicle-lights.js': {}, './m5-body.js': { M5_BODY: { wheelRadius: 0.36 } }
    }
  });
  traffic = loadModule(read('js/swim-traffic.js'), { imports: { './swim-car.js': swimCar } });
  clockModule = loadModule(read('js/swim-clock.js'), {
    imports: { 'three/webgpu': {}, './swim-car.js': swimCar, './swim-traffic.js': traffic }
  });
  show = loadModule(read('js/swim-show.js'), {
    imports: {
      'three/webgpu': { Color: class { constructor() { this.r = this.g = this.b = 1; } } },
      './city-config.js': config, './cars.js': {}, './tsl-materials.js': {}, './drift-physics.js': physics,
      './drift-autopilot.js': autopilot, './vehicle-physics.js': {}, './swim-roam.js': roam,
      './swim-carriageway.js': carriageway
    }
  });
});

// A camera the clock places: position and lookAt are all the traffic's stand-in view needs here
function stubView() {
  return { position: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } }, lookAt() {} };
}

function makeCar(at) {
  const rotation = { x: 0, z: 0 };
  return {
    position: { x: at.x, y: 0, z: at.z }, heading: at.heading, cameraYaw: at.heading, speed: 0, vx: 0, vz: 0,
    angularVel: 0, steerAngle: 0, longAccel: 0, pitchVel: 0, rollVel: 0, heaveY: 0, heaveVel: 0, gear: 1, rpm: 800,
    manual: false, wheelSpin: 0, wheels: [], chassisPivot: { rotation, position: { y: 0 } },
    drift: { slipAngle: 0, rearSlide: 0, wheelspin: 0, rpm: 800, gear: 1 }
  };
}

// The game's pieces round the car: the controllers' keys, collisions and ground, a director whose step gathers
// nothing (no traffic here) and a traffic system that only takes the reseed
function makeWorld({ clocked = true } = {}) {
  const car = makeCar(show.SHOW_SPOT);
  const keys = { forward: false, backward: false, left: false, right: false, up: false };
  const controllers = {
    entities: { swim: car }, keys, swimPilot: null, swimDriver: new physics.KeyboardDriver(),
    resolveHorizontalCollision() {}, getGroundHeight: () => 0
  };
  const reseeds = [];
  const trafficSystem = { setClearZone() {}, releaseStaged() {}, reseed: (...args) => reseeds.push(args) };
  const cruiser = {
    car: { position: { x: 0, z: 0 } }, state: 'hidden',
    park(x, z) { Object.assign(this.car.position, { x, z }); this.state = 'parked'; }, chase() {}, giveUp() {}
  };
  const swimShow = new show.SwimShow({ controllerManager: controllers, cruiser, trafficSystem });
  const director = { traffic: trafficSystem, steps: 0, step() { this.steps++; } };
  if (clocked) {
    controllers.swimClock = new clockModule.SwimClock({ controllers, director, traffic: trafficSystem, view: stubView() });
  }
  return { car, controllers, swimShow, reseeds, director };
}

const SAMPLE = (car) => [car.position.x, car.position.z, car.heading, car.speed, car.drift.slipAngle, car.vx, car.vz, car.angularVel];

// Frame times: a steady rate, or musa's 2026-11-01 Mac (each frame 1/120 or 1/60 s, half and half, seeded)
function frames(rate, seed = 1) {
  if (rate !== 'mix') return () => 1 / rate;
  const random = traffic.seededRandom(seed);
  return () => (random() < 0.5 ? 1 / 120 : 1 / 60);
}

// The show's opening for `seconds`, the car's state at the start of every tick (or every frame, unclocked)
function runShow(rate, seconds, { clocked = true } = {}) {
  const world = makeWorld({ clocked });
  const { car, controllers, swimShow } = world;
  const trace = [];
  const recorder = { frame: (c) => trace.push(SAMPLE(c)) };
  controllers.swimRecorder = recorder;
  swimShow.start();
  const next = frames(rate);
  let elapsed = 0;
  let time = 0;
  while (time < seconds) {
    const dt = next();
    time += dt;
    if (clocked) {
      elapsed = controllers.swimClock.advance(dt, elapsed, 'swim');
      controllers.swimClock.endFrame();
    } else {
      swimCar.updateSwim(controllers, dt);
    }
  }
  return { trace, world };
}

test('the fixed clock steps whole ticks and carries what is left over to the next frame', () => {
  const clock = new clockModule.FixedClock(1 / 120);
  let ticks = 0;
  assert.equal(clock.advance(1 / 60, () => ticks++), 2);
  assert.equal(clock.advance(0.004, () => ticks++), 0);
  assert.ok(Math.abs(clock.alpha - 0.48) < 1e-9, `alpha ${clock.alpha}`);
  assert.equal(clock.advance(0.0044, () => ticks++), 1, 'the 4 ms left over and 4.4 ms more make a tick');
  assert.equal(ticks, 3);
  // a 120 Hz frame whose time the browser rounded a hair short still makes its tick
  const steady = new clockModule.FixedClock(1 / 120);
  let n = 0;
  for (let i = 0; i < 1000; i++) n += steady.advance((1000 / 120 - 1e-12) / 1000, () => {});
  assert.equal(n, 1000);
});

test('the AI show\'s opening is the same run tick for tick at 120, 60, 30, 144 Hz and a 120/60 mix', () => {
  const reference = runShow(120, 10).trace;
  assert.ok(reference.length >= 10 * 120 - 1, `${reference.length} ticks`);
  for (const rate of [60, 30, 144, 'mix']) {
    const { trace } = runShow(rate, 10);
    const n = Math.min(reference.length, trace.length);
    assert.ok(n >= 10 * 120 - 8, `${rate}: ${n} ticks compared`);
    for (let i = 0; i < n; i++) {
      assert.deepEqual(trace[i], reference[i], `${rate}: tick ${i} differs from 120 Hz's`);
    }
  }
});

test('the frame loop the clock replaces does not repeat its run across frame rates (the check above can fail)', () => {
  const at120 = runShow(120, 10, { clocked: false }).trace;
  const at60 = runShow(60, 10, { clocked: false }).trace;
  // the 60 Hz frames start at the same times as every other 120 Hz frame: compare the car there
  let apart = 0;
  for (let i = 0; i < at60.length && 2 * i < at120.length; i++) {
    apart = Math.max(apart, Math.hypot(at60[i][0] - at120[2 * i][0], at60[i][1] - at120[2 * i][1]));
  }
  assert.ok(apart > 0.01, `the frame loop at 60 and 120 Hz parts by ${apart.toFixed(4)} m`);
});

test('the show starts its run on the clock: the traffic reseeded once, from the show\'s seed, at the show\'s spot', () => {
  const { world } = runShow(60, 0.1);
  assert.equal(world.reseeds.length, 1);
  assert.deepEqual(world.reseeds[0], [1, show.SHOW_SPOT.x, show.SHOW_SPOT.z]);
  assert.equal(world.controllers.swimClock.run.reason, 'show');
  assert.ok(world.director.steps >= 12, 'the director steps every tick');
});

// Codex 2026-11-03 #7: elapsed summed tick by tick kept the page's history (P on a fresh page at 40 s and after a
// minute's warm-up at 100 s read 59.999999999998856 and 120.00000000001592 2400 ticks on: a light red in one run and
// green in the other). The show's run starts on SHOW_SIGNAL_TIME exactly, and every tick's clock is counted from there.
test('the show\'s run starts on its point in the signal cycle and reads the same clock tick for tick after any warm-up', () => {
  const clocks = (warmup) => {
    const world = makeWorld();
    const clock = world.controllers.swimClock;
    let elapsed = 0;
    // driving about before P, on uneven frames
    const next = frames('mix', 3);
    for (let time = 0; time < warmup;) {
      const dt = next();
      time += dt;
      elapsed = clock.advance(dt, elapsed, 'swim');
      clock.endFrame();
    }
    world.swimShow.start();
    world.controllers.swimPilot = null; // (the clock is the point here, not the AI's driving)
    const seen = [];
    for (let i = 0; i < 2400; i++) {
      elapsed = clock.advance(1 / 120, elapsed, 'swim');
      clock.endFrame();
      seen.push(elapsed);
    }
    return { seen, run: clock.run };
  };
  const fresh = clocks(0);
  const warm = clocks(61.7);
  assert.equal(fresh.run.elapsed, show.SHOW_SIGNAL_TIME, 'the run starts on the show\'s clock');
  assert.equal(warm.run.elapsed, show.SHOW_SIGNAL_TIME, '...after a warm-up too');
  assert.deepEqual(warm.seen, fresh.seen, 'every tick reads the same clock');
  assert.equal(fresh.seen[2399], show.SHOW_SIGNAL_TIME + 20, '2400 ticks on is 20 s on, exactly');
});

test('the drawn car lies between its last two ticks, and the sim state is back after the frame', () => {
  const world = makeWorld();
  const { car, controllers } = world;
  const clock = controllers.swimClock;
  keysDown(controllers, { forward: true });
  let elapsed = clock.advance(0.5, 0, 'swim');
  clock.endFrame();
  const before = { x: car.position.x, z: car.position.z };
  // half a tick more: no tick, the car drawn half way from the last tick's start to its end
  elapsed = clock.advance(clock.tick * 0.5 - clock.clock.leftover, elapsed, 'swim');
  const drawn = car.position.z;
  assert.ok(Math.abs(drawn - (clock.prev.z + clock.curr.z) / 2) < 1e-9, 'drawn half way between the ticks');
  assert.ok(drawn < before.z || clock.prev.z === clock.curr.z, 'behind the sim state while drawn');
  clock.endFrame();
  assert.equal(car.position.z, before.z, 'the sim state back');
  assert.equal(car.position.x, before.x);
});

test('a teleport between frames starts a new run there instead of drawing the car across the city', () => {
  const world = makeWorld();
  const { car, controllers, reseeds } = world;
  const clock = controllers.swimClock;
  let elapsed = clock.advance(0.1, 0, 'swim');
  clock.endFrame();
  assert.equal(reseeds.length, 1, 'entering swim mode starts a run');
  assert.equal(clock.run.reason, 'start');
  car.position.x += 500;
  elapsed = clock.advance(0.004, elapsed, 'swim');
  assert.equal(reseeds.length, 2);
  assert.equal(clock.run.reason, 'teleport');
  assert.equal(car.position.x, clock.curr.x, 'drawn where it landed');
  clock.endFrame();
  // out of swim mode the clock steps nothing and elapsed runs on with the frames
  assert.equal(clock.advance(0.25, 10, 'car'), 10.25);
  assert.equal(clock.active, false);
});

test('a frame that throws before endFrame() costs the run nothing: the next frame puts the sim state back first', () => {
  const world = makeWorld();
  const { car, controllers, reseeds } = world;
  const clock = controllers.swimClock;
  keysDown(controllers, { forward: true });
  let elapsed = clock.advance(0.5, 0, 'swim');
  clock.endFrame();
  elapsed = clock.advance(clock.tick * 1.5 - clock.clock.leftover, elapsed, 'swim');
  const sim = clock.saved.z;
  assert.notEqual(car.position.z, sim, 'drawn between ticks');
  // (no endFrame: the frame threw)
  elapsed = clock.advance(0.0001, elapsed, 'swim');
  assert.equal(reseeds.length, 1, 'not taken for a teleport');
  assert.equal(clock.run.reason, 'start');
  clock.endFrame();
  assert.ok(car.position.z >= sim, 'the car went on from its sim state');
  // a frame that threw, then a teleport before the next: the teleport stands, and starts its run
  elapsed = clock.advance(clock.tick * 1.5, elapsed, 'swim');
  car.position.x = 100;
  elapsed = clock.advance(0.0001, elapsed, 'swim');
  assert.equal(car.position.x, 100);
  assert.equal(clock.run.reason, 'teleport');
  assert.equal(reseeds.length, 2);
  clock.endFrame();
});

function keysDown(controllers, keys) {
  Object.assign(controllers.keys, keys);
}
