// The drift as the player drives it on the keys (W/A/S/D/Space through the KeyboardDriver): time on W is the angle,
// the key into the turn turns the wheels into it until the angle nears the limit and they walk out to counter-lock from
// there, no key lets the wheels self-align and the gas carry the drift, a lift (with or without the opposite key) ends
// it without a tank-slapper, the opposite key held on the gas swings it into a drift the other way, a power-over works
// up to 90 mph, and the gearbox holds its gear.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const { M5_DRIFT, KeyboardDriver, stepDriftCar } = loadModule(readFileSync(join(__dirname, '../js/drift-physics.js'), 'utf8'));

const FRAME = 1 / 60;
const STEPS = 4;
const RAD = Math.PI / 180;

function keys(held) {
  return { forward: held.includes('W') ? 1 : 0, backward: 0, left: held.includes('A') ? 1 : 0, right: held.includes('D') ? 1 : 0, handbrake: held.includes('_') ? 1 : 0 };
}

// Plays [seconds, keys] steps from a car rolling at `speed`; a row per frame: time, the drift angle (+ a left drift,
// tail out to the right), the front wheels (+ left of the car), speed, gear, yaw rate and the position
function play(speed, script, car = { position: { x: 0, z: 0 }, heading: 0, speed, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0, drift: {} }) {
  const driver = new KeyboardDriver();
  const rows = [];
  let t = 0;
  for (const [seconds, held] of script) {
    for (const end = t + seconds; t < end - 1e-9; t += FRAME) {
      const input = driver.update(car, keys(held), FRAME);
      for (let i = 0; i < STEPS; i++) stepDriftCar(car, input, FRAME / STEPS, M5_DRIFT, car.drift);
      const lateral = car.vx * Math.cos(car.heading) - car.vz * Math.sin(car.heading);
      rows.push({ t, angle: -Math.atan2(lateral, Math.abs(car.speed)) / RAD, wheels: car.steerAngle / RAD, speed: Math.hypot(car.speed, car.vx, car.vz),
        gear: car.gear, yaw: car.angularVel / RAD, x: car.position.x, z: car.position.z, course: car.heading + Math.atan2(lateral, car.speed),
        held, throttle: input.throttle, pedal: driver.throttle });
    }
  }
  return rows;
}

// The most the front wheels turn in any quarter of a second over the rows, in degrees
function wheelSwing(rows) {
  const window = Math.round(0.25 / FRAME);
  let most = 0;
  for (let i = window; i < rows.length; i++) most = Math.max(most, Math.abs(rows[i].wheels - rows[i - window].wheels));
  return most;
}

const between = (rows, from, to) => rows.filter((r) => r.t >= from && r.t < to);

// Radius of the path over a span: distance travelled over the change of course
function radius(rows) {
  let distance = 0;
  for (let i = 1; i < rows.length; i++) distance += Math.hypot(rows[i].x - rows[i - 1].x, rows[i].z - rows[i - 1].z);
  return distance / Math.abs(rows.at(-1).course - rows[0].course);
}

// From `from`: when the angle has been under 5° for 0.3 s, and the most it swung past straight the other way
function exit(rows, from, side) {
  const span = rows.filter((r) => r.t >= from);
  const calm = span.findIndex((_, i) => span.slice(i, i + 18).length === 18 && span.slice(i, i + 18).every((r) => Math.abs(r.angle) < 5));
  const overshoot = Math.max(0, ...span.filter((r) => r.t < from + 2.5).map((r) => -side * r.angle));
  const crossing = span.find((r) => Math.abs(r.angle) < 5);
  return { calmAfter: calm < 0 ? Infinity : span[calm].t - from, overshoot, crossingYaw: Math.abs(crossing?.yaw ?? 0) };
}

// The brief's drift: on the gas from 50 mph to ~90, a touch of A, A with a Space tap, then A held
const ENTRY = [[3, 'W'], [0.3, 'WA'], [0.25, 'WA_']];
const HELD_FROM = 3.55;

test('holding W and A in a big 90 mph drift keeps it sideways and fast, the wheels into the turn until the angle nears the limit', () => {
  for (const side of [1, -1]) {
    const into = side > 0 ? 'A' : 'D';
    const rows = play(22, [[3, 'W'], [0.3, `W${into}`], [0.25, `W${into}_`], [7, `W${into}`]]);
    const held = between(rows, HELD_FROM, HELD_FROM + 7);
    const sideways = held.filter((r) => side * r.angle > 20).length * FRAME;
    assert.ok(sideways >= 5, `${into}: sideways past 20° for ${sideways.toFixed(1)} s`);
    assert.ok(Math.max(...held.map((r) => side * r.angle)) < 65, `${into}: without spinning (caught at the limit)`);
    // the key turns the wheels into the turn while the slide has room (the fade starts at 35°) ...
    const building = held.filter((r) => side * r.angle > 12 && side * r.angle < 33);
    const inward = building.filter((r) => side * r.wheels > 0).length / building.length;
    assert.ok(inward > 0.9, `${into}: the wheels point into the turn ${(inward * 100).toFixed(0)}% of the time below 33°`);
    // ... and past it walk out to the counter-lock the slide's angle needs, rather than snapping there (it was 46° of
    // wheel in a quarter of a second at 50°)
    assert.ok(wheelSwing(held) < 30, `${into}: the wheels swing at most ${wheelSwing(held).toFixed(0)}° in a quarter second`);
    // the gas carries the speed: a big fast drift, not a spiral down to a donut
    const slowest = Math.min(...held.map((r) => r.speed));
    assert.ok(slowest > 30, `${into}: still at ${slowest.toFixed(0)} m/s`);
  }
});

test('the gearbox holds its gear through a slide', () => {
  const rows = play(22, [...ENTRY, [7, 'WA']]);
  const slideGears = new Set(rows.filter((r) => Math.abs(r.angle) > 20).map((r) => r.gear));
  // it may come down a gear as the drift slows, never up
  const gears = rows.filter((r) => Math.abs(r.angle) > 20).map((r) => r.gear);
  assert.ok(gears.every((g, i) => i === 0 || g <= gears[i - 1]), `no upshift mid-slide: ${[...slideGears].join(', ')}`);
});

test('with no steering key the wheels self-align and the gas carries a big drift, wide and fast', () => {
  const rows = play(18, [...ENTRY, [2, 'WA'], [6, 'W']]);
  const free = between(rows, 6, 11.5);
  // (W held all along has let the angle out to the top: 50°, 5° short of the slip limit)
  assert.ok(free.every((r) => r.angle > 20 && r.angle < 56), `held between 20° and 56°: ${Math.min(...free.map((r) => r.angle)).toFixed(0)}..${Math.max(...free.map((r) => r.angle)).toFixed(0)}°`);
  // counter-steered: the wheels point along the front axle's path, right of the car in a left drift
  assert.ok(free.every((r) => r.wheels < -10), 'the wheels run out to the counter-steer by themselves');
  const r = radius(free);
  assert.ok(r > 60 && r < 200, `a big circle: ${r.toFixed(0)} m`);
  assert.ok(Math.min(...free.map((x) => x.speed)) > 30, 'at speed');
});

test('a lift, with or without the opposite key, ends a drift in about a second and a half, without a tank-slapper', () => {
  const settled = { 'A held': [...ENTRY, [4, 'WA']], 'no key': [...ENTRY, [2, 'WA'], [3, 'W']] };
  for (const [name, entry] of Object.entries(settled)) {
    const start = entry.reduce((sum, [seconds]) => sum + seconds, 0);
    // (the opposite key held on the gas is a transition: see below)
    for (const out of ['D', '']) {
      const rows = play(18, [...entry, [1.5, out], [2.5, 'W']]);
      const side = Math.sign(rows.find((r) => r.t >= start).angle);
      assert.equal(side, 1, `${name}: drifting left before the exit`);
      const { calmAfter, overshoot, crossingYaw } = exit(rows, start, side);
      const label = `${name}, then ${out || 'no keys'}`;
      assert.ok(calmAfter < 1.8, `${label}: straight after ${calmAfter.toFixed(2)} s`);
      assert.ok(overshoot < 8, `${label}: ${overshoot.toFixed(1)}° past straight the other way`);
      // (from 50°, where the gas now lets a held drift out to, rather than 30-36°: twice the angle to come back through
      // in the same second and a bit; the overshoot above is what tells a tank-slapper)
      assert.ok(crossingYaw < 85, `${label}: swinging through straight at ${crossingYaw.toFixed(0)}°/s`);
      const after = between(rows, start + 2.5, start + 4);
      assert.ok(after.every((r) => Math.abs(r.angle) < 5), `${label}: and stays straight on the gas`);
    }
  }
});

test('a tight donut from a standstill keeps going round on W and A', () => {
  const rows = play(0, [[1, 'WA'], [0.3, 'WA_'], [8, 'WA']]);
  const donut = between(rows, 2, 9.3);
  assert.ok(donut.filter((r) => r.angle > 20).length * FRAME > 6, 'sideways nearly all the time');
  assert.ok(radius(donut) < 12, `round a tight circle: ${radius(donut).toFixed(1)} m`);
});

test('a lift and a handbrake tap as the car swings through straight carry a left drift into a right one', () => {
  const rows = play(18, [...ENTRY, [3, 'WA'], [1, 'D'], [0.3, 'WD_'], [2.7, 'WD']]);
  const after = between(rows, 9.5, 10.6);
  assert.ok(after.every((r) => r.angle < -20), `drifting right: ${Math.max(...after.map((r) => r.angle)).toFixed(0)}°`);
});

test('time on W is the angle: held, the drift is let out to ~50°; short lifts hold it nearer 35°', () => {
  const average = (rows) => rows.reduce((sum, r) => sum + r.angle, 0) / rows.length;
  const held = average(between(play(18, [...ENTRY, [1, 'WA'], [4, 'W']]), 5.55, 8.55));
  const lifts = [];
  for (let i = 0; i < 4; i++) lifts.push([0.7, 'W'], [0.3, '']);
  const pulsed = average(between(play(18, [...ENTRY, [1, 'WA'], ...lifts]), 5.55, 8.55));
  assert.ok(held > 45 && held < 55, `W held: ${held.toFixed(0)}°`);
  assert.ok(pulsed > 22 && pulsed < held - 8, `lifting 0.3 s in each second: ${pulsed.toFixed(0)}°`);

  // and a held W reads as gas: the traction control no longer pins a held W at 30% for the whole slide
  const rows = play(15, [[6, 'WA']]);
  const slide = rows.filter((r) => r.t > 1.5 && Math.abs(r.angle) > 10);
  const meanThrottle = slide.reduce((sum, r) => sum + r.throttle, 0) / slide.length;
  // (0.38 when the traction control aimed W+A at a preset 30° and never gave less than 0.3)
  assert.ok(meanThrottle > 0.45, `mean throttle in the slide ${meanThrottle.toFixed(2)}`);
  assert.ok(slide.at(-1).speed > 12, `the drift keeps its speed (${slide.at(-1).speed.toFixed(1)} m/s), not a spiral down to a crawl`);
});

test('with the key held into a big angle the wheels walk out to counter-lock instead of snapping there', () => {
  // the review's probes: a power-over from 34 mph and a handbrake entry at 56 mph, the key held into the turn
  for (const [speed, script] of [[15, [[6, 'WA']]], [25, [[0.3, 'WA_'], [5, 'WA']]]]) {
    const rows = play(speed, script);
    assert.ok(Math.max(...rows.map((r) => r.angle)) > 50, 'a big angle');
    assert.ok(wheelSwing(rows) < 30, `${speed} m/s: at most ${wheelSwing(rows).toFixed(0)}° of wheel in a quarter second`);
    assert.ok(Math.max(...rows.map((r) => r.angle)) < 65, `${speed} m/s: and no spin`);
  }
});

test('a power-over steps the tail out from 70 to 90 mph, either way', () => {
  for (const mph of [72, 80, 89]) {
    for (const [into, side] of [['A', 1], ['D', -1]]) {
      const rows = play(mph * 0.44704, [[6, `W${into}`]]);
      const sideways = rows.filter((r) => side * r.angle > 20).length * FRAME;
      assert.ok(sideways > 3, `${mph} mph, W${into}: past 20° for ${sideways.toFixed(1)} s`);
      assert.ok(Math.max(...rows.map((r) => side * r.angle)) < 65, `${mph} mph, W${into}: no spin`);
    }
  }
});

test('committing to a power-over takes a drifter\'s downshift that the plain kickdown would not', () => {
  // 63 mph in 4th: 3rd would turn 5,300 rpm, past the full-throttle kickdown's 5,000
  const cruising = () => ({ position: { x: 0, z: 0 }, heading: 0, speed: 28, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0, drift: {}, gear: 4 });
  const straight = play(28, [[1, 'W']], cruising());
  assert.equal(straight.at(-1).gear, 4, 'straight on the gas it holds 4th');
  const committed = play(28, [[1, 'WA']], cruising());
  assert.equal(Math.min(...committed.map((r) => r.gear)), 3, 'gas and lock held: down to 3rd');
});

test('the opposite key held on the gas swings a drift through straight into one the other way (a manji)', () => {
  // from a power-over at 34 mph and from the 90 mph entry
  for (const [speed, entry] of [[15, [[3, 'WA']]], [18, [...ENTRY, [2, 'WA']]]]) {
    const start = entry.reduce((sum, [seconds]) => sum + seconds, 0);
    const rows = play(speed, [...entry, [4, 'WD']]);
    const span = rows.filter((r) => r.t >= start);
    const across = span.find((r) => r.angle < -20);
    assert.ok(across && across.t - start < 2.2, `${speed} m/s: drifting right ${across ? (across.t - start).toFixed(2) : '-'} s after D`);
    assert.ok(Math.min(...span.map((r) => r.angle)) > -70, `${speed} m/s: into a drift, not a spin`);
    const held = span.filter((r) => r.t > across.t && r.t < across.t + 1.5);
    assert.ok(held.every((r) => r.angle < -20), `${speed} m/s: and held: ${Math.max(...held.map((r) => r.angle)).toFixed(0)}°`);
  }
});
