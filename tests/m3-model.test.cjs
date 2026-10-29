const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const model = loadModule(read('js/m3-model.js'), {
  imports: { 'three/webgpu': {}, 'three/tsl': {} },
  globals: { Promise, Math }
});
const { WHEELBASE, carFrameFromWheels, toCarFrame, modelWheelKey, steeringWheelPose, modelAvailable, loadSwimCarModel } = model;

const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

// The Sketchfab model's wheel hubs after the bake (glTF scene units, y up): it faces -z, its left is -x, and it is
// at 0.868 of real size
const SKETCHFAB_WHEELS = {
  lf: { x: -0.768, y: 0.038, z: -1.233 },
  rf: { x: 0.769, y: 0.038, z: -1.233 },
  lr: { x: -0.753, y: 0.045, z: 1.22 },
  rr: { x: 0.753, y: 0.045, z: 1.22 }
};
const SKETCHFAB_RADIUS = 0.305;

test('the Sketchfab model turns round to face +z, scales to the M3 wheelbase and stands on the road', () => {
  const frame = carFrameFromWheels(SKETCHFAB_WHEELS, SKETCHFAB_RADIUS);
  near(frame.scale, WHEELBASE / 2.453, 1e-3);
  near(Math.abs(frame.yaw), Math.PI, 1e-3);

  const lf = toCarFrame(frame, SKETCHFAB_WHEELS.lf);
  const rf = toCarFrame(frame, SKETCHFAB_WHEELS.rf);
  const lr = toCarFrame(frame, SKETCHFAB_WHEELS.lr);
  // front axle ahead (+z), rear behind, the axle midpoint at the origin
  near((lf.z + rf.z) / 2, WHEELBASE / 2, 1e-3);
  near(lr.z, -WHEELBASE / 2, 2e-3);
  // the car's left (+x in the car frame) is the model's left
  assert.ok(lf.x > 0.85 && rf.x < -0.85, `left ${lf.x}, right ${rf.x}`);
  // the tyres touch y = 0
  near((lf.y + lr.y) / 2 - SKETCHFAB_RADIUS * frame.scale, 0, 1e-9);
});

test('a model already in the car frame is left alone, one facing +x is turned a quarter', () => {
  const inFrame = {
    lf: { x: 0.8, y: 0.35, z: 1.43 }, rf: { x: -0.8, y: 0.35, z: 1.43 },
    lr: { x: 0.8, y: 0.35, z: -1.43 }, rr: { x: -0.8, y: 0.35, z: -1.43 }
  };
  const identity = carFrameFromWheels(inFrame, 0.35);
  near(identity.scale, 1);
  near(identity.yaw, 0);
  for (const key of ['x', 'y', 'z']) near(identity.position[key], 0);

  // nose toward +x, left toward -z, in centimetres
  const sideways = {
    lf: { x: 143, y: 35, z: -80 }, rf: { x: 143, y: 35, z: 80 },
    lr: { x: -143, y: 35, z: -80 }, rr: { x: -143, y: 35, z: 80 }
  };
  const frame = carFrameFromWheels(sideways, 35);
  near(frame.scale, 0.01);
  near(frame.yaw, -Math.PI / 2);
  const lf = toCarFrame(frame, sideways.lf);
  near(lf.x, 0.8, 1e-9);
  near(lf.y, 0.35, 1e-9);
  near(lf.z, 1.43, 1e-9);
});

test('swim wheels map to model wheels by side and axle', () => {
  assert.equal(modelWheelKey(true, true), 'lf');
  assert.equal(modelWheelKey(false, true), 'rf');
  assert.equal(modelWheelKey(true, false), 'lr');
  assert.equal(modelWheelKey(false, false), 'rr');
});

test('the hands grip the steering wheel rim, not the column under it', () => {
  // a rim of radius 0.2 m round (0.4, 0.85, 0.3), raked 21 degrees (top forward), and a column below and ahead of it
  const centre = { x: 0.4, y: 0.85, z: 0.3 };
  const rake = (21 * Math.PI) / 180;
  const points = [];
  for (let a = 0; a < 360; a += 2) {
    const u = Math.cos((a * Math.PI) / 180) * 0.2, v = Math.sin((a * Math.PI) / 180) * 0.2;
    points.push(centre.x + u, centre.y + v * Math.cos(rake), centre.z + v * Math.sin(rake));
  }
  for (let t = 0; t <= 1; t += 0.05) points.push(centre.x + 0.03, centre.y - 0.1 - t * 0.1, centre.z + 0.1 + t * 0.3);
  const pose = steeringWheelPose(points);
  near(pose.centre.x, centre.x, 1e-6);
  near(pose.centre.y, centre.y, 0.01);
  near(pose.centre.z, centre.z, 0.01);
  near(pose.tilt, rake, 0.02);
  near(pose.radius, 0.2 - 0.015, 1e-6);
});

test('the model is only used when a HEAD request for it succeeds', async () => {
  const calls = [];
  const answer = (ok) => async (url, init) => {
    calls.push([url, init.method]);
    return { ok, status: ok ? 200 : 404 };
  };
  assert.equal(await modelAvailable('assets/models/m3.glb', answer(true)), true);
  assert.equal(await modelAvailable('assets/models/m3.glb', answer(false)), false);
  assert.deepEqual(calls, [['assets/models/m3.glb', 'HEAD'], ['assets/models/m3.glb', 'HEAD']]);
  assert.equal(await modelAvailable('assets/models/m3.glb', async () => { throw new TypeError('offline'); }), false);
  assert.equal(await modelAvailable('assets/models/m3.glb', undefined), false);
});

test('without the model (the minimal build) loading resolves to null and leaves the car alone', async () => {
  const entity = { chassisPivot: { children: [] }, wheels: [] };
  const result = await loadSwimCarModel(entity, null, { fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(result, null);
  assert.deepEqual(entity, { chassisPivot: { children: [] }, wheels: [] });
});
