const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
let config, swim;
test.before(async () => {
  config = await import('../js/city-config.js');
  swim = loadModule(read('js/swim-mode.js'), {
    imports: { 'three/webgpu': {}, 'three/tsl': {}, './city-config.js': config, './cars.js': { BODY_SPECS: {} } }
  });
});

function onRoadway(point) {
  return config.nearestRoads(point.x, point.z, 20).some(({ road, dist }) => dist < road.w / 2);
}

test('every swim start button has a clip start on a Manhattan roadway', () => {
  const buttons = [...read('index.html').matchAll(/data-swim-start="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(Object.keys(swim.SWIM_STARTS).sort(), buttons.sort());
  for (const [name, point] of Object.entries(swim.SWIM_STARTS)) {
    assert.ok(Number.isFinite(point.heading), `${name} has a heading`);
    assert.equal(config.blockAt(point.x, point.z), null, `${name} starts outside building blocks`);
    const shore = config.getIslandBoundsAtZ(point.z);
    assert.ok(point.x > shore.westX + 8 && point.x < shore.eastX - 8, `${name} stays on the island`);
    assert.ok(onRoadway(point), `${name} starts within a street's width`);
  }
});

test('the Squeeze Benz route starts in Times Square and runs along streets', () => {
  const route = swim.SQUEEZE_ROUTE;
  assert.ok(route.length >= 3);
  assert.match(config.getLocationLabel(route[0].x, route[0].z), /7th Ave/);
  for (const point of route) assert.ok(onRoadway(point), `${point.x}, ${point.z} is on a street`);
  // Grid driving: every leg runs along an avenue or a street, never diagonally through blocks
  for (let i = 1; i < route.length; i++) {
    const dx = Math.abs(route[i].x - route[i - 1].x), dz = Math.abs(route[i].z - route[i - 1].z);
    assert.ok(Math.min(dx, dz) < 15, `leg ${i} follows the grid`);
  }
});

test('the soundtrack is streamed by YouTube id, not stored in the repository', () => {
  assert.ok(swim.CARELESS_WHISPER.videoIds.length >= 2, 'a fallback upload when the official one will not embed');
  for (const id of swim.CARELESS_WHISPER.videoIds) assert.match(id, /^[\w-]{11}$/);
  assert.ok(Number.isFinite(swim.CARELESS_WHISPER.start));
});
