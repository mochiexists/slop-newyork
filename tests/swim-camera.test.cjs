const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const kick = loadModule(readFileSync(join(__dirname, '../js/swim-camera-kick.js'), 'utf8'));
const { SwimCamera } = loadModule(readFileSync(join(__dirname, '../js/swim-camera.js'), 'utf8'), { imports: { './swim-camera-kick.js': kick } });

const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} vs ${expected}`);

test('the chase camera swings to a drifting car\'s camera yaw, and leaves any other entity\'s framing alone', () => {
  const swim = new SwimCamera();
  const cameras = { orbitYawOffset: 0 };
  const framing = () => ({ pos: { x: 1, y: 2, z: 3 }, look: { x: 4, y: 5, z: 6 } });
  const taxi = { position: { x: 10, y: 0, z: 20 }, heading: 0 };
  const plain = framing();
  swim.swingChase(cameras, taxi, plain.pos, plain.look, 7);
  assert.deepEqual(plain, framing(), 'no camera yaw: cameras.js\'s framing as it was');

  // Facing +z but the camera swung a quarter turn to +x: 7 m back along -x, looking 5.2 m along +x; heights kept
  const drifting = { ...taxi, cameraYaw: Math.PI / 2 };
  const swung = framing();
  swim.swingChase(cameras, drifting, swung.pos, swung.look, 7);
  close(swung.pos.x, 3, 'camera x');
  close(swung.pos.z, 20, 'camera z');
  close(swung.look.x, 15.2, 'look x');
  close(swung.look.z, 20, 'look z');
  assert.equal(swung.pos.y, 2);
  assert.equal(swung.look.y, 5);
});

test('the chase camera falls back as the car pulls and comes in again as it stops pulling', () => {
  const swim = new SwimCamera();
  for (let i = 0; i < 600; i++) swim.fallBack({ longAccel: 9 }, 1 / 60);
  close(swim.launchLag, 0.4 * 9, 'settled 0.4 m per m/s²');
  for (let i = 0; i < 600; i++) swim.fallBack({}, 1 / 60);
  assert.ok(swim.launchLag < 1e-3, 'nothing without drift physics');
});
