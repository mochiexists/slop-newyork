// Careless Whisper comes in and goes out on a fade instead of a hard cut. The song plays in YouTube's player (no Web
// Audio node to ramp), so the fade steps the player's volume (0-100) on the game's frame clock. The level moves in
// decibels at a steady rate, a straight line from FADE_FLOOR_DB up to full, which the ear hears as an even swell (a
// straight line in volume would leap up in its first few tenths and then crawl); below the floor it is silence. A fade
// turns round from wherever it is, so pausing during a fade-in or playing during a fade-out never jumps.
//
// As the song swells the city's own mix (the engine, tires and streets, all through audioSystem.mix) eases down by
// MUSIC_DUCK, so the music settles in over the car instead of fighting it; it comes back up as the song fades out.

const FADE_IN_TIME = 3.2; // s from silence to full volume (the show starts the song mid-chorus, on the sax)
const FADE_OUT_TIME = 0.9; // s from full volume to silence before a pause
const FADE_FLOOR_DB = -36; // the fade's quiet end; below it the song is silent
const FULL_VOLUME = 100; // the YouTube player's top volume
const MUSIC_DUCK = 0.22; // share the city mix dips by under the song at full volume (about -2.2 dB)
const DUCK_SMOOTHING = 0.12; // s: time constant of the mix gain following the duck
const DUCK_EPSILON = 0.004; // mix gain change worth rescheduling

class MusicFader {
  constructor() {
    this.db = FADE_FLOOR_DB;
    this.target = FADE_FLOOR_DB;
    this.onSilent = null;
  }

  // 0..1 amplitude of the song
  get gain() {
    return this.db <= FADE_FLOOR_DB ? 0 : 10 ** (this.db / 20);
  }

  // The player's volume for that amplitude
  get volume() {
    return Math.round(this.gain * FULL_VOLUME);
  }

  get silent() {
    return this.db <= FADE_FLOOR_DB;
  }

  // Straight to silence, ready for a fade-in (a new start)
  silence() {
    this.db = this.target = FADE_FLOOR_DB;
    this.onSilent = null;
  }

  fadeIn() {
    this.target = 0;
    this.onSilent = null;
  }

  // Fades to silence and then calls onSilent once (at once when already silent)
  fadeOut(onSilent = null) {
    this.target = FADE_FLOOR_DB;
    this.onSilent = onSilent;
    if (this.silent) this.finish();
  }

  finish() {
    const done = this.onSilent;
    this.onSilent = null;
    if (done) done();
  }

  update(dt) {
    if (!(dt > 0) || this.db === this.target) return;
    const rising = this.target > this.db;
    const rate = -FADE_FLOOR_DB / (rising ? FADE_IN_TIME : FADE_OUT_TIME); // dB per second
    const step = rate * Math.min(dt, 0.1);
    this.db = rising ? Math.min(this.target, this.db + step) : Math.max(this.target, this.db - step);
    if (this.silent && !rising) this.finish();
  }
}

// The city mix's gain under a song playing at `musicGain` (0..1)
function duckGain(musicGain) {
  return 1 - MUSIC_DUCK * Math.min(1, Math.max(0, musicGain));
}

// Moves the audio system's mix gain to the duck for the song's level, rescheduling only when it moves
class MusicDuck {
  constructor() {
    this.mix = null;
    this.applied = 1;
  }

  update(audioSystem, musicGain) {
    const mix = audioSystem?.mix;
    const context = audioSystem?.context;
    if (!mix || !context || context.state === 'closed') return;
    const wanted = duckGain(musicGain);
    // A rebuilt audio graph starts at full gain
    if (mix !== this.mix) {
      this.mix = mix;
      this.applied = 1;
    }
    if (Math.abs(wanted - this.applied) < DUCK_EPSILON) return;
    this.applied = wanted;
    mix.gain.setTargetAtTime(wanted, context.currentTime, DUCK_SMOOTHING);
  }
}

export { FADE_IN_TIME, FADE_OUT_TIME, FADE_FLOOR_DB, FULL_VOLUME, MUSIC_DUCK, MusicFader, MusicDuck, duckGain };
