const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const physics = loadModule(readFileSync(join(__dirname, '../js/drift-physics.js'), 'utf8'));
const { DriftAutopilot, DriftCircle } = loadModule(readFileSync(join(__dirname, '../js/drift-autopilot.js'), 'utf8'), {
  imports: { './drift-physics.js': physics }
});

const DT = 1 / 240;
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

test('the AI drives a city block loop, drifting the corners and weaving round traffic', () => {
  const route = [{ x: 0, z: 0 }, { x: 0, z: 250 }, { x: 250, z: 250 }, { x: 250, z: 0 }];
  const traffic = [{ x: 0, z: 120 }, { x: 3.3, z: 160 }, { x: 0, z: 200 }];
  const pilot = new DriftAutopilot();
  pilot.setPath(route);
  const c = car();
  let maxSlip = 0, maxDeviation = 0, topSpeed = 0, hits = 0, closestPass = Infinity, t = 0;
  while (t < 45 && !pilot.finished) {
    const tel = physics.stepDriftCar(c, pilot.update(c, DT, traffic), DT);
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
    t += DT;
  }
  assert.ok(pilot.finished, 'reaches the end of the route');
  assert.equal(hits, 0, 'never touches the traffic it weaves through');
  assert.ok(closestPass < 1.5, `and passes it close, the way a swimmer does (${closestPass.toFixed(2)} m)`);
  assert.ok(maxSlip > 25 * RAD, `drifts the corners (${(maxSlip / RAD).toFixed(0)}°)`);
  assert.ok(topSpeed > 30, `fast on the straights (${topSpeed.toFixed(0)} m/s)`);
  assert.ok(maxDeviation < 25, `stays near the route (${maxDeviation.toFixed(1)} m)`);
});

test('a drift circle orbits the cop car nose-in, counter-steered, and drives out at speed', () => {
  // Parked after a burnout, 10 m from the cruiser
  const c = car(0.3);
  c.position.x = 10;
  const cop = { x: 0, z: 0 };
  const tel = {};
  const circle = DriftCircle.around(c, cop, { direction: 1 });
  let swept = 0, closest = Infinity, previous = Math.atan2(c.position.x, c.position.z);
  for (let t = 0; t < 12; t += DT) {
    circle.update(c, DT, tel);
    const bearing = Math.atan2(c.position.x, c.position.z);
    swept += Math.atan2(Math.sin(bearing - previous), Math.cos(bearing - previous));
    previous = bearing;
    if (t > 4) closest = Math.min(closest, Math.hypot(c.position.x, c.position.z));
  }
  assert.ok(Math.abs(swept) > 2 * Math.PI, `more than a lap round the cop in twelve seconds (${swept.toFixed(1)} rad)`);
  assert.ok(closest > 8.5, `keeps its distance from the cop (${closest.toFixed(1)} m)`);
  const ground = Math.hypot(c.speed, c.vx, c.vz);
  assert.ok(ground > 8 && ground < 12, `a steady power-slide speed (${ground.toFixed(1)} m/s)`);
  assert.ok(Math.abs(tel.slipAngle) > 35 * RAD && Math.abs(tel.slipAngle) < 50 * RAD, 'well sideways, not spinning');
  assert.ok(Math.sign(c.steerAngle) === -Math.sign(c.angularVel), 'the front wheels are counter-steered');
  assert.ok(tel.rearSlide > 5 && tel.wheelspin === 1, 'smoke');

  // Straightening out hands back a car that is still moving along the circle's tangent
  circle.exiting = true;
  for (let t = 0; t < 1.5; t += DT) circle.update(c, DT, tel);
  assert.ok(Math.abs(tel.slipAngle) < 20 * RAD, 'the angle comes off');
  assert.ok(c.speed > 8, 'and it leaves at speed');
});

test('a player drift circle carries on from the line the car is sliding along', () => {
  const c = car(0);
  c.speed = 9;
  const circle = DriftCircle.from(c, { direction: -1 });
  assert.ok(Math.abs(circle.center.x + 10) < 1e-9 && Math.abs(circle.center.z) < 1e-9, 'centre off the right side');
  const tel = {};
  circle.update(c, DT, tel);
  assert.ok(Math.hypot(c.position.x, c.position.z - 9 * DT) < 0.01, 'no jump on the first step');
  for (let t = 0; t < 3; t += DT) circle.update(c, DT, tel);
  assert.ok(c.angularVel < 0, 'turning right');
  assert.ok(Math.abs(Math.hypot(c.position.x - circle.center.x, c.position.z - circle.center.z) - 10) < 0.5, 'on its circle');
});
