const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./helpers/module.cjs');

const recorderModule = loadModule(readFileSync(join(__dirname, '../js/session-recorder.js'), 'utf8'));
const physics = loadModule(readFileSync(join(__dirname, '../js/drift-physics.js'), 'utf8'));
const { SessionRecorder, FIELDS, KEYFRAME_EVERY } = recorderModule;

function newCar(speed = 20) {
  return { position: { x: 0, z: 0 }, heading: 0, speed, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0, drift: {} };
}

// Records `frames` 60 Hz frames of the player driving on W (A held from frame 100) through the real driver and model
function record(frames, { car = newCar(), teleportAt = -1 } = {}) {
  let clock = 0;
  const posts = [];
  const recorder = new SessionRecorder({ now: () => clock, post: (body) => posts.push(JSON.parse(body)), camera: () => 'pov' });
  const driver = new physics.KeyboardDriver();
  for (let i = 0; i < frames; i++) {
    if (i === teleportAt) car.position.x += 500;
    const keys = { forward: 1, backward: 0, left: i >= 100 ? 1 : 0, right: 0, handbrake: 0 };
    recorder.frame(car, keys, 1 / 60, driver);
    const input = driver.update(car, keys, 1 / 60);
    for (let s = 0; s < 4; s++) physics.stepDriftCar(car, input, 1 / 240, physics.M5_DRIFT, car.drift);
    clock += 1 / 60;
  }
  return { recorder, posts };
}

test('the recorder keeps every frame with its keys, state and camera, and keyframes the keyboard driver', () => {
  const { recorder } = record(200);
  assert.equal(recorder.all.length, 200);
  const row = Object.fromEntries(FIELDS.map((f, i) => [f, recorder.all[150][i]]));
  assert.equal(row.forward, 1);
  assert.equal(row.left, 1);
  assert.equal(row.camera, 'pov');
  assert.ok(row.speed > 20, `speed ${row.speed}`);
  assert.equal(recorder.allDrivers.length, Math.ceil(200 / KEYFRAME_EVERY));
  assert.equal(recorder.allDrivers[0][1].segmentStart, true);
  assert.ok('steer' in recorder.allDrivers[5][1] && 'commit' in recorder.allDrivers[5][1]);
});

test('a flush posts the frames in pieces small enough for a keepalive request, and a failing POST is swallowed', () => {
  const { recorder, posts } = record(700);
  recorder.flush();
  assert.equal(posts.length, 3);
  assert.deepEqual(posts.map((p) => p.frames.length), [300, 300, 100]);
  assert.deepEqual(posts.map((p) => p.chunk), [0, 1, 2]);
  for (const p of posts) assert.ok(JSON.stringify(p).length < 60000, `chunk ${p.chunk}: ${JSON.stringify(p).length} bytes`);
  // keyframes land in the chunk they belong to, indexed within it
  assert.deepEqual(posts[1].drivers.map(([i]) => i), [0, 30, 60, 90, 120, 150, 180, 210, 240, 270]);
  recorder.flush();
  assert.equal(posts.length, 3, 'nothing pending, nothing sent');

  const failing = new SessionRecorder({ now: () => 0, post: () => Promise.reject(new Error('no server')) });
  failing.frame(newCar(), { forward: 1 }, 1 / 60, null);
  assert.doesNotThrow(() => failing.flush());
  const throwing = new SessionRecorder({ now: () => 0, post: () => { throw new Error('no fetch'); } });
  throwing.frame(newCar(), { forward: 1 }, 1 / 60, null);
  assert.doesNotThrow(() => throwing.flush());
});

test('a teleport starts a new segment with a fresh snapshot of the driver', () => {
  const { recorder } = record(100, { teleportAt: 45 });
  const starts = recorder.allDrivers.filter(([, snap]) => snap.segmentStart).map(([i]) => i);
  assert.deepEqual([...starts], [0, 45]); // (the module runs in its own realm: copy its array)
});

test('replaying the recorded keys from a keyframe through the same physics reproduces the recorded drive', () => {
  const { recorder } = record(240);
  const frames = recorder.all.map((row) => Object.fromEntries(FIELDS.map((f, i) => [f, row[i]])));
  const [start, snapshot] = recorder.allDrivers[3];
  const f0 = frames[start];
  const car = { position: { x: f0.x, z: f0.z }, heading: f0.heading, speed: f0.speed, vx: f0.vx, vz: f0.vz, angularVel: f0.angularVel,
    steerAngle: f0.steerAngle, longAccel: f0.longAccel, gear: f0.gear, rpm: f0.rpm, wheelSlip: f0.wheelSlip, limiterTime: f0.limiterTime, drift: {} };
  const driver = new physics.KeyboardDriver();
  Object.assign(driver, snapshot);
  for (let i = start; i < frames.length - 1; i++) {
    const f = frames[i];
    const input = driver.update(car, f, f.dt);
    for (let s = 0; s < 4; s++) physics.stepDriftCar(car, input, f.dt / 4, physics.M5_DRIFT, car.drift);
  }
  const last = frames.at(-1);
  // the recording rounds the state, so the replay lands close rather than exactly on it
  assert.ok(Math.hypot(car.position.x - last.x, car.position.z - last.z) < 0.5, `apart ${Math.hypot(car.position.x - last.x, car.position.z - last.z)}`);
  assert.ok(Math.abs(car.heading - last.heading) < 0.01);
});
