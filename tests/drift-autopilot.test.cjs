const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const physics = loadModule(readFileSync(join(__dirname, '../js/drift-physics.js'), 'utf8'));
const { DriftAutopilot } = loadModule(readFileSync(join(__dirname, '../js/drift-autopilot.js'), 'utf8'), {
  imports: { './drift-physics.js': physics, './drift-corner.js': loadModule(readFileSync(join(__dirname, '../js/drift-corner.js'), 'utf8'), {
    imports: { './swim-recovery.js': loadModule(readFileSync(join(__dirname, '../js/swim-recovery.js'), 'utf8')) }
  }) }
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

test('it drifts Manhattan\'s 90° corners at speed: a wide entry, a 35-48° slide on the widest arc the streets allow, out flat on the new street', () => {
  // The show's run, squared up: down 7th Ave (one-way, 15 m), right into 42nd St (two-way, on the westbound half),
  // right up 8th Ave (one-way, 21 m), with the corridors swim-show.js routeCorridors gives those streets
  const route = [{ x: 0, z: 0 }, { x: 0, z: 230 }, { x: -275, z: 230 }, { x: -275, z: -300 }];
  const corridors = [{ left: 6, right: -6, centre: null }, { left: 11.6, right: -2.6, centre: 4.5 }, { left: 9.5, right: -8.6, centre: null }];
  const pilot = new DriftAutopilot({ cruiseSpeed: 40, lanes: 2, laneWidth: 2.8 });
  const driver = new physics.KeyboardDriver();
  pilot.setPath(route, { corridors });
  const c = car(0);
  c.speed = 38;
  // Per corner, in the frames of the street before it and after it
  const corners = [1, 2].map((k) => {
    const a = route[k - 1], b = route[k], next = route[k + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z), out = Math.hypot(next.x - b.x, next.z - b.z);
    return {
      b, length, ux: (b.x - a.x) / length, uz: (b.z - a.z) / length, vx: (next.x - b.x) / out, vz: (next.z - b.z) / out,
      start: null, slowest: Infinity, slip: 0, wide: 0, back: null, at80: null, outside: corridors[k].left
    };
  });
  let t = 0;
  while (t < 30 && !pilot.finished) {
    const { tel } = frame(pilot, driver, c, []);
    t += FRAME;
    const ground = Math.hypot(c.speed, c.vx, c.vz);
    for (const k of corners) {
      const dx = c.position.x - k.b.x, dz = c.position.z - k.b.z;
      const toCorner = -(dx * k.ux + dz * k.uz);
      // along the new street, and across it (+ left of travel: both corners turn right, so + is the outside)
      const along = dx * k.vx + dz * k.vz, across = dx * k.vz - dz * k.vx;
      if (k.start === null && toCorner < 60) k.start = t;
      if (k.start === null) continue;
      if (toCorner < 30 && along < 40) {
        k.slowest = Math.min(k.slowest, ground);
        k.slip = Math.max(k.slip, Math.abs(tel.slipAngle));
        if (along > -5) k.wide = Math.max(k.wide, across);
      }
      if (k.back === null && along > 5 && ground > 30) k.back = t - k.start;
      if (k.at80 === null && along > 80) k.at80 = ground;
    }
  }
  for (const [i, k] of corners.entries()) {
    const name = `corner ${i + 1}`;
    // (the arc from the outside of one street to the outside of the next, shapeCorner: ~40-50 m at 18-21 m/s, the slide
    // scrubbing a few m/s off that; the old recipe's 24 m arc held 11-12 m/s)
    assert.ok(k.slowest > 12, `${name}: never slower than 12 m/s through it (${k.slowest.toFixed(1)} m/s)`);
    assert.ok(k.slip > 35 * RAD && k.slip < 48 * RAD, `${name}: a 35-48° slide (${(k.slip / RAD).toFixed(0)}°)`);
    assert.ok(k.wide < k.outside, `${name}: on the new street, ${k.wide.toFixed(1)} m out of its ${k.outside} m to the outside`);
    assert.ok(k.back !== null && k.back < 7.5, `${name}: back at 30 m/s within 7.5 s of 60 m out (${k.back?.toFixed(2)} s)`);
    assert.ok(k.at80 > 27, `${name}: flat out of it, ${k.at80?.toFixed(1)} m/s 80 m down the new street`);
  }
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

test('a flick back across at 85 mph is caught on its line: no slide for the keyboard driver to read as a save', () => {
  // Codex's round-1 reproduction (2026-10-31): swinging from x 4.9 back toward 1.25 the tail stepped out (18°), the
  // driver's save unwound the held counter-steer and the car slid on into the third car at 3.58 s
  const { vehicleContact } = loadModule(readFileSync(join(__dirname, '../js/vehicle-physics.js'), 'utf8'));
  const traffic = [[-2.5, 49, 3], [5.75, 109, 5], [-4, 86, 5], [1, 59, 3]]
    .map(([x, z, speed]) => ({ x, z, speed, yaw: 0, half: 2.3, halfWidth: 0.95 }));
  const c = car(0);
  c.speed = 38;
  const pilot = new DriftAutopilot();
  const driver = new physics.KeyboardDriver();
  pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 1000 }], { corridors: [{ left: 7, right: -7, centre: null }] });
  let contacts = 0, slip = 0;
  for (let n = 0; n < 600; n++) {
    const { tel } = frame(pilot, driver, c, traffic);
    slip = Math.max(slip, Math.abs(tel.slipAngle));
    for (const o of traffic) {
      o.z += o.speed / 60;
      const a = { x: c.position.x, z: c.position.z, sin: Math.sin(c.heading), cos: Math.cos(c.heading), halfW: 0.97, halfL: 2.5 };
      const b = { x: o.x, z: o.z, sin: 0, cos: 1, halfW: 0.95, halfL: 2.3 };
      if (vehicleContact(a, b, {})) contacts++;
    }
  }
  assert.equal(contacts, 0);
  assert.ok(slip < 10 * RAD, `its flicks stay on the tires (${(slip / RAD).toFixed(1)}° of slip at most)`);
  assert.ok(c.position.z > 250, `and it got through (${c.position.z.toFixed(0)} m)`);
});

test('the hand-over count waits for clear road at speed: not with a queue ahead or a corner coming up', () => {
  // At 30 m/s up a straight 1 km avenue, its keyboard driver warmed up for a few frames
  function holds(traffic, route = [{ x: 0, z: 0 }, { x: 0, z: 1000 }]) {
    const c = car(0);
    c.speed = 30;
    const pilot = new DriftAutopilot({ cruiseSpeed: 45 });
    const driver = new physics.KeyboardDriver();
    pilot.setPath(route, { corridors: route.slice(1).map(() => ({ left: 3.3, right: -3.3, centre: null })) });
    for (let n = 0; n < 10; n++) frame(pilot, driver, c, traffic);
    return pilot.holdsSpeed(c, 29, 3);
  }
  assert.equal(holds([]), true, 'an empty avenue');
  // A queue standing across the street 90 m ahead: it can't keep 65 mph for three seconds
  const queue = [-3.3, 0, 3.3].map((x) => ({ x, z: 95, speed: 0, yaw: 0, half: 2.3, halfWidth: 0.95 }));
  assert.equal(holds(queue), false, 'a queue ahead');
  assert.equal(holds([], [{ x: 0, z: 0 }, { x: 0, z: 120 }, { x: 200, z: 120 }]), false, 'a drifted corner 120 m on');
});

test('two cars side by side at their lanes\' outer edges: the swimmer splits them, and is past before it moves on', () => {
  // A pair 5.2 m apart (centre to centre: 0.7 m of air either side of the swim car), with a car in the next lane either
  // side closing the rest of the street: the gap between them is the only way through, and leaves it between two lanes
  const { vehicleContact } = loadModule(readFileSync(join(__dirname, '../js/vehicle-physics.js'), 'utf8'));
  const traffic = [0.1 - 6.2, 0.1 - 2.6, 0.1 + 2.6, 0.1 + 6.2].map((x) => ({ x, z: 45, speed: 6, yaw: 0, half: 2.3, halfWidth: 0.92 }));
  const c = car(0);
  c.speed = 25;
  const pilot = new DriftAutopilot({ passMargin: 0.2, closeBonus: 60, splitBonus: 100 });
  const driver = new physics.KeyboardDriver();
  pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 1000 }], { corridors: [{ left: 7, right: -7, centre: null }] });
  const plan = pilot.planGap(c, traffic);
  assert.equal(plan.safe, true);
  assert.ok(Math.abs(pilot.targetOffset - 0.1) < 0.5, `it lines up on the gap (${pilot.targetOffset.toFixed(2)} m)`);
  let contacts = 0;
  for (let n = 0; n < 240; n++) {
    frame(pilot, driver, c, traffic);
    for (const o of traffic) {
      o.z += o.speed / 60;
      const a = { x: c.position.x, z: c.position.z, sin: Math.sin(c.heading), cos: Math.cos(c.heading), halfW: 0.97, halfL: 2.5 };
      const b = { x: o.x, z: o.z, sin: 0, cos: 1, halfW: 0.92, halfL: 2.3 };
      if (vehicleContact(a, b, {})) contacts++;
    }
  }
  assert.equal(contacts, 0);
  assert.ok(c.position.z > traffic[1].z + 10, 'and it went through');
});

test('turned 8° in a flick, the swimmer still plans the split of a pair a second ahead: it will be straight by then', () => {
  // The same pair, 35 m ahead at 30 m/s, the car lined up on the gap and running straight along the street, but its
  // nose swung 8° across it (the slide a flick leaves behind)
  const pair = [-2.6, 2.6].map((x) => ({ x, z: 35, speed: 6, yaw: 0, half: 2.3, halfWidth: 0.92 }));
  const c = car(8 * RAD);
  c.speed = 30;
  c.vx = -Math.sin(c.heading) * c.speed;
  c.vz = (1 - Math.cos(c.heading)) * c.speed;
  const pilot = new DriftAutopilot({ passMargin: 0.2, closeBonus: 60, splitBonus: 100 });
  pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 1000 }], { corridors: [{ left: 7, right: -7, centre: null }] });
  const plan = pilot.planGap(c, pair);
  assert.equal(plan.safe, true);
  assert.ok(Math.abs(pilot.targetOffset) < 0.4, `through the gap (${pilot.targetOffset.toFixed(2)} m)`);
});

test('still swinging from a flick, the swimmer counts its own turn carrying on: no plan through a gap it would clip', () => {
  // Codex's round-1 reproduction (2026-11-01): 8° across and swinging on at 1.2 rad/s, two parked cars either side 7 m
  // ahead; settling straight from 8° the gap looked safe, and the car touched one 0.08 s later at 13°
  const { vehicleContact } = loadModule(readFileSync(join(__dirname, '../js/vehicle-physics.js'), 'utf8'));
  const traffic = [-2.4, 2.4].map((x) => ({ x, z: 7, speed: 0, yaw: 0, half: 2.3, halfWidth: 0.92 }));
  const c = car(8 * RAD);
  c.speed = 30;
  c.vx = -Math.sin(c.heading) * c.speed;
  c.vz = (1 - Math.cos(c.heading)) * c.speed;
  c.angularVel = 1.2;
  const pilot = new DriftAutopilot({ passMargin: 0.2, closeBonus: 60, splitBonus: 100, lateBonus: 20, planSpread: 0.2 });
  pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 1000 }], { corridors: [{ left: 7, right: -7, centre: null }] });
  const plan = pilot.planGap(c, traffic);
  assert.equal(plan.safe, false, 'no safe way through');
  const driver = new physics.KeyboardDriver();
  let touched = false;
  for (let n = 0; n < 6 && !touched; n++) {
    frame(pilot, driver, c, traffic);
    const a = { x: c.position.x, z: c.position.z, sin: Math.sin(c.heading), cos: Math.cos(c.heading), halfW: 0.97, halfL: 2.5 };
    touched = traffic.some((o) => vehicleContact(a, { x: o.x, z: o.z, sin: 0, cos: 1, halfW: 0.92, halfL: 2.3 }, {}));
  }
  assert.ok(touched, 'and indeed there is none: the car clips one');
});

test('a pair to split coming up beyond its plans\' reach: the show\'s swimmer heads for the gap while the road is open', () => {
  // At 35 m/s a lane right of a pair's gap 110 m ahead, open road between
  const pair = [-2.6, 2.6].map((x) => ({ x, z: 110, speed: 6, yaw: 0, half: 2.3, halfWidth: 0.92 }));
  function target(options) {
    const c = car(0);
    c.position.x = -3.6;
    c.speed = 35;
    const pilot = new DriftAutopilot({ passMargin: 0.2, closeBonus: 60, splitBonus: 100, ...options });
    pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 1000 }], { corridors: [{ left: 7, right: -7, centre: null }] });
    pilot.targetOffset = c.position.x; // (the line it is on)
    pilot.planGap(c, pair);
    return pilot.targetOffset;
  }
  assert.ok(Math.abs(target({ splitLineUp: 20 })) < 0.4, 'lined up on the gap');
  assert.ok(target({}) < -3, 'without the wish it stays a lane off, in the open');
});

// The show's swimmer (swim-show.js SHOW_SWIMMING) on a 5-lane avenue's corridor
const SHOW_LIKE = { cruiseSpeed: 40, planSpread: 0.2, lateBonus: 20, passMargin: 0.2, closeBonus: 60, splitBonus: 100, splitLineUp: 20, lanes: 2, laneWidth: 2.8 };

test('a late flick it commits to goes when it planned: replanning never puts it off', () => {
  // Closing at 22 m/s on a car in its line, a car a lane over further on: it holds its line, then flicks round
  const traffic = [{ x: 0, z: 60, speed: 10, yaw: 0, half: 2.3, halfWidth: 0.92 }, { x: -3.6, z: 75, speed: 10, yaw: 0, half: 2.3, halfWidth: 0.92 }];
  const c = car(0);
  c.speed = 32;
  // (without the commit bonus for the line it is on, which here keeps it from choosing the flick at all)
  const pilot = new DriftAutopilot({ ...SHOW_LIKE, commitShare: 0 });
  pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 1000 }], { corridors: [{ left: 7, right: -7, centre: null }] });
  const driver = new physics.KeyboardDriver();
  let held = 0, lastFlick, contacts = 0;
  const { vehicleContact } = loadModule(readFileSync(join(__dirname, '../js/vehicle-physics.js'), 'utf8'));
  for (let n = 0; n < 180; n++) {
    frame(pilot, driver, c, traffic);
    for (const o of traffic) o.z += o.speed / 60;
    if (pilot.sincePlan === 0) {
      if (pilot.flickAt !== undefined) {
        held++;
        if (lastFlick !== undefined) assert.ok(pilot.flickAt <= lastFlick + 1e-9, `the flick at ${lastFlick.toFixed(2)} s was put off to ${pilot.flickAt.toFixed(2)} s`);
      }
      lastFlick = pilot.flickAt;
    }
    const a = { x: c.position.x, z: c.position.z, sin: Math.sin(c.heading), cos: Math.cos(c.heading), halfW: 0.97, halfL: 2.5 };
    if (traffic.some((o) => vehicleContact(a, { x: o.x, z: o.z, sin: 0, cos: 1, halfW: 0.92, halfL: 2.3 }, {}))) contacts++;
  }
  assert.ok(held > 0, 'it chose a late flick');
  assert.equal(contacts, 0);
  assert.ok(c.position.z > traffic[0].z + 10, 'and it got past');
});

test('it doesn\'t turn a move back within half a second of starting it, and the show\'s big bonuses get a real commit margin', () => {
  // A car dead ahead in its line, open road either side: either way round is as good
  const ahead = [{ x: 0, z: 40, speed: 8, yaw: 0, half: 2.3, halfWidth: 0.92 }];
  function choose(moveWay) {
    const c = car(0);
    c.speed = 30;
    const pilot = new DriftAutopilot(SHOW_LIKE);
    pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 1000 }], { corridors: [{ left: 7, right: -7, centre: null }] });
    pilot.clock = 10;
    if (moveWay) {
      // (a move that way started 0.2 s ago)
      pilot.moveWay = moveWay;
      pilot.moveStart = 9.8;
    }
    pilot.planGap(c, ahead);
    return Math.sign(pilot.targetOffset);
  }
  const free = choose(0);
  assert.notEqual(free, 0, 'it goes round one side');
  assert.equal(choose(-free), -free, 'a move the other way just started: it carries on round that side');
  const options = new DriftAutopilot(SHOW_LIKE).options;
  assert.ok(options.commitShare * options.splitBonus >= 20, 'next to a 100-point split, keeping its line is worth 20');
});

test('crawling up to a queue across the street, it knows it is queued; moving, or with nothing ahead, it is not', () => {
  const queue = [-3.3, 0, 3.3].map((x) => ({ x, z: 9, speed: 0, yaw: 0, half: 2.3, halfWidth: 0.95 }));
  function queued(speed, traffic) {
    const c = car(0);
    c.speed = speed;
    const pilot = new DriftAutopilot();
    pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 500 }], { corridors: [{ left: 3.3, right: -3.3, centre: null }] });
    pilot.planGap(c, traffic);
    return pilot.queued;
  }
  assert.equal(queued(0.5, queue), true, 'stopped behind it');
  assert.equal(queued(12, queue), false, 'still rolling at 12 m/s');
  assert.equal(queued(0.5, []), false, 'nothing ahead (pinned some other way: the show may back out)');
  const oncoming = queue.map((v) => ({ ...v, yaw: Math.PI }));
  assert.equal(queued(0.5, oncoming), false, 'nose to nose with oncoming cars: the wrong lane, not a queue');
});

test('scraping along a wall at a crawl, the slide it reads is the wall\'s push: it stays on the gas to get away', () => {
  // The browser show stuck here for a minute after a wide corner put it on the sidewalk: a building face held its
  // velocity ~10° off its nose at 2-7 m/s, past swimSlip, so the swimmer lifted for a "slide" and sawed at the keys
  const pilot = new DriftAutopilot();
  pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 400 }]);
  const driver = new physics.KeyboardDriver();
  const c = car();
  c.position.x = 4.7;
  c.position.z = 20;
  let gas = 0, frames = 0;
  for (let t = 0; t < 2; t += FRAME) {
    // the wall: 3 m/s along the street, its velocity pushed 10° off the car's heading every frame
    c.heading = 0;
    c.angularVel = 0;
    c.speed = 3;
    c.vx = 3 * Math.sin(10 * RAD);
    c.vz = 3 * Math.cos(10 * RAD);
    const keys = pilot.update(c, FRAME, [], driver);
    driver.update(c, keys, FRAME);
    gas += keys.forward;
    frames++;
  }
  assert.ok(gas > frames * 0.8, `W held (${gas} of ${frames} frames)`);
});

// A red light's queue ahead, the AI rolling up to it at 30 mph: it swims past through whatever is free, never stopping
function pastQueue({ queue, corridor, oncomingTraffic = [] }) {
  const { vehicleContact } = loadModule(readFileSync(join(__dirname, '../js/vehicle-physics.js'), 'utf8'));
  const traffic = [...queue.map((x) => ({ x, z: 80, speed: 0, yaw: 0, half: 2.3, halfWidth: 0.92 })), ...oncomingTraffic];
  const c = car(0);
  c.speed = 13;
  const pilot = new DriftAutopilot({ ...SHOW_LIKE, lanes: undefined, laneWidth: undefined });
  const driver = new physics.KeyboardDriver();
  pilot.setPath([{ x: 0, z: 0 }, { x: 0, z: 1000 }], { corridors: [corridor] });
  let slowest = Infinity, contacts = 0, widest = 0;
  for (let n = 0; n < 9 * 60; n++) {
    frame(pilot, driver, c, traffic);
    for (const o of oncomingTraffic) o.z -= o.speed / 60;
    if (c.position.z < 90) slowest = Math.min(slowest, c.speed);
    widest = Math.max(widest, c.position.x);
    const a = { x: c.position.x, z: c.position.z, sin: Math.sin(c.heading), cos: Math.cos(c.heading), halfW: 0.97, halfL: 2.5 };
    if (traffic.some((o) => vehicleContact(a, { x: o.x, z: o.z, sin: Math.sin(o.yaw), cos: Math.cos(o.yaw), halfW: 0.92, halfL: 2.3 }, {}))) contacts++;
  }
  return { slowest, contacts, widest, z: c.position.z };
}

test('a red light\'s queue across most of an avenue: it takes the free lane past it and never stops', () => {
  const r = pastQueue({ queue: [-5.4, -1.8, 1.8], corridor: { left: 7, right: -7, centre: null } });
  assert.equal(r.contacts, 0);
  assert.ok(r.slowest > 5, `it never waits (${r.slowest.toFixed(1)} m/s at slowest)`);
  assert.ok(r.z > 120, `and is past the queue (${r.z.toFixed(0)} m)`);
});

test('a queue across its half of a two-way street: it goes round through the clear oncoming half', () => {
  // 42nd St's corridor about the westbound line (swim-show.js routeCorridors): the centre line 4.5 m to its left
  const corridor = { left: 11.6, right: -2.6, centre: 4.5 };
  const r = pastQueue({ queue: [-1.4, 2.6], corridor });
  assert.equal(r.contacts, 0);
  assert.ok(r.widest > corridor.centre, `round through the oncoming half (${r.widest.toFixed(1)} m across)`);
  assert.ok(r.slowest > 5, `without waiting (${r.slowest.toFixed(1)} m/s at slowest)`);
  // ...and not into a car coming the other way there
  const busy = pastQueue({ queue: [-1.4, 2.6], corridor, oncomingTraffic: [{ x: 8, z: 150, speed: 10, yaw: Math.PI, half: 2.3, halfWidth: 0.92 }] });
  assert.equal(busy.contacts, 0, 'no contact with the oncoming car');
});
