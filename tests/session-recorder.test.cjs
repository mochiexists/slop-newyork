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
  const recorder = new SessionRecorder({ now: () => clock, post: (body, keepalive) => posts.push({ ...JSON.parse(body), keepalive }), camera: () => 'pov' });
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

test('a flush posts the frames since the last one; as the page closes, in keepalive pieces that fit; a failing POST is swallowed', () => {
  const { recorder, posts } = record(700);
  recorder.flush();
  assert.equal(posts.length, 1, 'one plain POST while the page is open');
  assert.equal(posts[0].frames.length, 700);
  assert.equal(posts[0].keepalive, false);
  recorder.flush();
  assert.equal(posts.length, 1, 'nothing pending, nothing sent');

  const closing = record(700);
  closing.recorder.flush(true);
  const pieces = closing.posts;
  assert.deepEqual(pieces.map((p) => p.frames.length), [300, 300, 100]);
  assert.deepEqual(pieces.map((p) => p.chunk), [0, 1, 2]);
  assert.ok(pieces.every((p) => p.keepalive === true));
  for (const p of pieces) assert.ok(JSON.stringify(p).length < 60000, `chunk ${p.chunk}: ${JSON.stringify(p).length} bytes`);
  // keyframes land in the chunk they belong to, indexed within it
  assert.deepEqual(pieces[1].drivers.map(([i]) => i), [0, 30, 60, 90, 120, 150, 180, 210, 240, 270]);
  // the session is named for the local time it started
  assert.match(closing.recorder.session, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}$/);
  assert.equal(recorderModule.sessionStamp(new Date(2026, 10, 1, 14, 5, 9, 7)), '2026-11-01T14-05-09-007');

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
  // the recording rounds the state, so the replay lands close rather than exactly on it (since the 1,100 Nm tune this
  // drive powers over into a 45° slide, which magnifies the rounding: 0.011 rad of heading from keyframe 3)
  assert.ok(Math.hypot(car.position.x - last.x, car.position.z - last.z) < 0.5, `apart ${Math.hypot(car.position.x - last.x, car.position.z - last.z)}`);
  assert.ok(Math.abs(car.heading - last.heading) < 0.02, `heading off by ${Math.abs(car.heading - last.heading).toFixed(4)} rad`);
});

test('on the swim clock each row carries its tick and the player\'s own keys, and a run\'s start is noted whole', () => {
  let clock = 0;
  const posts = [];
  const recorder = new SessionRecorder({ now: () => clock, post: (body) => posts.push(JSON.parse(body)) });
  const car = { ...newCar(10), position: { x: 3, y: 0, z: 4 }, gear: 3, manual: true,
    chassisPivot: { rotation: { x: 0.01, z: -0.02 }, position: { y: 0.03 } } };
  car.drift = { slipAngle: 0.2, rearSlide: 5 };
  const driver = new physics.KeyboardDriver();
  const cruiser = { state: 'parked', retired: false, car: { position: { x: 9, z: 8 }, heading: 1 } };
  recorder.run({ tick: 40, seed: 7, x: 3, z: 4, reason: 'show', elapsed: 40 }, car, driver, cruiser);
  recorder.frame(car, { forward: 1, left: 1 }, 1 / 120, driver, true, 0, 40);
  recorder.event('manual', 41);
  recorder.frame(car, { forward: 1 }, 1 / 120, driver, false, 1 | 4, 41);
  clock += 1;
  recorder.flush();
  const [chunk] = posts;
  const row = (i) => Object.fromEntries(FIELDS.map((f, k) => [f, chunk.frames[i][k]]));
  assert.equal(row(0).tick, 40);
  assert.equal(row(0).player, 0, 'the AI drove: the player held nothing');
  assert.equal(row(1).player, 5, 'W and A');
  assert.equal(row(1).dt, 0.0083);
  assert.deepEqual(chunk.runs.map(([i]) => i), [0]);
  const start = chunk.runs[0][1];
  assert.deepEqual([start.tick, start.seed, start.reason, start.elapsed], [40, 7, 'show', 40]);
  assert.equal(start.car.position.x, 3);
  assert.equal(start.car.gear, 3);
  assert.equal(start.car.manual, true);
  assert.equal(start.car.drift.slipAngle, 0.2, 'unrounded');
  assert.deepEqual(start.car.chassis, { pitch: 0.01, roll: -0.02, heave: 0.03 });
  assert.ok('steer' in start.driver);
  assert.deepEqual(start.cruiser, { state: 'parked', retired: false, x: 9, z: 8, heading: 1, speed: 0, vx: 0, vz: 0, angularVel: 0 });
  assert.deepEqual(chunk.events, [[1, { name: 'manual', tick: 41, seq: 2 }]], 'the event comes before the frame after it');
  assert.equal(start.seq, 1, 'notes are numbered in the order they were made');
  // the download has them too, indexed in the whole session
  const all = JSON.parse(recorder.snapshot());
  assert.deepEqual(all.runs.map(([i]) => i), [0]);
  assert.deepEqual(all.events.map(([i]) => i), [1]);
});

test('a run noted after the last frame of a flush goes with that flush, before the next frame', () => {
  const posts = [];
  const recorder = new SessionRecorder({ now: () => 0, post: (body) => posts.push(JSON.parse(body)) });
  const car = newCar();
  const driver = new physics.KeyboardDriver();
  recorder.frame(car, { forward: 1 }, 1 / 120, driver, false, 1, 0);
  recorder.run({ tick: 1, seed: 3, x: 0, z: 0, reason: 'teleport', elapsed: 0 }, car, driver);
  recorder.flush();
  assert.deepEqual(posts[0].runs.map(([i]) => i), [1], 'index 1: before the first frame of the next chunk');
  // with nothing recorded yet, a note waits for the next flush
  const early = new SessionRecorder({ now: () => 0, post: (body) => posts.push(JSON.parse(body)) });
  early.run({ tick: 0, seed: 3, x: 0, z: 0, reason: 'start', elapsed: 0 }, car, driver);
  early.flush();
  early.frame(car, { forward: 1 }, 1 / 120, driver, false, 1, 0);
  early.flush();
  assert.deepEqual(posts.at(-1).runs.map(([i]) => i), [0]);
});

test('the build is the git commit when the server shows .git, and always a hash of the modules\' text', async () => {
  const files = {
    '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': `${'a'.repeat(40)}\n`,
    '/js/a.js': 'export const a = 1;', '/js/b.js': 'export const b = 2;'
  };
  const fetchText = async (url) => files[url] ?? null;
  const build = await recorderModule.buildId(['/js/b.js', '/js/a.js'], fetchText);
  assert.equal(build.commit, 'a'.repeat(40));
  assert.equal(build.modules, 2);
  assert.match(build.hash, /^[0-9a-f]{8}$/);
  files['/js/b.js'] = 'export const b = 3;';
  const changed = await recorderModule.buildId(['/js/a.js', '/js/b.js'], fetchText);
  assert.notEqual(changed.hash, build.hash, 'a change to a module changes the hash');
  const noGit = await recorderModule.buildId(['/js/a.js'], async (url) => (url.startsWith('.git') ? null : files[url]));
  assert.equal(noGit.commit, null);
});
