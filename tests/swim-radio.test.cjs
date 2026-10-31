const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// The soundtrack's fades against a YouTube player whose state changes arrive late, as they do (postMessage round trips)
const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const fade = loadModule(read('js/swim-music-fade.js'));
let SwimRadio;
test.before(() => {
  ({ SwimRadio } = loadModule(read('js/swim-mode.js'), {
    imports: { 'three/webgpu': {}, 'three/tsl': {}, './city-config.js': { avenueX: () => 0, streetZ: () => 0 }, './cars.js': {}, './swim-show.js': {},
      './swim-hud-flash.js': { HudFlash: class {} }, './swim-music-fade.js': fade, './swim-exhaust.js': {} },
    globals: { navigator: {}, setTimeout: () => 0, clearTimeout() {} }
  }));
}, { timeout: 5000 });

// A player that logs commands and only reports a state when the test delivers it
function fakePlayer() {
  return {
    log: [], volume: 100,
    setVolume(v) { this.volume = v; },
    playVideo() { this.log.push('play'); },
    pauseVideo() { this.log.push('pause'); },
    cueVideoById(o) { this.log.push(`cue ${o.startSeconds}`); },
    loadVideoById(o) { this.log.push(`load ${o.startSeconds}`); },
    seekTo() {}, mute() {}, unMute() {}
  };
}

function readyRadio() {
  const radio = new SwimRadio(null);
  radio.player = fakePlayer();
  radio.ready = true;
  return radio;
}

const run = (radio, seconds) => { for (let t = 0; t < seconds; t += 1 / 60) radio.update(1 / 60); };

test('the song fades in once it is really playing', () => {
  const radio = readyRadio();
  radio.play();
  assert.equal(radio.player.volume, 0);
  run(radio, 1);
  assert.equal(radio.player.volume, 0, 'no fade while it buffers');
  radio.onState(1);
  run(radio, fade.FADE_IN_TIME + 0.1);
  assert.equal(radio.player.volume, 100);
});

test('play() after the pause was sent but before YouTube says paused starts it again', () => {
  const radio = readyRadio();
  radio.play();
  radio.onState(1);
  run(radio, 4);
  radio.pause();
  run(radio, fade.FADE_OUT_TIME + 0.1);
  assert.deepEqual(radio.player.log, ['play', 'pause']);
  radio.play(); // G again, before state 2 arrives
  radio.onState(2); // the late acknowledgement of the pause
  assert.equal(radio.player.log.at(-1), 'play', 'a new play command went out');
  radio.onState(1);
  run(radio, fade.FADE_IN_TIME + 0.1);
  assert.equal(radio.player.volume, 100);
});

test("the show's cue fades the drive's song out, cues the chorus, and the drift's play() starts it even before the cue is acknowledged", () => {
  const radio = readyRadio();
  radio.play();
  radio.onState(1);
  run(radio, 4);
  radio.cue();
  assert.ok(!radio.player.log.some((entry) => entry.startsWith('cue')), 'not cut dead: it fades first');
  run(radio, fade.FADE_OUT_TIME + 0.1);
  assert.equal(radio.player.log.at(-1), 'cue 159.25');
  radio.play(); // the donuts, before state 5 arrives
  assert.equal(radio.player.log.at(-1), 'play');
  radio.onState(1);
  run(radio, fade.FADE_IN_TIME + 0.1);
  assert.equal(radio.player.volume, 100);
});

test('the drift starting during the cue fade goes straight to the chorus', () => {
  const radio = readyRadio();
  radio.play();
  radio.onState(1);
  run(radio, 4);
  radio.cue();
  run(radio, 0.3);
  radio.play();
  assert.equal(radio.player.log.at(-1), 'load 159.25');
});

test('play during a fade-out turns it round without a new start', () => {
  const radio = readyRadio();
  radio.play();
  radio.onState(1);
  run(radio, 4);
  radio.pause();
  run(radio, 0.3);
  const volume = radio.player.volume;
  radio.play();
  run(radio, 0.2);
  assert.ok(radio.player.volume >= volume);
  assert.deepEqual(radio.player.log, ['play']);
});
