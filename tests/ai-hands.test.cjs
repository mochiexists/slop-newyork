const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const physics = loadModule(read('js/drift-physics.js'));
const autopilot = loadModule(read('js/drift-autopilot.js'), { imports: { './drift-physics.js': physics } });
const { DriftAutopilot, HANDS, Hands } = autopilot;
const KEYS = ['forward', 'backward', 'left', 'right', 'handbrake'];
const EPSILON = 1e-9;

// Every key's cadence over a run of frames: its shortest state (a state under way when the count started isn't timed),
// the most changes in any one second, and how many times a second it changed
class Cadence {
  constructor() {
    this.t = 0;
    this.last = null;
    this.since = {};
    this.changes = {};
    this.shortest = {};
    this.most = {};
    this.recent = {};
    for (const key of KEYS) {
      this.changes[key] = 0;
      this.shortest[key] = Infinity;
      this.most[key] = 0;
      this.recent[key] = [];
      this.since[key] = null;
    }
  }

  add(keys, dt) {
    this.t += dt;
    for (const key of KEYS) {
      const state = keys[key] ? 1 : 0;
      if (this.last && state !== this.last[key]) {
        this.changes[key]++;
        if (this.since[key] !== null) this.shortest[key] = Math.min(this.shortest[key], this.t - this.since[key]);
        this.since[key] = this.t;
        const recent = this.recent[key];
        recent.push(this.t);
        while (this.t - recent[0] >= 1 - EPSILON) recent.shift();
        this.most[key] = Math.max(this.most[key], recent.length);
      }
    }
    this.last = { ...keys };
  }

  assertHuman(label) {
    for (const key of KEYS) {
      assert.ok(this.shortest[key] >= HANDS.minHold - EPSILON,
        `${label}: ${key} held ${(this.shortest[key] * 1000).toFixed(0)} ms at shortest (a tap is ${HANDS.minHold * 1000} ms)`);
      assert.ok(this.most[key] <= HANDS.maxRate, `${label}: ${key} changed ${this.most[key]} times in a second`);
    }
  }
}

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('the hands press what they are asked as a player\'s fingers can: no key state shorter than a tap, at most six changes a second', () => {
  for (const hz of [60, 40, 144]) {
    const random = seeded(hz);
    const hands = new Hands();
    const cadence = new Cadence();
    const dt = 1 / hz;
    let wanted = { forward: 0, backward: 0, left: 0, right: 0, handbrake: 0 };
    for (let n = 0; n < 20 * hz; n++) {
      // Asked for anything, every frame: a fresh random set of keys (A and D, W and S together too)
      if (random() < 0.7) wanted = Object.fromEntries(KEYS.map((key) => [key, random() < 0.5 ? 1 : 0]));
      // (a frame time that wobbles, as the browser's does)
      const frame = dt * (0.85 + 0.3 * random());
      const keys = hands.press(wanted, frame);
      assert.ok(!(keys.left && keys.right), 'never A and D together');
      assert.ok(!(keys.forward && keys.backward), 'never W and S together');
      cadence.add(keys, frame);
    }
    cadence.assertHuman(`${hz} Hz`);
  }
});

test('the hands follow a steady ask at once and a held key stays held', () => {
  const hands = new Hands();
  const keys = hands.press({ forward: 1, left: 1 }, 1 / 60);
  assert.equal(keys.forward, 1, 'W goes down on the first frame');
  assert.equal(keys.left, 1);
  // Let go a frame later: the tap lasts its minimum
  let held = 1;
  while (hands.press({ forward: 0, left: 0 }, 1 / 60).left) held++;
  assert.equal(held, Math.ceil(HANDS.minHold * 60 - EPSILON), `A came up after ${held} frames`);
  // A to D in one movement: D goes down as A comes up
  const copy = new Hands().copyFrom(hands);
  for (let n = 0; n < 10; n++) copy.press({ left: 1 }, 1 / 60);
  const rolled = copy.press({ right: 1 }, 1 / 60);
  assert.deepEqual([rolled.left, rolled.right], [0, 1], 'from A straight onto D');
});

test('the AI swimming through traffic at 85 mph presses its keys as a player can', () => {
  const traffic = [[1.75, 51, 6], [3.5, 79, 2], [-5.75, 101, 9], [-1, 104, 12], [-0.25, 79, 4], [2.6, 160, 6], [-2.6, 160, 6], [0, 230, 8]]
    .map(([x, z, speed]) => ({ x, z, speed, yaw: 0, half: 2.3, halfWidth: 0.95 }));
  const car = { position: { x: 0, z: 0 }, heading: 0, speed: 38, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0 };
  const pilot = new DriftAutopilot({ passMargin: 0.2, closeBonus: 60, splitBonus: 100, lanes: 2, laneWidth: 2.8 });
  const driver = new physics.KeyboardDriver();
  pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 2000 }], { corridors: [{ left: 7, right: -7, centre: null }] });
  const cadence = new Cadence();
  for (let n = 0; n < 8 * 60; n++) {
    const keys = pilot.update(car, 1 / 60, traffic, driver);
    cadence.add(keys, 1 / 60);
    const input = driver.update(car, keys, 1 / 60);
    for (let i = 0; i < 4; i++) physics.stepDriftCar(car, input, 1 / 240);
    for (const o of traffic) o.z += o.speed / 60;
  }
  cadence.assertHuman('swimming');
  const steering = (cadence.changes.left + cadence.changes.right) / cadence.t;
  assert.ok(steering <= 8, `A and D changed ${steering.toFixed(1)} times a second (the 60 Hz pilot: ~21)`);
  assert.ok(cadence.changes.forward / cadence.t <= 4, `W changed ${(cadence.changes.forward / cadence.t).toFixed(1)} times a second (was ~8)`);
});

test('braking for a corner it holds the brake or taps it, never a 60 Hz duty', () => {
  // Down a straight at 85 mph to a right-angle corner 200 m on
  const car = { position: { x: 0, z: 0 }, heading: 0, speed: 38, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0 };
  const pilot = new DriftAutopilot({ lanes: 2, laneWidth: 2.8 });
  const driver = new physics.KeyboardDriver();
  pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 200 }, { x: -300, z: 200 }]);
  const cadence = new Cadence();
  let braked = 0;
  for (let n = 0; n < 8 * 60; n++) {
    const keys = pilot.update(car, 1 / 60, [], driver);
    cadence.add(keys, 1 / 60);
    braked += keys.backward;
    const input = driver.update(car, keys, 1 / 60);
    for (let i = 0; i < 4; i++) physics.stepDriftCar(car, input, 1 / 240);
  }
  assert.ok(braked > 30, 'it braked');
  cadence.assertHuman('the corner');
  assert.ok(cadence.changes.backward <= 8, `S went down ${(cadence.changes.backward / 2).toFixed(0)} times for one corner`);
});

test('creeping up to a queue it taps W: a light pedal is taps, not nothing, and the car doesn\'t stall short of it', () => {
  // Rolling at 3 m/s toward a car stopped 25 m ahead across a one-lane street
  const car = { position: { x: 0, z: 0 }, heading: 0, speed: 3, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0 };
  const pilot = new DriftAutopilot();
  const driver = new physics.KeyboardDriver();
  pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 500 }], { corridors: [{ left: 1.5, right: -1.5, centre: null }] });
  const ahead = [{ x: 0, z: 25, speed: 0, yaw: 0, half: 2.3, halfWidth: 0.95 }];
  const cadence = new Cadence();
  let gas = 0;
  for (let n = 0; n < 8 * 60; n++) {
    const keys = pilot.update(car, 1 / 60, ahead, driver);
    cadence.add(keys, 1 / 60);
    gas += keys.forward;
    const input = driver.update(car, keys, 1 / 60);
    for (let i = 0; i < 4; i++) physics.stepDriftCar(car, input, 1 / 240);
  }
  cadence.assertHuman('the creep');
  assert.ok(gas > 0, 'W tapped');
  const gap = ahead[0].z - car.position.z - 2.3 - 2.52;
  assert.ok(gap > 0 && gap < 8, `pulled up behind it (${gap.toFixed(1)} m of gap)`);
});
