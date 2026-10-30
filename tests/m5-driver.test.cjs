const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const { GLASS_SEE_THROUGH, BIRD_TIME, driverView, birdStep, birdLift } = loadModule(read('js/m5-driver.js'), {
  globals: { Math }
});

test('the driver sits in the swimming car from every camera, the head only from outside', () => {
  const chase = driverView({ swimming: true, inside: false, modelCabin: false });
  assert.equal(chase.body, true);
  assert.equal(chase.head, true);
  // the procedural cabin shows through see-through glass, the display is not redrawn for it
  assert.equal(chase.cabin, true);
  assert.equal(chase.glassOpacity, GLASS_SEE_THROUGH);
  assert.ok(GLASS_SEE_THROUGH > 0 && GLASS_SEE_THROUGH < 1);
  assert.equal(chase.display, false);

  const seat = driverView({ swimming: true, inside: true, modelCabin: false });
  assert.equal(seat.body, true, 'hands, forearms and legs from the seat');
  assert.equal(seat.head, false, 'no head in the seat camera');
  assert.equal(seat.cabin, true);
  assert.equal(seat.display, true);
});

test('the full build keeps its own cabin and glass, the driver still sits in it', () => {
  for (const inside of [false, true]) {
    const view = driverView({ swimming: true, inside, modelCabin: true });
    assert.equal(view.body, true);
    assert.equal(view.head, !inside);
    assert.equal(view.cabin, false);
    assert.equal(view.glassOpacity, 1);
    assert.equal(view.display, false);
  }
});

test('out of the swim mode the car is empty and its glass painted again', () => {
  for (const modelCabin of [false, true]) {
    const view = driverView({ swimming: false, inside: false, modelCabin });
    assert.deepEqual(
      { body: view.body, head: view.head, cabin: view.cabin, glassOpacity: view.glassOpacity, display: view.display },
      { body: false, head: false, cabin: false, glassOpacity: 1, display: false }
    );
  }
});

test('the bird: the left hand is out of the window in BIRD_TIME and back on the wheel as fast', () => {
  const dt = 1 / 60;
  let amount = 0;
  let frames = 0;
  while (amount < 1) {
    amount = birdStep(amount, true, dt);
    frames++;
  }
  assert.ok(Math.abs(frames * dt - BIRD_TIME) <= dt, `${frames} frames`);
  assert.equal(birdStep(amount, true, dt), 1, 'held out while raised');
  amount = birdStep(amount, false, BIRD_TIME / 2);
  assert.ok(Math.abs(amount - 0.5) < 1e-9);
  assert.equal(birdStep(amount, false, BIRD_TIME), 0);
  assert.equal(birdStep(1, true, dt, false), 0, 'leaving the swim mode drops it at once');
});

test('the arm eases off the wheel and into the window', () => {
  assert.equal(birdLift(0), 0);
  assert.equal(birdLift(1), 1);
  assert.equal(birdLift(0.5), 0.5);
  assert.ok(birdLift(0.1) < 0.1 && birdLift(0.9) > 0.9, 'slow at both ends');
});
