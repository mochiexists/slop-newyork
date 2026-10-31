const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const RAD = Math.PI / 180;
const FRAME = 1 / 60;
const STEPS = 4;

let physics, show;
test.before(async () => {
  const config = await import('../js/city-config.js');
  physics = loadModule(read('js/drift-physics.js'));
  const autopilot = loadModule(read('js/drift-autopilot.js'), { imports: { './drift-physics.js': physics } });
  show = loadModule(read('js/swim-show.js'), {
    imports: {
      'three/webgpu': { Color: class { constructor() { this.r = this.g = this.b = 1; } } },
      './city-config.js': config,
      './cars.js': {},
      './tsl-materials.js': {},
      './drift-physics.js': physics,
      './drift-autopilot.js': autopilot,
      './vehicle-physics.js': {}
    }
  });
});

test('the show drives the burnout, the donuts round the cop and the power-out on the player\'s keys', () => {
  const car = {
    position: { x: show.SHOW_SPOT.x, z: show.SHOW_SPOT.z }, heading: show.SHOW_SPOT.heading,
    speed: 0, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0, drift: {}
  };
  const driver = new physics.KeyboardDriver();
  const controllers = { entities: { swim: car }, swimPilot: null, swimDriver: driver };
  const cruiser = { car: { position: { x: 0, z: 0 } }, park(x, z) { Object.assign(this.car.position, { x, z }); }, chase() {}, giveUp() {} };
  const phases = [];
  const swimShow = new show.SwimShow({
    controllerManager: controllers, trafficSystem: { setClearZone() {}, reseed() {} }, cruiser, onPhase: (phase) => phases.push(phase)
  });
  swimShow.start();
  const cop = cruiser.car.position;
  let drifting = 0, inSlide = 0, closest = Infinity, widest = 0, angles = 0, bird = false;
  for (let n = 0; n < 20 * 60 && swimShow.phase !== 'swim'; n++) {
    const keys = { forward: 0, backward: 0, left: 0, right: 0, handbrake: 0 };
    controllers.swimPilot(car, FRAME, keys, driver);
    for (const key of Object.values(keys)) assert.ok(key === 0 || key === 1, 'the show only presses keys');
    const input = driver.update(car, keys, FRAME);
    for (let i = 0; i < STEPS; i++) physics.stepDriftCar(car, input, FRAME / STEPS, physics.M5_DRIFT, car.drift);
    bird ||= car.showBird;
    const distance = Math.hypot(car.position.x - cop.x, car.position.z - cop.z);
    if (swimShow.phase === 'donuts' && swimShow.donut.phase === 'drift') {
      drifting++;
      // A left drift slides the car's velocity to the right of its nose
      const angle = -Math.atan2(car.vx * Math.cos(car.heading) - car.vz * Math.sin(car.heading), Math.abs(car.speed));
      angles += angle;
      if (angle > 20 * RAD) inSlide++;
      closest = Math.min(closest, distance);
      widest = Math.max(widest, distance);
    }
  }
  assert.deepEqual(phases.slice(0, 3), ['burnout', 'donuts', 'escape'], 'burnout, donuts, then the getaway');
  assert.ok(drifting > 4 * 60, `a few seconds of held drift round the cop (${(drifting / 60).toFixed(1)} s)`);
  assert.ok(inSlide / drifting > 0.9, `sideways the whole way round (${(inSlide / drifting * 100).toFixed(0)}% past 20°)`);
  const meanAngle = angles / drifting / RAD;
  assert.ok(meanAngle > 28 && meanAngle < 50, `a big angle, not a spin (${meanAngle.toFixed(0)}°)`);
  assert.ok(closest > 6 && widest < 15, `round the cop at about the circle's radius (${closest.toFixed(1)}..${widest.toFixed(1)} m)`);
  assert.ok(bird, 'the bird out of the window');
});

test('each street of the run is staged with pairs to split as its corner comes up, further in past a drift, and short of the next drift\'s line-up', () => {
  const car = { position: { x: 0, z: 0 }, heading: 0, speed: 20, vx: 0, vz: 0, angularVel: 0 };
  const staged = [];
  const traffic = { setClearZone() {}, reseed() {}, stageRoute: (a, b, options) => staged.push({ a, b, ...options }) };
  const cruiser = { car: { position: { x: 0, z: 0 } }, park() {}, chase() {}, giveUp() {} };
  const swimShow = new show.SwimShow({ controllerManager: { entities: { swim: car } }, trafficSystem: traffic, cruiser });
  // A gentle bend 40 m on, then a right angle 200 m further
  const route = [{ x: 0, z: 0 }, { x: 2, z: 40 }, { x: 2, z: 240 }, { x: -200, z: 240 }];
  swimShow.pilot.setPath(route);
  swimShow.clearNextCorner(car);
  car.position.z = 160;
  swimShow.pilot.advance(car);
  swimShow.clearNextCorner(car);
  swimShow.clearNextCorner(car);
  assert.deepEqual(staged, [
    { a: route[1], b: route[2], startGap: 30, endGap: swimShow.pilot.options.lineUpDistance },
    { a: route[2], b: route[3], startGap: 45 }
  ]);
});

test('the show drives the automatic and hands a manual player their manual back, and lets its staged rows go', () => {
  const car = {
    position: { x: show.SHOW_SPOT.x, z: show.SHOW_SPOT.z }, heading: show.SHOW_SPOT.heading,
    speed: 0, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0, drift: {}, manual: true
  };
  const driver = new physics.KeyboardDriver();
  const controllers = { entities: { swim: car }, swimPilot: null, swimDriver: driver };
  let released = 0;
  const traffic = { setClearZone() {}, reseed() {}, releaseStaged: () => released++ };
  const cruiser = { car: { position: { x: 0, z: 0 } }, park() {}, chase() {}, giveUp() {} };
  const swimShow = new show.SwimShow({ controllerManager: controllers, trafficSystem: traffic, cruiser });
  swimShow.start();
  assert.equal(car.manual, false, 'the AI shifts for itself');
  swimShow.stop();
  assert.equal(car.manual, true, 'the player is back in manual');
  assert.ok(released >= 1, 'the staged rows drive on as ordinary traffic');
});

test('a frame with no time in it leaves the keyboard driver unharmed', () => {
  const car = { position: { x: 0, z: 0 }, heading: 0, speed: 12, vx: 3, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0, drift: {} };
  const driver = new physics.KeyboardDriver();
  const keys = { forward: 1, backward: 0, left: 1, right: 0, handbrake: 0 };
  driver.update(car, keys, 0);
  const input = driver.update(car, keys, FRAME);
  assert.ok(Number.isFinite(input.throttle) && Number.isFinite(input.steer), 'finite inputs after a zero frame');
});
