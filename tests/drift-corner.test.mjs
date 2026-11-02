import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { CornerPath, fitCorner, sizeCorner } from '../js/drift-corner.js';
import { footprintOff } from '../js/swim-carriageway.js';
import { avenueX, streetZ } from '../js/city-config.js';

// A drifted corner as a path fitted to the road (drift-corner.js): its geometry, the fit that keeps the sideways body
// on the carriageway, and the autopilot holding a slide round it on the keys

const RAD = Math.PI / 180;
const require = createRequire(import.meta.url);
const { loadModule } = require('./helpers/module.cjs');
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// Two streets 16 m wide meeting at the origin: one running south (+z) down x = 0, one running west (-x) along z = 0
const HALF = 8;
const road = {
  footprintOff(x, z, heading, margin = 0) {
    const s = Math.sin(heading), c = Math.cos(heading);
    const w = 0.97 + margin, l = 2.52 + margin;
    let off = 0;
    for (const [a, b] of [[-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0]]) {
      const px = x + c * a * w + s * b * l, pz = z - s * a * w + c * b * l;
      const onSouth = Math.abs(px) <= HALF && pz <= HALF;
      const onWest = Math.abs(pz) <= HALF && px <= HALF;
      if (!onSouth && !onWest) off++;
    }
    return off;
  }
};
// Down the south street, then right into the west one (a right turn: west is to the right of travelling south)
const RIGHT_TURN = { vertex: { x: 0, z: 0 }, ux: 0, uz: 1, vx: -1, vz: 0 };

test('a corner path: in along its entry line, round an arc tangent to both lines, out along its exit line', () => {
  // (lines 4 m to the outside: left of travel, + lateral, for a right turn)
  const path = new CornerPath({ ...RIGHT_TURN, entryLine: 4, exitLine: 4, radius: 20 });
  assert.equal(path.into, -1, 'a right turn');
  // The arc's centre is radius to the inside (right) of both lines
  assert.ok(Math.abs(path.cx - -16) < 1e-9 && Math.abs(path.cz - -16) < 1e-9, `centre (${path.cx}, ${path.cz})`);
  assert.ok(Math.abs(path.turnIn - (20 - 4)) < 1e-9, `turns in 16 m short of the vertex (${path.turnIn})`);
  const entry = path.locate(4, -40);
  assert.equal(entry.phase, 'entry');
  assert.ok(Math.abs(entry.out) < 1e-9, 'on the entry line');
  // (left of travel is the outside of a right turn: + out)
  assert.ok(path.locate(5, -40).out > 0.99, 'a metre left of the entry line is a metre wide');
  const mid = path.poses(1, 0, 0).find((p, i, all) => i === Math.floor(all.length / 2));
  const at = path.locate(mid.x, mid.z);
  assert.equal(at.phase, 'arc');
  assert.ok(Math.abs(at.out) < 1e-6 && Math.abs(at.progress - 0.5) < 0.05, `half way round, on the arc (${at.progress})`);
  assert.ok(Math.abs(wrap(at.heading - (-45 * RAD))) < 3 * RAD, 'pointing half way round to the west');
  const out = path.locate(-40, 4);
  assert.equal(out.phase, 'exit');
  assert.ok(Math.abs(out.out) < 1e-9, 'on the exit line');
});

test('the fitted corner keeps the sideways body on the road; an arc touching the inside edge does not', () => {
  // The old recipe's widest arc: lines 1.5 m in from corridors 1.4 m off the curb, apex on the inside corridor edge
  const entry = HALF - 2.9, inside = -(HALF - 1.4);
  const a = entry - inside, b = a;
  const old = new CornerPath({ ...RIGHT_TURN, entryLine: entry, exitLine: entry, radius: a + b + Math.sqrt(2 * a * b) });
  assert.ok(old.offRoad(road) > 0, `the old arc puts the slide over the inside curb (${old.offRoad(road)} points)`);
  const fitted = fitCorner(RIGHT_TURN, { entry, exit: entry, entryInside: inside, exitInside: inside }, road);
  assert.ok(fitted.fits, 'a corner that fits');
  assert.equal(fitted.offRoad(road), 0);
  assert.ok(fitted.radius >= 12 && fitted.radius < old.radius, `on a tighter arc (${fitted.radius.toFixed(1)} m)`);
  // ...and tightened for a slower slide, still on the road
  const slower = sizeCorner(fitted, 13, road);
  assert.ok(slower.radius < fitted.radius && slower.offRoad(road) === 0, `13 m for a slow one (${slower.radius})`);
  assert.equal(sizeCorner(fitted, 200, road), fitted, 'never wider than the fit');
});

test('Manhattan\'s corners of the show\'s run fit on the carriageway', () => {
  const carriageway = { footprintOff };
  // 8th Ave north into 57th St west (left), on the corridors swim-show.js gives those streets
  const corner = { vertex: { x: avenueX('8'), z: streetZ(57) - 3.5 }, ux: 0, uz: -1, vx: -1, vz: 0 };
  const fitted = fitCorner(corner, { entry: -7.15, exit: -2.17, entryInside: 9.55, exitInside: 11.53 }, carriageway);
  assert.ok(fitted.fits, `8th Ave into 57th St fits (R ${fitted.radius.toFixed(1)}, ${fitted.off ?? 0} off)`);
  assert.equal(fitted.offRoad(carriageway), 0);
});

test('with a road, the autopilot drifts a corner round its fitted path on the keys: sideways over most of the turn, its body never off the road', () => {
  const physics = loadModule(read('js/drift-physics.js'));
  const corner = loadModule(read('js/drift-corner.js'), { imports: { './swim-recovery.js': loadModule(read('js/swim-recovery.js')) } });
  const { DriftAutopilot } = loadModule(read('js/drift-autopilot.js'), { imports: { './drift-physics.js': physics, './drift-corner.js': corner } });
  // (the corridors 1.4 m off the curb either side, as swim-show.js routeCorridors makes them)
  const band = { left: HALF - 1.4, right: -(HALF - 1.4), centre: null };
  const pilot = new DriftAutopilot({ road, cruiseSpeed: 30 });
  const driver = new physics.KeyboardDriver();
  pilot.setPath([{ x: 0, z: -300 }, { x: 0, z: 0 }, { x: -300, z: 0 }], { corridors: [band, band] });
  const c = { position: { x: 0, z: -300 }, heading: 0, speed: 28, vx: 0, vz: 0, angularVel: 0, steerAngle: 0 };
  const frame = 1 / 120;
  let off = 0, spell = 0, longest = 0, slid = 0, t = 0;
  while (t < 25 && !pilot.finished) {
    const keys = pilot.update(c, frame, [], driver);
    const input = driver.update(c, keys, frame);
    for (let i = 0; i < 2; i++) physics.stepDriftCar(c, input, frame / 2);
    t += frame;
    const near = Math.hypot(c.position.x, c.position.z) < 40;
    if (near) off += road.footprintOff(c.position.x, c.position.z, c.heading);
    const vx = Math.sin(c.heading) * c.speed + c.vx, vz = Math.cos(c.heading) * c.speed + c.vz;
    const slide = Math.abs(wrap(c.heading - Math.atan2(vx, vz)));
    spell = near && slide > 15 * RAD ? spell + frame : 0;
    longest = Math.max(longest, spell);
    if (near && slide > 15 * RAD) slid += frame;
  }
  assert.ok(pilot.finished || c.position.x < -150, `round the corner and down the new street (${c.position.x.toFixed(0)}, ${c.position.z.toFixed(0)})`);
  assert.equal(off, 0, 'its body never off the road');
  assert.ok(longest >= 1, `one unbroken slide of a second or more (${longest.toFixed(2)} s)`);
});

function wrap(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
