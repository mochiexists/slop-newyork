import assert from 'node:assert/strict';
import test from 'node:test';
import { Recovery, boxesOverlap, chooseReverse, reverseClear } from '../js/swim-recovery.js';

// The show's AI getting going again (swim-recovery.js): a way back checked clear before it backs out, and a reroute
// once backing out gets it nowhere

// An open road 20 m wide down x = 0 (south is +z), and the car on it facing south
const road = {
  footprintOff(x, z, heading, margin = 0) {
    let off = 0;
    for (const [a, b] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const px = x + Math.cos(heading) * a * (0.97 + margin) + Math.sin(heading) * b * (2.52 + margin);
      if (Math.abs(px) > 10) off++;
    }
    return off;
  }
};
const car = () => ({ position: { x: 0, z: 0 }, heading: 0, speed: 0 });
const parked = (x, z, yaw = 0) => ({ x, z, yaw, speed: 0, half: 2.3, halfWidth: 0.95 });

test('two boxes overlap when they touch, turned or not, and not when a gap parts them', () => {
  assert.equal(boxesOverlap(0, 0, 0, 1, 2.5, 0, 4.5, 0, 1, 2.3), true);
  assert.equal(boxesOverlap(0, 0, 0, 1, 2.5, 0, 5, 0, 1, 2.3), false);
  assert.equal(boxesOverlap(0, 0, 0, 1, 2.5, 2.2, 0, Math.PI / 4, 1, 2.3), true, 'a corner of a turned box poking in');
  assert.equal(boxesOverlap(0, 0, 0, 1, 2.5, 4, 0, Math.PI / 4, 1, 2.3), false);
});

test('the way back is as far as it is clear: a car parked behind, or the curb', () => {
  assert.equal(reverseClear(car(), 0, 4.5, [], road), 4.5, 'open road behind');
  const behind = reverseClear(car(), 0, 4.5, [parked(0, -8)], road);
  assert.ok(behind > 2.4 && behind <= 2.9, `a car 8 m behind (bumpers 3.2 m apart) leaves ${behind.toFixed(1)} m with the reserve`);
  // (backing with the wheel hard over swings the tail toward the curb 1.5 m off its side)
  const atCurb = { position: { x: 8.2, z: 0 }, heading: 0, speed: 0 };
  assert.ok(reverseClear(atCurb, 1, 4.5, [], road) < reverseClear(atCurb, -1, 4.5, [], road), 'the tail swung at the curb gets less');
});

test('it backs out the way it wants if that is clear, another way if not, and not at all when boxed in', () => {
  const free = chooseReverse(car(), 1, [], road);
  assert.deepEqual([free.steer, free.distance], [1, 4.5]);
  // (a car behind its tail on the +x side: swinging the tail that way, A held backing up, is blocked)
  const sideBehind = chooseReverse(car(), 1, [parked(2.6, -5.5, 0.3)], road);
  assert.ok(sideBehind && sideBehind.steer !== 1 && sideBehind.distance >= 1.2, `another way back (${sideBehind?.steer})`);
  assert.equal(chooseReverse(car(), 0, [parked(0, -6), parked(-2.4, -5.5), parked(2.4, -5.5)], road), null, 'boxed in');
});

test('stopped closer than its clearance to a car beside it, it still backs out straight, just never closer', () => {
  // (fresh-s4-30 on 9f70d21: stopped 0.15 m beside a car, every way back read as blocked and it stood 88 s)
  const beside = parked(0.97 + 0.95 + 0.15, 0);
  assert.equal(reverseClear(car(), 0, 4.5, [beside], road), 4.5, 'straight back keeps its 0.15 m');
  const way = chooseReverse(car(), 0, [beside], road);
  assert.deepEqual([way.steer, way.distance], [0, 4.5]);
  // (A held backing swings the tail toward it: that gets closer, so it stays refused)
  assert.ok(reverseClear(car(), -1, 4.5, [beside], road) < 1, 'swinging the tail into it is refused');
  // (a car behind, clear by more than the clearance, still gets all of it)
  assert.ok(reverseClear(car(), 0, 4.5, [beside, parked(0, -7.5)], road) < 2.5, 'the car behind still counts in full');
});

test('backing out that gets it nowhere: a reroute after two tries or 4 s stopped, never while it waits at a light', () => {
  const recovery = new Recovery();
  assert.equal(recovery.progress(0, 0.1, false), false);
  for (let t = 0; t < 3.9; t += 0.1) assert.equal(recovery.progress(0.5, 0.1, false), false);
  let reroute = false;
  for (let t = 0; t < 0.3; t += 0.1) reroute ||= recovery.progress(0.5, 0.1, false);
  assert.ok(reroute, '4 s stopped without getting anywhere');
  recovery.rerouted(0);
  for (let t = 0; t < 30; t += 0.1) assert.equal(recovery.progress(0, 0.1, true), false, 'a red light\'s queue is waited out');
  recovery.attempts = 2;
  assert.equal(recovery.progress(0.5, 0.1, false), true, 'two tries');
  assert.equal(recovery.progress(5, 0.1, false), false, 'getting somewhere starts the count over');
  assert.equal(recovery.attempts, 0);
});
