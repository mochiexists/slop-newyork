const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// The exhaust's pops, crackles and flames: when they fire, from the car's own physics and gearbox
const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const physics = loadModule(read('js/drift-physics.js'));
const engine = loadModule(read('js/swim-engine.js'));
const exhaust = loadModule(read('js/swim-exhaust.js'), {
  imports: { 'three/webgpu': {}, 'three/tsl': {}, './cars.js': {}, './swim-engine.js': engine }
});
const { ExhaustTrigger, ExhaustPops, OVERRUN_TIME, LIMITER_POP_CHANCE } = exhaust;

const FRAME = 1 / 60;
const SUBSTEPS = 4;
const pedals = { throttle: 0, brake: 0, reverse: 0, steer: 0, handbrake: 0, burnout: 0 };

function car(speed = 0) {
  return { position: { x: 0, z: 0 }, heading: 0, speed, vx: 0, vz: 0, angularVel: 0, steerAngle: 0 };
}

// A repeatable random sequence
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Frames as the game runs them: the physics steps, then the exhaust reads the car. Returns every event with its time.
function play(c, trigger, seconds, input, events = [], clock = { t: 0 }) {
  for (let t = 0; t < seconds - 1e-9; t += FRAME) {
    for (let i = 0; i < SUBSTEPS; i++) c.drift = physics.stepDriftCar(c, input, FRAME / SUBSTEPS);
    for (const event of trigger.step(FRAME, c, input.throttle)) events.push({ ...event, t: clock.t, rpm: c.rpm, gear: c.gear });
    clock.t += FRAME;
  }
  return events;
}

test('lifting off at high revs bangs once, then crackles for a while and dies away', () => {
  const c = car();
  const trigger = new ExhaustTrigger(seeded());
  const clock = { t: 0 };
  play(c, trigger, 5, { ...pedals, throttle: 1 }, [], clock);
  assert.ok(c.rpm > 4500, `revving at ${Math.round(c.rpm)}`);
  const liftAt = clock.t;
  const events = play(c, trigger, 3, { ...pedals }, [], clock);
  const bangs = events.filter((e) => e.kind === 'bang');
  const crackles = events.filter((e) => e.kind === 'crackle');
  assert.equal(bangs.length, 1);
  assert.ok(bangs[0].t - liftAt < 0.1, 'the bang comes with the lift');
  assert.ok(bangs[0].strength > 0.4);
  assert.ok(crackles.length >= 5, `${crackles.length} crackles`);
  assert.ok(crackles.every((e) => e.t - liftAt <= OVERRUN_TIME + 0.05), 'the crackle stops within the overrun');
  // Dense first, sparse last; weaker as it dies
  const gaps = crackles.slice(1).map((e, i) => e.t - crackles[i].t);
  assert.ok(gaps.at(-1) > gaps[0], `gaps ${gaps.map((g) => g.toFixed(2)).join(' ')}`);
  assert.ok(crackles.at(-1).strength < bangs[0].strength);
  assert.ok(crackles.every((e) => e.tips === 'left' || e.tips === 'right'));
});

test('back on the gas, the crackle stops at once', () => {
  const c = car();
  const trigger = new ExhaustTrigger(seeded(3));
  const clock = { t: 0 };
  play(c, trigger, 5, { ...pedals, throttle: 1 }, [], clock);
  play(c, trigger, 0.1, { ...pedals }, [], clock);
  const events = play(c, trigger, 1.5, { ...pedals, throttle: 1 }, [], clock);
  assert.equal(events.filter((e) => e.kind === 'crackle' || e.kind === 'bang').length, 0);
});

test('cruising and gentle driving stay quiet', () => {
  const c = car();
  const trigger = new ExhaustTrigger(seeded(5));
  // a gentle pull away, a steady cruise and a slow roll off the gas
  const events = [
    ...play(c, trigger, 6, { ...pedals, throttle: 0.3 }),
    ...play(c, trigger, 4, { ...pedals, throttle: 0.12 }),
    ...play(c, trigger, 3, { ...pedals })
  ];
  assert.deepEqual(events.map((e) => e.kind), []);
});

test('flat-out upshifts bark; a lazy one does not', () => {
  const hard = play(car(), new ExhaustTrigger(seeded(11)), 12, { ...pedals, throttle: 1 });
  const braps = hard.filter((e) => e.kind === 'brap');
  assert.ok(braps.length >= 3, `${braps.length} braps`);
  assert.ok(braps.every((e) => e.tips === 'all' && e.strength > 0.3));
  const lazy = play(car(), new ExhaustTrigger(seeded(11)), 12, { ...pedals, throttle: 0.5 });
  assert.equal(lazy.filter((e) => e.kind === 'brap').length, 0);
});

test('bouncing off the limiter pops some of the cuts, never two too close', () => {
  const c = car();
  physics.toggleManual(c);
  const trigger = new ExhaustTrigger(seeded(13));
  // Held in first on the gas: the revs bounce off the limiter
  const events = play(c, trigger, 4, { ...pedals, throttle: 1 });
  const pops = events.filter((e) => e.kind === 'limiter');
  assert.ok(pops.length >= 4, `${pops.length} limiter pops`);
  for (let i = 1; i < pops.length; i++) assert.ok(pops[i].t - pops[i - 1].t >= 0.13);
  assert.ok(LIMITER_POP_CHANCE < 1);
});

test('the pops stay silent with the sound off and play into the mix with it on', () => {
  const started = [];
  const node = () => ({
    connect(next) { return next || this; }, disconnect() {}, start: (...args) => started.push(args), stop() {},
    gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} },
    frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, Q: { value: 0 }
  });
  const context = {
    state: 'running', currentTime: 1, sampleRate: 8000,
    createBuffer: (channels, length) => ({ getChannelData: () => new Float32Array(length) }),
    createBufferSource: node, createBiquadFilter: node, createGain: node, createOscillator: node
  };
  const audio = { context, mix: node(), enabled: false };
  const pops = new ExhaustPops(audio, seeded(2));
  pops.play({ kind: 'bang', strength: 1, tips: 'all' });
  assert.equal(started.length, 0);
  audio.enabled = true;
  pops.play({ kind: 'bang', strength: 1, tips: 'all' });
  assert.equal(started.length, 2, 'a crack and a thump');
  pops.play({ kind: 'crackle', strength: 0.5, tips: 'left' });
  assert.ok(started.length >= 4, 'a crackle is a few cracks');
});
