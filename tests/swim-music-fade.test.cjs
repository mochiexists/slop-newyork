const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const { FADE_IN_TIME, FADE_OUT_TIME, FADE_FLOOR_DB, MUSIC_DUCK, MusicFader, MusicDuck, duckGain } =
  loadModule(read('js/swim-music-fade.js'));

const DT = 1 / 60;

// Runs the fader for `seconds`, returning the player volume every frame
function run(fader, seconds) {
  const volumes = [];
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    fader.update(DT);
    volumes.push(fader.volume);
  }
  return volumes;
}

test('the song fades in from silence over FADE_IN_TIME, never jumping, as an even swell in decibels', () => {
  const fader = new MusicFader();
  assert.equal(fader.volume, 0);
  fader.fadeIn();
  const volumes = run(fader, FADE_IN_TIME + 0.2);
  assert.equal(volumes.at(-1), 100);
  // Monotonic, and no step bigger than a couple of volume points a frame
  for (let i = 1; i < volumes.length; i++) {
    assert.ok(volumes[i] >= volumes[i - 1]);
    assert.ok(volumes[i] - volumes[i - 1] <= 3, `step ${volumes[i - 1]} -> ${volumes[i]}`);
  }
  // Halfway through it is at half the floor in dB (about 13 of 100), not at 50: the loud part comes last
  const half = volumes[Math.round(FADE_IN_TIME / 2 / DT) - 1];
  assert.ok(Math.abs(half - 100 * 10 ** (FADE_FLOOR_DB / 2 / 20)) <= 1.5, `halfway volume ${half}`);
  // Full volume is reached only at the end of the fade
  const full = volumes.indexOf(100) * DT;
  assert.ok(full > FADE_IN_TIME - 0.1 && full < FADE_IN_TIME + 0.05, `full at ${full.toFixed(2)} s`);
});

test('a fade-out reaches silence in FADE_OUT_TIME and then calls back once', () => {
  const fader = new MusicFader();
  fader.fadeIn();
  run(fader, FADE_IN_TIME + 0.1);
  let calls = 0;
  fader.fadeOut(() => calls++);
  const volumes = run(fader, FADE_OUT_TIME - 0.05);
  assert.ok(volumes.at(-1) > 0, 'still audible just before the end');
  assert.equal(calls, 0);
  run(fader, 0.2);
  assert.equal(fader.volume, 0);
  assert.equal(calls, 1);
  run(fader, 1);
  assert.equal(calls, 1);
});

test('a fade-out of a silent song calls back at once', () => {
  const fader = new MusicFader();
  let calls = 0;
  fader.fadeOut(() => calls++);
  assert.equal(calls, 1);
});

test('playing during a fade-out turns the fade round from where it is, and cancels the pause', () => {
  const fader = new MusicFader();
  fader.fadeIn();
  run(fader, FADE_IN_TIME + 0.1);
  let paused = false;
  fader.fadeOut(() => { paused = true; });
  const down = run(fader, FADE_OUT_TIME / 3);
  fader.fadeIn();
  const up = run(fader, 0.1);
  assert.ok(Math.abs(up[0] - down.at(-1)) <= 3, `${down.at(-1)} -> ${up[0]}`);
  assert.ok(up.at(-1) >= up[0]);
  run(fader, FADE_IN_TIME);
  assert.equal(paused, false);
  assert.equal(fader.volume, 100);
});

test('silence() resets for a new start', () => {
  const fader = new MusicFader();
  fader.fadeIn();
  run(fader, 1);
  fader.silence();
  assert.equal(fader.volume, 0);
  run(fader, 1);
  assert.equal(fader.volume, 0, 'stays silent until faded in');
});

test('the city mix dips by MUSIC_DUCK under the full song and is left alone without it', () => {
  assert.equal(duckGain(0), 1);
  assert.ok(Math.abs(duckGain(1) - (1 - MUSIC_DUCK)) < 1e-12);
  const scheduled = [];
  const audio = {
    context: { currentTime: 5, state: 'running' },
    mix: { gain: { setTargetAtTime: (value, at, tau) => scheduled.push([value, at, tau]) } }
  };
  const duck = new MusicDuck();
  duck.update(audio, 0);
  assert.equal(scheduled.length, 0, 'no song, no change');
  duck.update(audio, 1);
  duck.update(audio, 1);
  assert.equal(scheduled.length, 1, 'rescheduled only when it moves');
  assert.ok(Math.abs(scheduled[0][0] - (1 - MUSIC_DUCK)) < 1e-12);
  // A rebuilt audio graph (sound switched off and on) is ducked afresh
  const rebuilt = { context: audio.context, mix: { gain: { setTargetAtTime: (value) => scheduled.push([value]) } } };
  duck.update(rebuilt, 1);
  assert.equal(scheduled.length, 2);
  duck.update(null, 1);
});
