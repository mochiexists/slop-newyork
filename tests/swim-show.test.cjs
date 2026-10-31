const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const RAD = Math.PI / 180;
const FRAME = 1 / 60;
const STEPS = 4;
const MPH = 2.23694;

let physics, show, roam, config;
test.before(async () => {
  config = await import('../js/city-config.js');
  roam = await import('../js/swim-roam.js');
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
      './vehicle-physics.js': {},
      './swim-roam.js': roam
    }
  });
});

function makeCar(at = show.SHOW_SPOT) {
  return {
    position: { x: at.x, z: at.z }, heading: at.heading, speed: 0, vx: 0, vz: 0, angularVel: 0, steerAngle: 0,
    longAccel: 0, drift: {}
  };
}

function makeShow(car, traffic = {}) {
  const driver = new physics.KeyboardDriver();
  const controllers = { entities: { swim: car }, swimPilot: null, swimDriver: driver };
  const cruiser = {
    car: { position: { x: 0, z: 0 } }, state: 'hidden',
    park(x, z) { Object.assign(this.car.position, { x, z }); this.state = 'parked'; }, chase() {}, giveUp() {}
  };
  const phases = [];
  const swimShow = new show.SwimShow({
    controllerManager: controllers, cruiser, onPhase: (phase) => phases.push(phase),
    trafficSystem: { setClearZone() {}, reseed() {}, ...traffic }
  });
  return { swimShow, controllers, driver, cruiser, phases };
}

// One 60 Hz frame of the game's swim loop: the show presses its keys, the keyboard driver turns them into an input
function frame(car, controllers, driver, held = {}) {
  const keys = { forward: 0, backward: 0, left: 0, right: 0, handbrake: 0, ...held };
  controllers.swimPilot?.(car, FRAME, keys, driver);
  const input = driver.update(car, keys, FRAME);
  for (let i = 0; i < STEPS; i++) physics.stepDriftCar(car, input, FRAME / STEPS, physics.M5_DRIFT, car.drift);
  return { keys, input };
}

// Least-squares circle through points [x, z]
function fitCircle(points) {
  let sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0, sxr = 0, szr = 0, sr = 0;
  for (const [x, z] of points) {
    const r2 = x * x + z * z;
    sx += x; sz += z; sxx += x * x; szz += z * z; sxz += x * z; sxr += x * r2; szr += z * r2; sr += r2;
  }
  const a = [[sxx, sxz, sx, sxr], [sxz, szz, sz, szr], [sx, sz, points.length, sr]];
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
    const k = a[j][i] / a[i][i];
    for (let m = i; m < 4; m++) a[j][m] -= k * a[i][m];
  }
  const s = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let acc = a[i][3];
    for (let m = i + 1; m < 3; m++) acc -= a[i][m] * s[m];
    s[i] = acc / a[i][i];
  }
  const cx = s[0] / 2, cz = s[1] / 2;
  return { cx, cz, r: Math.sqrt(s[2] + cx * cx + cz * cz) };
}

// The opening, run once and measured for the tests below
let opening;
function runOpening() {
  if (opening) return opening;
  const car = makeCar();
  const { swimShow, controllers, driver, cruiser, phases } = makeShow(car);
  swimShow.start();
  const cop = cruiser.car.position;
  const result = {
    phases, burnoutFrames: 0, rollTop: 0, ring: [], swept: 0, sliding: 0, drifting: 0, angles: 0, bird: false,
    exitSpeeds: [], closest: Infinity, cop: { ...cop }
  };
  let bearing = null, outAt = null;
  for (let n = 0; n < 40 * 60; n++) {
    const { keys, input } = frame(car, controllers, driver);
    for (const key of Object.values(keys)) assert.ok(key === 0 || key === 1, 'the show only presses keys');
    if (input.burnout || (keys.forward && keys.backward && Math.abs(car.speed) < 3)) result.burnoutFrames++;
    const v = Math.hypot(car.speed, car.vx, car.vz);
    const distance = Math.hypot(car.position.x - cop.x, car.position.z - cop.z);
    const donut = swimShow.donut;
    if (swimShow.phase === 'roll') result.rollTop = Math.max(result.rollTop, v);
    if (swimShow.phase === 'donuts' && donut.phase !== 'launch') {
      const b = Math.atan2(car.position.x - cop.x, car.position.z - cop.z);
      if (bearing !== null) result.swept += Math.atan2(Math.sin(b - bearing), Math.cos(b - bearing));
      bearing = b;
      result.closest = Math.min(result.closest, distance);
    }
    if (swimShow.phase === 'donuts' && donut.phase === 'drift') {
      result.ring.push([car.position.x, car.position.z]);
      // A left drift slides the car's velocity to the right of its nose
      const angle = -Math.atan2(car.vx * Math.cos(car.heading) - car.vz * Math.sin(car.heading), Math.abs(car.speed));
      result.drifting++;
      result.angles += angle;
      if (angle > 20 * RAD) result.sliding++;
    }
    result.bird ||= car.showBird;
    if (outAt === null && donut?.phase === 'powerOut') outAt = n;
    if (outAt !== null) result.exitSpeeds.push(v);
    if (outAt !== null && n > outAt + 6 * 60) break;
  }
  result.fit = fitCircle(result.ring);
  opening = result;
  return result;
}

test('the opening rolls up at a crawl and floors it into the donuts: no burnout', () => {
  const o = runOpening();
  assert.deepEqual(o.phases.slice(0, 3), ['roll', 'donuts', 'escape'], 'roll, donuts, then the getaway');
  assert.equal(o.burnoutFrames, 0, 'no line lock, no W and S together at a stop');
  assert.ok(o.rollTop * MPH < 15, `the roll is a crawl (${(o.rollTop * MPH).toFixed(0)} mph at most)`);
});

test('the donuts orbit the cop: two laps round a circle centred on the cruiser, sideways the whole way', () => {
  const o = runOpening();
  const centre = Math.hypot(o.fit.cx - o.cop.x, o.fit.cz - o.cop.z);
  assert.ok(centre < 2, `the circle is centred on the cop (${centre.toFixed(1)} m off)`);
  assert.ok(o.fit.r > 8 && o.fit.r < 13, `at about the drift radius (${o.fit.r.toFixed(1)} m)`);
  assert.ok(o.closest > 7, `never close to hitting the cop (${o.closest.toFixed(1)} m closest)`);
  assert.ok(o.swept / (2 * Math.PI) >= 2, `two laps round the cop (${(o.swept / 2 / Math.PI).toFixed(2)})`);
  assert.ok(o.sliding / o.drifting > 0.9, `sideways the whole way round (${(o.sliding / o.drifting * 100).toFixed(0)}% past 20°)`);
  const mean = o.angles / o.drifting / RAD;
  assert.ok(mean > 25 && mean < 55, `a big angle, not a spin (${mean.toFixed(0)}°)`);
  assert.ok(o.bird, 'the bird out of the window');
});

test('the donuts hold the circle at other frame rates and on a looser or steerier car (closed loop on the keys)', () => {
  const variants = [
    { name: '120 Hz', hz: 120, physics },
    { name: '40 Hz', hz: 40, physics },
    { name: 'more slide steer', hz: 60, physics: loadModule(read('js/drift-physics.js').replace('  slideSteer: 10 * RAD,', '  slideSteer: 15 * RAD,')) },
    { name: 'less rear grip', hz: 60, physics: loadModule(read('js/drift-physics.js').replace('  rearGrip: 1.24,', '  rearGrip: 1.14,')) }
  ];
  for (const { name, hz, physics: model } of variants) {
    const car = makeCar();
    const driver = new model.KeyboardDriver();
    const controllers = { entities: { swim: car }, swimPilot: null, swimDriver: driver };
    const cruiser = { car: { position: { x: 0, z: 0 } }, park(x, z) { Object.assign(this.car.position, { x, z }); }, chase() {}, giveUp() {} };
    const swimShow = new show.SwimShow({ controllerManager: controllers, cruiser, trafficSystem: { setClearZone() {}, reseed() {} } });
    swimShow.start();
    const ring = [];
    const dt = 1 / hz;
    for (let n = 0; n < 30 * hz && swimShow.phase !== 'escape'; n++) {
      const keys = { forward: 0, backward: 0, left: 0, right: 0, handbrake: 0 };
      controllers.swimPilot(car, dt, keys, driver);
      const input = driver.update(car, keys, dt);
      const steps = Math.ceil(dt * 240);
      for (let i = 0; i < steps; i++) model.stepDriftCar(car, input, dt / steps, model.M5_DRIFT, car.drift);
      if (swimShow.phase === 'donuts' && swimShow.donut.phase === 'drift') ring.push([car.position.x, car.position.z]);
    }
    const fit = fitCircle(ring);
    const cop = cruiser.car.position;
    const centre = Math.hypot(fit.cx - cop.x, fit.cz - cop.z);
    const distances = ring.map(([x, z]) => Math.hypot(x - cop.x, z - cop.z));
    assert.equal(swimShow.phase, 'escape', `${name}: out of the donuts and away`);
    assert.ok(centre < 2.5, `${name}: centred on the cop (${centre.toFixed(1)} m off)`);
    assert.ok(Math.min(...distances) > 7 && Math.max(...distances) < 14,
      `${name}: on the circle (${Math.min(...distances).toFixed(1)}..${Math.max(...distances).toFixed(1)} m)`);
  }
});

test('out of the last lap it drifts onto 7th Ave and pulls off flat out: 50 mph within 3 s', () => {
  const o = runOpening();
  const reached = o.exitSpeeds.findIndex((v) => v * MPH >= 50);
  assert.ok(reached >= 0 && reached / 60 < 3, `50 mph ${(reached / 60).toFixed(1)} s after the power-out`);
  assert.ok(o.exitSpeeds[o.exitSpeeds.length - 1] * MPH > 70, `and on (${(o.exitSpeeds[o.exitSpeeds.length - 1] * MPH).toFixed(0)} mph 6 s on)`);
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
  const car = { ...makeCar(), manual: true };
  let released = 0;
  const { swimShow } = makeShow(car, { releaseStaged: () => released++ });
  swimShow.start();
  assert.equal(car.manual, false, 'the AI shifts for itself');
  swimShow.stop();
  assert.equal(car.manual, true, 'the player is back in manual');
  assert.ok(released >= 1, 'the staged rows drive on as ordinary traffic');
});

test('a driving key takes the wheel at any moment, and the key goes through to the car', () => {
  for (const held of [{ forward: 1 }, { left: 1 }, { backward: 1 }, { handbrake: 1 }]) {
    const car = makeCar();
    const { swimShow, controllers, driver, phases } = makeShow(car);
    swimShow.start();
    for (let n = 0; n < 8 * 60; n++) frame(car, controllers, driver);
    assert.ok(swimShow.running, 'the AI is driving');
    const { keys } = frame(car, controllers, driver, held);
    assert.equal(swimShow.running, false, `${Object.keys(held)[0]} takes the wheel`);
    assert.equal(swimShow.tookOver, true);
    assert.equal(controllers.swimPilot, null, 'the AI lets go of the keys');
    assert.equal(phases[phases.length - 1], 'off');
    for (const [key, value] of Object.entries(held)) assert.equal(keys[key], value, 'the player\'s key reaches the car');
  }
});

test('after the show\'s run the AI keeps going: it picks the next streets and drives on past the old hand-over', () => {
  const car = makeCar();
  const { swimShow, controllers, driver } = makeShow(car);
  swimShow.start();
  const escapeEnd = show.ESCAPE_ROUTE[show.ESCAPE_ROUTE.length - 1];
  let distance = 0, sawEnd = false, offRoad = 0;
  const seconds = 240;
  for (let n = 0; n < seconds * 60; n++) {
    const x = car.position.x, z = car.position.z;
    frame(car, controllers, driver);
    distance += Math.hypot(car.position.x - x, car.position.z - z);
    if (Math.hypot(car.position.x - escapeEnd.x, car.position.z - escapeEnd.z) < 40) sawEnd = true;
    // (out of the donuts it crosses the Times Square plaza back onto 7th Ave: not a roadway)
    const plaza = swimShow.phase === 'escape' && swimShow.time < 5;
    if (n % 30 === 0 && !plaza && swimShow.phase !== 'roll' && swimShow.phase !== 'donuts') {
      const near = config.nearestRoads(car.position.x, car.position.z, 25);
      if (!near.some(({ road, dist }) => dist < road.w / 2 + 2)) offRoad++;
    }
  }
  assert.ok(swimShow.running, 'still the AI\'s car');
  assert.ok(sawEnd, 'it drove the whole of the show\'s run');
  const path = swimShow.pilot.path;
  assert.ok(path.length > show.ESCAPE_ROUTE.length + 4, `it chose more streets (${path.length} corners)`);
  assert.equal(swimShow.pilot.finished, false, 'never at the end of its route');
  assert.ok(distance > 5000, `it keeps going (${(distance / 1000).toFixed(1)} km in ${seconds} s)`);
  assert.ok(offRoad <= 2, `on the streets (${offRoad} samples off a roadway)`);
});

test('the roam only drives roads the right way and stays inside Midtown', () => {
  const route = new roam.RoamRoute(3).continueFrom(show.ESCAPE_ROUTE);
  const points = [show.ESCAPE_ROUTE[show.ESCAPE_ROUTE.length - 1]];
  for (let i = 0; i < 60; i++) {
    const corner = route.next();
    assert.ok(corner, 'there is always a way on');
    points.push(corner);
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    assert.ok(roam.inBox(b.x, b.z), `corner ${i} inside the box`);
    const alongZ = Math.abs(b.z - a.z) > Math.abs(b.x - a.x);
    // Each leg runs along one road: an avenue (x fixed) or a cross street (z fixed)
    if (alongZ) {
      assert.ok(Math.abs(b.x - a.x) < 8, `leg ${i} runs straight down an avenue`);
      const avenue = roam.ROAM_AVENUES.find((id) => Math.abs(config.avenueX(id) - b.x) < 8);
      assert.ok(avenue && roam.avenueOpen(avenue, a.z, b.z), `leg ${i}: ${avenue} runs that way`);
    } else {
      assert.ok(Math.abs(b.z - a.z) < 8, `leg ${i} runs straight along a street`);
      const street = roam.ROAM_STREETS.find((n) => Math.abs(config.streetZ(n) - b.z) < 8);
      assert.ok(street && roam.streetOpen(street, a.x, b.x), `leg ${i}: ${street}th St open that way`);
    }
  }
  // From the show's last corner (57th St & 9th Ave, heading west), the way on is down 9th Ave (one-way south)
  for (const seed of [1, 2, 3]) {
    const first = new roam.RoamRoute(seed).continueFrom(show.ESCAPE_ROUTE).next();
    assert.ok(first.z > config.streetZ(57) + 200 && Math.abs(first.x - config.avenueX('9')) < 8, 'south on 9th Ave');
  }
  // ...and no leg it may choose runs through a curb block (57th St west of 10th Ave has one across it)
  assert.equal(roam.streetOpen(57, config.avenueX('10'), config.avenueX('11'), true), false);
});

test('I hands the car back to the AI: it roams on from wherever the car is', () => {
  // Rolling south down 7th Ave at 34th St, just taken back from the player
  const car = makeCar({ x: config.avenueX('7'), z: config.streetZ(36), heading: 0 });
  car.speed = 15;
  const { swimShow, controllers, driver, phases } = makeShow(car);
  assert.equal(swimShow.roam(5), true);
  assert.equal(phases[phases.length - 1], 'roam');
  const path = swimShow.pilot.path;
  assert.equal(path.length, 4, 'three corners planned ahead');
  assert.ok(path[1].z > car.position.z && Math.abs(path[1].x - config.avenueX('7')) < 8, 'on down 7th Ave first');
  let distance = 0;
  for (let n = 0; n < 30 * 60; n++) {
    const x = car.position.x, z = car.position.z;
    const { keys } = frame(car, controllers, driver);
    for (const key of Object.values(keys)) assert.ok(key === 0 || key === 1, 'the AI only presses keys');
    distance += Math.hypot(car.position.x - x, car.position.z - z);
  }
  assert.ok(swimShow.running && swimShow.phase === 'roam', 'still driving');
  assert.ok(distance > 700, `it drives on (${distance.toFixed(0)} m in 30 s)`);
  // ...and I again (or a driving key) gives it back
  swimShow.stop();
  assert.equal(controllers.swimPilot, null);
});

test('roaming into a red light\'s queue across every lane, the AI waits behind it instead of backing out, then goes', () => {
  // Rolling south down 7th Ave at 30 mph, a queue standing across all its lanes 60 m ahead
  const car = makeCar({ x: config.avenueX('7'), z: config.streetZ(36), heading: 0 });
  car.speed = 13;
  const { swimShow, controllers, driver } = makeShow(car);
  assert.equal(swimShow.roam(5), true);
  const queue = [-7.2, -3.6, 0, 3.6, 7.2].map((x) => ({
    x: config.avenueX('7') + x, z: car.position.z + 60, yaw: 0, speed: 0, half: 2.3, halfWidth: 0.92, edge: true
  }));
  swimShow.obstacles = queue;
  let reversing = 0, waited = 0, queued = 0;
  for (let n = 0; n < 12 * 60; n++) {
    frame(car, controllers, driver);
    if (car.speed < -0.2) reversing++;
    if (Math.abs(car.speed) < 1) waited++;
    if (swimShow.pilot.queued) queued++;
  }
  assert.equal(reversing, 0, 'it never backs out of the queue');
  assert.ok(waited > 3 * 60, `it waits its turn (${(waited / 60).toFixed(1)} s at a crawl)`);
  assert.ok(queued > 0, 'its planner knows it is queued');
  assert.ok(car.position.z < queue[0].z - 4, 'behind the queue, not in it');
  // Green: the queue pulls away, and so does the AI
  for (let n = 0; n < 8 * 60; n++) {
    for (const v of queue) {
      v.speed = Math.min(12, v.speed + 2 / 60);
      v.z += v.speed / 60;
    }
    frame(car, controllers, driver);
  }
  assert.ok(car.speed > 8, `and drives on after it (${car.speed.toFixed(1)} m/s)`);
});

test('a queue held short of the corner the show keeps clear is waiting for the AI: it backs out rather than wait for good', () => {
  // Rolling south down 7th Ave, cars stopped across every lane at the edge of its first corner's clear zone
  const car = makeCar({ x: config.avenueX('7'), z: config.streetZ(36), heading: 0 });
  car.speed = 13;
  const { swimShow, controllers, driver } = makeShow(car);
  assert.equal(swimShow.roam(5), true);
  const corner = swimShow.pilot.path[1];
  const sign = Math.sign(corner.z - car.position.z);
  // (on down the avenue to 140 m short of that corner)
  car.position.z = corner.z - sign * 140;
  swimShow.obstacles = [-7.2, -3.6, 0, 3.6, 7.2].map((x) => ({
    x: config.avenueX('7') + x, z: corner.z - sign * 30, yaw: 0, speed: 0, half: 2.3, halfWidth: 0.92, edge: true
  }));
  let reversed = false;
  for (let n = 0; n < 20 * 60 && !reversed; n++) {
    frame(car, controllers, driver);
    reversed = car.speed < -0.2;
  }
  assert.ok(reversed, 'it backs out to find a way round');
});

test('a frame with no time in it leaves the keyboard driver unharmed', () => {
  const car = { position: { x: 0, z: 0 }, heading: 0, speed: 12, vx: 3, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0, drift: {} };
  const driver = new physics.KeyboardDriver();
  const keys = { forward: 1, backward: 0, left: 1, right: 0, handbrake: 0 };
  driver.update(car, keys, 0);
  const input = driver.update(car, keys, FRAME);
  assert.ok(Number.isFinite(input.throttle) && Number.isFinite(input.steer), 'finite inputs after a zero frame');
});
