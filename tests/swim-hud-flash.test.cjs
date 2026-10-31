const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const { FLASH_HOLD, HudFlash } = loadModule(read('js/swim-hud-flash.js'));

// A stand-in for the flash element that logs every class switch and bump
function fakeElement() {
  const log = [];
  const classes = new Set();
  return {
    log,
    classes,
    dataset: {},
    textContent: '',
    classList: {
      add: (name) => { log.push(`+${name}`); classes.add(name); },
      remove: (name) => { log.push(`-${name}`); classes.delete(name); }
    },
    animate: () => log.push('bump')
  };
}

test('a flash switches on once, holds, then switches off', () => {
  const el = fakeElement();
  const flash = new HudFlash(el);
  flash.show('+120 SWIM', 'banked');
  assert.equal(el.textContent, '+120 SWIM');
  assert.equal(el.dataset.kind, 'banked');
  assert.ok(el.classes.has('is-on'));
  for (let t = 0; t < FLASH_HOLD - 0.05; t += 1 / 60) flash.update(1 / 60);
  assert.ok(el.classes.has('is-on'), 'still up just before the hold ends');
  for (let i = 0; i < 10; i++) flash.update(1 / 60);
  assert.ok(!el.classes.has('is-on'), 'faded out after the hold');
  assert.deepEqual(el.log, ['+is-on', '-is-on']);
});

test('flashes a frame apart never switch the element off and on: the text swaps in place with a bump', () => {
  const el = fakeElement();
  const flash = new HudFlash(el);
  // A close call, then the split it completes 0.14 s later, then a run of close calls every few frames
  flash.show('CLOSE CALL ×5 +2,537', 'banked');
  for (let i = 0; i < 8; i++) flash.update(1 / 60);
  flash.show('SPLIT ×5 +6,091', 'banked');
  for (let frame = 0; frame < 120; frame++) {
    flash.update(1 / 60);
    if (frame % 5 === 0) flash.show(`CLOSE CALL +${frame}`, 'banked');
  }
  assert.equal(el.log.filter((entry) => entry === '+is-on').length, 1);
  assert.equal(el.log.filter((entry) => entry === '-is-on').length, 0);
  assert.ok(el.log.includes('bump'));
});

test('the same flash every frame neither restarts nor bumps', () => {
  const el = fakeElement();
  const flash = new HudFlash(el);
  for (let frame = 0; frame < 90; frame++) {
    flash.show('NYPD IN PURSUIT', 'lost');
    flash.update(1 / 60);
  }
  assert.deepEqual(el.log, ['+is-on']);
});

test('a flash during the fade-out switches back on (the CSS transition turns round from where it is)', () => {
  const el = fakeElement();
  const flash = new HudFlash(el);
  flash.show('WIPEOUT', 'lost');
  flash.update(FLASH_HOLD + 0.01);
  flash.show('GO · YOUR CAR', 'banked');
  assert.deepEqual(el.log, ['+is-on', '-is-on', '+is-on']);
  assert.equal(el.dataset.kind, 'banked');
});

test('no element, no errors', () => {
  const flash = new HudFlash(null);
  flash.show('x');
  flash.update(1);
  assert.equal(flash.visible, false);
});
