// A punch of the camera when a close call or a split scores (swim-mode.js CloseCalls), the player's or the show's: the
// follow view kicks a few degrees wider and jolts, then eases back over a third of a second. cameras.js adds it on top
// of its speed feel (SPEED_FOV, SHAKE). Pure and DOM-free, for tests.

const SCORE_KICK = {
  fov: 3.5, // ° wider at the kick's peak (a close call)
  shake: 0.05, // m of extra shiver at its peak
  attack: 0.04, // s it takes to reach the peak (a punch, not a cut)
  time: 0.3, // s from the kick until it has eased out
  split: 1.6 // a split kicks this many times as hard as a close call
};
const MIN_SPAN = 1e-3; // s: the shortest rise or fall the envelope divides by

class ScoreKick {
  constructor(options = {}) {
    this.o = { ...SCORE_KICK, ...options };
    this.age = Infinity; // s since the last kick
    this.strength = 0;
    this.fov = 0; // ° to add to the field of view this frame
    this.shake = 0; // m of shiver to add this frame
  }

  // A close call (or, `split`, a split) scored: kick, at least as hard as whatever is still showing of the last one
  trigger(split = false) {
    const strength = split ? this.o.split : 1;
    this.strength = Math.max(strength, this.strength * this.envelope());
    this.age = 0;
  }

  // Share of the peak showing `age` seconds after the kick: a quick rise, then an ease out to nothing at `time`
  envelope(age = this.age) {
    const o = this.o;
    if (!(age < o.time)) return 0;
    // (an attack of 0, or as long as the whole kick, can't divide by nothing)
    const attack = Math.min(Math.max(o.attack, MIN_SPAN), o.time - MIN_SPAN);
    const rise = Math.min(1, age / attack);
    const fall = 1 - Math.max(0, age - attack) / (o.time - attack);
    return rise * fall * fall;
  }

  // One frame on: returns this, with this frame's fov and shake
  update(dt) {
    this.age += dt;
    const level = this.strength * this.envelope();
    this.fov = this.o.fov * level;
    this.shake = this.o.shake * level;
    // (spent once the kick has run its time; a frame with no time in it at the start leaves it waiting to rise)
    if (this.age >= this.o.time) this.strength = 0;
    return this;
  }
}

export { SCORE_KICK, ScoreKick };
