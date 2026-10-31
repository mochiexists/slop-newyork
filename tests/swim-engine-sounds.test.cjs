const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/swim-engine-sounds.js'), 'utf8');
const engine = loadModule(readFileSync(join(__dirname, '../js/swim-engine.js'), 'utf8'));
const audio = loadModule(readFileSync(join(__dirname, '../js/swim-engine-audio.js'), 'utf8'), {
  imports: { './audio-synthesis.js': { setControlRate() {} }, './swim-engine.js': engine }
});

function load(engineAudio = {}) {
  const voices = [];
  const stub = { ...audio, createSwimEngineVoice: (...args) => voices.push(args) && { tick() {} }, ...engineAudio };
  const { SwimEngineSounds, swimThrottle } = loadModule(source, { imports: { './swim-engine-audio.js': stub } });
  return { SwimEngineSounds, swimThrottle, voices };
}

test('the engine load is the driver\'s pedal once the car has been driven, the W key before', () => {
  const { swimThrottle } = load();
  const controllers = { keys: { forward: true } };
  assert.equal(swimThrottle(controllers), 1, 'no driver yet: the key');
  controllers.swimDriver = { input: { throttle: 0.4, reverse: 0 } };
  assert.equal(swimThrottle(controllers), 0.4);
  controllers.swimDriver.input = { throttle: 0, reverse: 0.7 };
  assert.equal(swimThrottle(controllers), 0.7, 'reversing is on the gas too');
  controllers.swimDriver.input = { throttle: 1.5, reverse: 0 };
  assert.equal(swimThrottle(controllers), 1, 'kept to 0-1');
  controllers.swimDriver.input = { throttle: NaN, reverse: 0 };
  assert.equal(swimThrottle(controllers), 0, 'and finite');
});

test('only the swimming car gets the recorded engine voice; the toggle skips an engine known to be missing', () => {
  const { SwimEngineSounds, voices } = load();
  const audioSystem = { context: {}, resources: {} };
  const sounds = new SwimEngineSounds(audioSystem, { keys: {} });
  assert.equal(sounds.voiceFor({ kind: 'sedan', id: 1 }, false, {}), null);
  assert.equal(sounds.voiceFor({ kind: 'swim', id: 2 }, true, {}), null, 'a siren is a siren');
  assert.ok(sounds.voiceFor({ kind: 'swim', id: 3 }, false, {}));
  assert.equal(voices.length, 1);
  assert.equal(voices[0][3].entity, 3);

  let changes = 0;
  sounds.onChange = () => changes++;
  assert.equal(sounds.engine, 'm3');
  sounds.banks = { m5mod: null };
  sounds.toggle();
  assert.equal(sounds.engine, 'm3', 'the mod engine is missing');
  sounds.banks = {};
  sounds.toggle();
  assert.equal(sounds.engine, 'm5mod');
  assert.equal(changes, 1);
});
