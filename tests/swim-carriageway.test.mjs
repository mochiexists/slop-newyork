import assert from 'node:assert/strict';
import test from 'node:test';
import { avenueX, streetZ } from '../js/city-config.js';
import { footprintOff, onCarriageway } from '../js/swim-carriageway.js';

// The road as the show's AI plans its stunts on it (swim-carriageway.js), on points the eval harness's map
// (tools/swim-eval/lib/map.mjs) classifies the same way

const SEVENTH = avenueX('7');

test('7th Ave\'s lanes and the 42nd St crossing are carriageway; its pavement and Times Square\'s plaza are not', () => {
  assert.ok(onCarriageway(SEVENTH - 4.6, streetZ(42) - 22), 'the westmost southbound lane north of 42nd St');
  assert.ok(onCarriageway(SEVENTH, streetZ(42)), 'the middle of the crossing');
  assert.ok(onCarriageway(SEVENTH - 9, streetZ(42) + 1), 'west of the avenue, in 42nd St');
  assert.ok(!onCarriageway(SEVENTH - 11, streetZ(42) - 22), 'the west pavement north of 42nd St');
  assert.ok(!onCarriageway(SEVENTH + 10, streetZ(42) - 22), 'the east pavement');
  // (the old show spot, on the bowtie between 45th and 46th: road to blockAt, plaza to the game)
  assert.ok(!onCarriageway(SEVENTH - 13, streetZ(45) - 22), 'Times Square\'s plaza');
});

test('the car\'s whole body: in its lane it is on the road, nosed over the curb it is not', () => {
  assert.equal(footprintOff(SEVENTH - 4.6, streetZ(42) - 22, 0), 0, 'straight down the lane');
  assert.ok(footprintOff(SEVENTH - 8.5, streetZ(42) - 22, 0) > 0, 'half a car over the west curb');
  assert.ok(footprintOff(SEVENTH - 4.6, streetZ(42) - 22, -Math.PI / 2, 4) > 0, 'grown 4 m all round, across the avenue');
});

test('a curb corner poking into the car\'s side between two corners is seen (Codex 2026-11-03)', () => {
  // (the north-west curb corner of 7th Ave / 42nd St lies inside this pose's box, 1.3 m from its nearest corner)
  assert.ok(!onCarriageway(-594.204787, -8.036912), 'the curb island');
  assert.ok(footprintOff(-592.713824, -5.951647, 25 * Math.PI / 180, 0.25) > 0, 'the pose over it');
});

test('a donut of 9 m round the show\'s cop at 7th Ave / 42nd St keeps the body on the road, sideways all the way round', () => {
  const cop = { x: SEVENTH - 0.7, z: streetZ(42) + 0.7 };
  let off = 0;
  for (let i = 0; i < 72; i++) {
    const bearing = (i / 72) * Math.PI * 2;
    // (a left donut: the bearing from the cop grows, the nose turned in 35°)
    const heading = bearing + Math.PI / 2 - 35 * Math.PI / 180;
    off += footprintOff(cop.x + Math.sin(bearing) * 9, cop.z + Math.cos(bearing) * 9, heading);
  }
  assert.equal(off, 0);
  // ...and 45th St's crossing, where the show used to drift, can't take it
  const old = { x: SEVENTH - 2, z: streetZ(45) };
  let oldOff = 0;
  for (let i = 0; i < 72; i++) {
    const bearing = (i / 72) * Math.PI * 2;
    oldOff += footprintOff(old.x + Math.sin(bearing) * 9, old.z + Math.cos(bearing) * 9, bearing + Math.PI / 2 - 35 * Math.PI / 180);
  }
  assert.ok(oldOff > 0, `45th St: ${oldOff} points off`);
});
