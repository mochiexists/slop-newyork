const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const physics = loadModule(readFileSync(join(__dirname, '../js/drift-physics.js'), 'utf8'));
const { DriftAutopilot, DonutRoutine } = loadModule(readFileSync(join(__dirname, '../js/drift-autopilot.js'), 'utf8'), {
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
  let maxSlip = 0, maxDeviation = 0, topSpeed = 0, hits = 0, t = 0;
  while (t < 45 && !pilot.finished) {
    const tel = physics.stepDriftCar(c, pilot.update(c, DT, traffic), DT);
    maxSlip = Math.max(maxSlip, Math.abs(tel.slipAngle));
    maxDeviation = Math.max(maxDeviation, distanceToRoute(route, c.position));
    topSpeed = Math.max(topSpeed, c.speed);
    for (const o of traffic) if (Math.hypot(o.x - c.position.x, o.z - c.position.z) < 2.6) hits++;
    t += DT;
  }
  assert.ok(pilot.finished, 'reaches the end of the route');
  assert.equal(hits, 0, 'never touches the traffic it weaves through');
  assert.ok(maxSlip > 25 * RAD, `drifts the corners (${(maxSlip / RAD).toFixed(0)}°)`);
  assert.ok(topSpeed > 30, `fast on the straights (${topSpeed.toFixed(0)} m/s)`);
  assert.ok(maxDeviation < 25, `stays near the route (${maxDeviation.toFixed(1)} m)`);
});

test('a donut pivots on its spot with the tail sliding round', () => {
  const c = car(0.3);
  c.position.x = 10;
  c.position.z = -5;
  const tel = {};
  const donut = DonutRoutine.from(c, { direction: 1 });
  const pivot = { ...donut.pivot };
  const start = c.heading;
  for (let t = 0; t < 6; t += DT) donut.update(c, DT, tel);
  assert.ok(c.heading - start > 2 * Math.PI, 'more than a full turn in six seconds');
  const nose = { x: c.position.x + Math.sin(c.heading) * 1.15, z: c.position.z + Math.cos(c.heading) * 1.15 };
  assert.ok(Math.hypot(nose.x - pivot.x, nose.z - pivot.z) < 1e-6, 'the nose stays on its pivot');
  assert.equal(tel.wheelspin, 1);
  assert.ok(tel.rearSlide > 5 && Math.abs(tel.slipAngle) > 60 * RAD, 'smoke and a sideways score');
});
