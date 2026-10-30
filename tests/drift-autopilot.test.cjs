const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const physics = loadModule(readFileSync(join(__dirname, '../js/drift-physics.js'), 'utf8'));
const { DriftAutopilot } = loadModule(readFileSync(join(__dirname, '../js/drift-autopilot.js'), 'utf8'), {
  imports: { './drift-physics.js': physics }
});

const FRAME = 1 / 60;
const STEPS = 4;
const RAD = Math.PI / 180;

function car(heading = 0) {
  return { position: { x: 0, z: 0 }, heading, speed: 0, vx: 0, vz: 0, angularVel: 0, steerAngle: 0 };
}

function distanceToRoute(route, p) {
  let best = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1], dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t));
  }
  return best;
}

// The controllers' swim loop with the AI at the keys: one frame of keys at 60 Hz through the car's keyboard driver,
// then the physics in 240 Hz steps. Returns the last step's telemetry and the frame's keys.
function frame(pilot, driver, c, traffic) {
  const keys = pilot.update(c, FRAME, traffic, driver);
  for (const key of Object.values(keys)) assert.ok(key === 0 || key === 1, 'the AI only presses keys');
  const input = driver.update(c, keys, FRAME);
  let tel;
  for (let i = 0; i < STEPS; i++) tel = physics.stepDriftCar(c, input, FRAME / STEPS);
  return { tel, keys };
}

test('the AI drives a city block loop on the keys, drifting the corners and weaving round traffic', () => {
  const route = [{ x: 0, z: 0 }, { x: 0, z: 250 }, { x: 250, z: 250 }, { x: 250, z: 0 }];
  const traffic = [{ x: 0, z: 120 }, { x: 3.3, z: 160 }, { x: 0, z: 200 }];
  const pilot = new DriftAutopilot();
  const driver = new physics.KeyboardDriver();
  pilot.setPath(route);
  const c = car();
  let maxSlip = 0, maxDeviation = 0, topSpeed = 0, hits = 0, closestPass = Infinity, t = 0, handbrake = 0;
  while (t < 45 && !pilot.finished) {
    const { tel, keys } = frame(pilot, driver, c, traffic);
    handbrake += keys.handbrake;
    maxSlip = Math.max(maxSlip, Math.abs(tel.slipAngle));
    maxDeviation = Math.max(maxDeviation, distanceToRoute(route, c.position));
    topSpeed = Math.max(topSpeed, c.speed);
    // Bodies overlapping: the parked cars (2.3 m half length, 0.95 m half width, facing the route) against the M5's
    for (const o of traffic) {
      const dx = o.x - c.position.x, dz = o.z - c.position.z;
      const sin = Math.abs(Math.sin(c.heading)), cos = Math.abs(Math.cos(c.heading));
      const along = 2.3 + 2.5 * cos + 0.97 * sin, across = 0.95 + 2.5 * sin + 0.97 * cos;
      if (Math.abs(dz) < along && Math.abs(dx) < across) hits++;
      if (Math.abs(dz) < along) closestPass = Math.min(closestPass, Math.abs(dx) - across);
    }
    t += FRAME;
  }
  assert.ok(pilot.finished, 'reaches the end of the route');
  assert.ok(handbrake > 0, 'flicks the handbrake into the corners');
  assert.equal(hits, 0, 'never touches the traffic it weaves through');
  assert.ok(closestPass < 1.5, `and passes it close, the way a swimmer does (${closestPass.toFixed(2)} m)`);
  assert.ok(maxSlip > 25 * RAD, `drifts the corners (${(maxSlip / RAD).toFixed(0)}°)`);
  assert.ok(topSpeed > 30, `fast on the straights (${topSpeed.toFixed(0)} m/s)`);
  assert.ok(maxDeviation < 25, `stays near the route (${maxDeviation.toFixed(1)} m)`);
});

test('weaving staggered traffic at 85 mph, the swimmer allows for its own car turned in a flick', () => {
  // Codex's round-2 reproduction: a contact at 2.7 s while the plan was marked safe, from a street-aligned own footprint
  const { vehicleContact } = loadModule(readFileSync(join(__dirname, '../js/vehicle-physics.js'), 'utf8'));
  const traffic = [[1.75, 51, 6], [3.5, 79, 2], [-5.75, 101, 9], [-1, 104, 12], [-0.25, 79, 4]]
    .map(([x, z, speed]) => ({ x, z, speed, yaw: 0, half: 2.3, halfWidth: 0.95 }));
  const c = car(0);
  c.speed = 38;
  const pilot = new DriftAutopilot();
  const driver = new physics.KeyboardDriver();
  pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 1000 }], { corridors: [{ left: 7, right: -7, centre: null }] });
  let contacts = 0;
  for (let n = 0; n < 420; n++) {
    frame(pilot, driver, c, traffic);
    for (const o of traffic) {
      o.z += o.speed / 60;
      const a = { x: c.position.x, z: c.position.z, sin: Math.sin(c.heading), cos: Math.cos(c.heading), halfW: 0.97, halfL: 2.5 };
      const b = { x: o.x, z: o.z, sin: 0, cos: 1, halfW: 0.95, halfL: 2.3 };
      if (vehicleContact(a, b, {})) contacts++;
    }
  }
  assert.equal(contacts, 0);
  assert.ok(c.position.z > 150, `and it got through (${c.position.z.toFixed(0)} m)`);
});
