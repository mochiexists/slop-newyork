const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const { showTrafficLayout, SHOW_ROWS, seededRandom, trafficMath } = loadModule(
  readFileSync(join(__dirname, '../js/swim-traffic.js'), 'utf8'), { imports: { './swim-car.js': {} } });

test('the AI show lays out its route as rows of two cars side by side, a split apart, down the leg only', () => {
  // A leg 300 m south (+z) down a four-lane avenue in two blocks, its northbound twin, and a two-lane street 50 m off
  const edge = (sx, sz, dx, dz, len, lanes) => ({ sx, sz, dx, dz, rx: -dz, rz: dx, len, lanes });
  const blocks = [edge(7.2, 6, 0, 1, 138, [1.8, 5.4, 9, 12.6]), edge(7.2, 156, 0, 1, 138, [1.8, 5.4, 9, 12.6])];
  const northbound = edge(-7.2, 294, 0, -1, 288, [1.8, 5.4]);
  const offLeg = edge(57.2, 6, 0, 1, 288, [1.8, 5.4]);
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const { placements, stretches } = showTrafficLayout([...blocks, northbound, offLeg], { x: 0, z: 0 }, { x: 0, z: 300 }, {}, random);
  const rows = placements.length / 2;
  assert.ok(rows >= Math.floor(235 / (SHOW_ROWS.spacing * 1.3)), `rows all down the leg (${rows})`);
  // (the module runs in its own realm: Array.from makes the list a plain array of this one)
  assert.deepEqual(Array.from(stretches, (s) => s.edge), blocks, 'it takes over the leg\'s own lanes only');
  let lastZ = -Infinity;
  for (let i = 0; i < placements.length; i += 2) {
    const [left, right] = [placements[i], placements[i + 1]];
    assert.ok(blocks.includes(left.edge) && left.edge === right.edge && left.s === right.s && left.row === right.row);
    assert.equal(right.lane, left.lane + 1, 'neighbouring lanes');
    const x = (p) => p.edge.sx + p.edge.rx * (p.edge.lanes[p.lane] + p.bias);
    assert.ok(Math.abs(Math.abs(x(left) - x(right)) - 5.2) < 1e-9, 'each car at its lane\'s outer edge: 5.2 m apart');
    const z = left.edge.sz + left.s;
    assert.ok(z >= 30 && z <= 300 - 35, `clear of the corners (${z.toFixed(0)} m)`);
    assert.ok(z - lastZ >= 22 * 0.7 - 1e-9, 'rows a few car lengths apart');
    lastZ = z;
  }
});

test('traffic\'s Math is the real one but for a random() a seed makes repeat', () => {
  assert.equal(trafficMath.hypot(3, 4), 5);
  assert.equal(trafficMath.PI, Math.PI);
  assert.equal(trafficMath.random, Object.getPrototypeOf(trafficMath).random, 'unseeded until the show reseeds it');
  const a = seededRandom(1), b = seededRandom(1);
  const first = Array.from({ length: 5 }, () => a());
  assert.deepEqual(Array.from({ length: 5 }, () => b()), first, 'the same seed, the same sequence');
  assert.ok(first.every((r) => r >= 0 && r < 1));
});
