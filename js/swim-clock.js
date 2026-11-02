import * as THREE from 'three/webgpu';
import { stepSwim } from './swim-car.js';
import { trafficMath } from './swim-traffic.js';

// The swimming car's fixed clock. In swim mode the car (its keyboard driver, the AI pressing its keys, the flight
// recorder, its collisions), the director's scoring, the cop and the traffic and pedestrians it can hit step together
// in whole ticks of SWIM_TICK: each frame's time goes into an accumulator, as many ticks as it holds are stepped, and
// what is left carries on to the next frame. The same seed and the same keys tick by tick then give the same run on
// any screen, at 30, 60, 120 or 144 Hz or a mix of them, and a recorded run plays back exactly (session-recorder.js,
// tools/swim-replay). The frame draws the car between its last two ticks (drawPose), so a frame that steps one tick
// and the next that steps two still move it smoothly; the camera follows that drawn car.
//
// The tick is 1/120 s: two of the drift model's 1/240 s steps, so its physics is the very one it was tuned on
// (Math.ceil(dt * 240) steps of dt / steps, which at 120 Hz is two steps of 1/240), the AI's donut look-ahead plays
// the 120 Hz frames it was tuned and tested on, and a key is read within 8 ms of being pressed. A 60 Hz screen steps
// two ticks a frame, a 30 Hz one four.
//
// A run starts when the car enters swim mode, when the AI show starts (P) and after a teleport (startRun): the city's
// traffic and pedestrians are laid out again round the car from the run's seed (swim-traffic.js reseed), the one
// seeded random source everything the car's run depends on draws from (trafficMath.random), and the recorder notes
// the start. Cosmetic randomness (smoke, sparks' looks, sounds) stays on Math.random.
//
// main.js keeps three hooks: elapsed = clock.advance(dt, elapsed, mode) before the frame's updates, draw-only traffic
// while clock.active, and clock.endFrame() after the render.

const SWIM_TICK = 1 / 120; // s
const SNAP = 1e-6; // s: a frame this close to a whole number of ticks makes them (frame times are rounded by the browser)
// The traffic's protected view while the clock steps it: a chase camera fixed to the car's own state (what the
// player's camera sees depends on the frame rate; this doesn't), wider than the real one so nothing spawns on screen
const VIEW_FOV = 80; // degrees
const VIEW_ASPECT = 2;
const VIEW_BACK = 7.6; // m behind the car (swim-car.js chaseDistance)
const VIEW_UP = 2.6; // m

function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

// Ticks of a fixed length out of frames of any length
class FixedClock {
  constructor(tick = SWIM_TICK) {
    this.tick = tick;
    this.leftover = 0; // s not yet stepped
    this.ticks = 0; // ticks stepped since the page loaded
  }

  // Adds a frame's time and calls step(tick) for every whole tick it makes. Returns how many it stepped.
  advance(dt, step) {
    this.leftover += dt;
    let stepped = 0;
    while (this.leftover >= this.tick - SNAP) {
      this.leftover -= this.tick;
      step(this.tick);
      this.ticks++;
      stepped++;
    }
    return stepped;
  }

  // How far the frame is from the last tick to the next one, 0-1
  get alpha() {
    return Math.min(1, Math.max(0, this.leftover / this.tick));
  }
}

// The car as drawn: what the camera follows and the body shows, interpolated between two ticks
function capturePose(car, into = {}) {
  into.x = car.position.x;
  into.y = car.position.y;
  into.z = car.position.z;
  into.heading = car.heading;
  into.cameraYaw = car.cameraYaw;
  into.povYaw = car.povYaw ?? 0;
  into.steerAngle = car.steerAngle;
  into.wheelSpin = car.wheelSpin ?? 0;
  into.rearWheelSpin = car.rearWheelSpin ?? 0;
  const pivot = car.chassisPivot;
  into.pitch = pivot ? pivot.rotation.x : 0;
  into.roll = pivot ? pivot.rotation.z : 0;
  into.heave = pivot ? pivot.position.y : 0;
  return into;
}

// Writes the pose between a and b onto the car (its sim state is saved first, see SwimClock.drawFrame)
function drawPose(car, a, b, t) {
  car.position.x = lerp(a.x, b.x, t);
  car.position.y = lerp(a.y, b.y, t);
  car.position.z = lerp(a.z, b.z, t);
  car.heading = lerpAngle(a.heading, b.heading, t);
  car.cameraYaw = lerpAngle(a.cameraYaw, b.cameraYaw, t);
  if (car.povYaw !== undefined) car.povYaw = lerpAngle(a.povYaw, b.povYaw, t);
  car.steerAngle = lerp(a.steerAngle, b.steerAngle, t);
  const pivot = car.chassisPivot;
  if (pivot) {
    pivot.rotation.x = lerp(a.pitch, b.pitch, t);
    pivot.rotation.z = lerp(a.roll, b.roll, t);
    pivot.position.y = lerp(a.heave, b.heave, t);
  }
  for (const w of car.wheels ?? []) {
    w.tire.rotation.x = lerpAngle(w.isFront ? a.wheelSpin : a.rearWheelSpin, w.isFront ? b.wheelSpin : b.rearWheelSpin, t);
    if (w.isFront) w.steerPivot.rotation.y = car.steerAngle;
  }
}

// The sim's own values of what drawPose writes, put back after the frame is drawn
function restorePose(car, saved) {
  car.position.x = saved.x;
  car.position.y = saved.y;
  car.position.z = saved.z;
  car.heading = saved.heading;
  car.cameraYaw = saved.cameraYaw;
  if (car.povYaw !== undefined) car.povYaw = saved.povYaw;
  car.steerAngle = saved.steerAngle;
  const pivot = car.chassisPivot;
  if (pivot) {
    pivot.rotation.x = saved.pitch;
    pivot.rotation.z = saved.roll;
    pivot.position.y = saved.heave;
  }
}

// Whether something outside the ticks moved the car (a teleport, the show's start): no drawing across that
function moved(car, pose) {
  return car.position.x !== pose.x || car.position.z !== pose.z || car.heading !== pose.heading;
}

class SwimClock {
  // controllers: the ThirdPersonControllerManager; director: the SwimDirector (its traffic is the city's traffic
  // system); view: the camera standing in for the player's in the traffic's sim (a THREE camera, made here by default)
  constructor({ controllers, director, traffic = director.traffic, view = null, tick = SWIM_TICK }) {
    this.controllers = controllers;
    this.director = director;
    this.traffic = traffic;
    this.clock = new FixedClock(tick);
    this.view = view ?? new THREE.PerspectiveCamera(VIEW_FOV, VIEW_ASPECT, 0.5, 2000);
    this.active = false; // the clock stepped this frame (swim mode)
    this.elapsed = 0; // the city's clock (signals) at the last tick
    this.prev = {};
    this.curr = {};
    this.saved = {};
    this.drawn = false;
    this.drawnAt = { x: 0, z: 0, heading: 0 }; // where drawFrame() put the car

    this.pendingRun = null;
    this.run = null; // the run being driven: { seed, x, z, reason, tick }
    this.beforeTick = null; // (tick) → called before each tick: a replay presses its keys here (tools/swim-replay)
    this.onRun = null; // (run) → called as a run starts, with what a replay needs (session-recorder.js)
  }

  get tick() {
    return this.clock.tick;
  }

  get ticks() {
    return this.clock.ticks;
  }

  get alpha() {
    return this.clock.alpha;
  }

  /**
   * Starts a run at the next frame: the traffic and pedestrians laid out again round (x, z), by default where the car
   * is, from `seed` (by default a fresh one). The last call before the frame wins: entering swim mode and then the
   * show in one key press is the show's run. `elapsed`: the city's clock to start it on (a replay's, as recorded),
   * by default the clock as it is.
   */
  startRun({ seed = Math.floor(Math.random() * 2 ** 31), x = null, z = null, reason = 'start', elapsed = null } = {}) {
    this.pendingRun = { seed, x, z, reason, elapsed };
  }

  /**
   * One frame of main.js's loop: in swim mode, steps the ticks the frame's time makes (and the city's clock with
   * them) and puts the car's drawn pose on it for the rest of the frame. Returns the city's elapsed seconds.
   */
  advance(dt, elapsed, mode) {
    // (a frame that threw before endFrame() left the drawn pose on the car: the sim state back first, unless something
    // has moved the car since, a teleport, which then starts its run)
    if (this.drawn && !moved(this.controllers.entities.swim, this.drawnAt)) this.endFrame();
    this.drawn = false;
    this.active = mode === 'swim';
    if (!this.active) {
      this.clock.leftover = 0;
      this.run = null;
      return elapsed + dt;
    }
    const car = this.controllers.entities.swim;
    // A run starts on entering the mode, and anew where a teleport put the car
    if (!this.pendingRun && (!this.run || moved(car, this.curr))) this.startRun({ reason: this.run ? 'teleport' : 'start' });
    this.elapsed = this.pendingRun ? this.beginRun(car, elapsed) : elapsed;
    this.clock.advance(dt, (tick) => {
      capturePose(car, this.prev);
      this.elapsed += tick;
      this.beforeTick?.(this.clock.ticks);
      this.step(car, tick);
      capturePose(car, this.curr);
    });
    this.drawFrame(car);
    return this.elapsed;
  }

  // The run starts: the city laid out from its seed, the car drawn where it is. Returns the city's clock it starts on.
  beginRun(car, elapsed) {
    const run = this.pendingRun;
    this.pendingRun = null;
    run.x ??= car.position.x;
    run.z ??= car.position.z;
    run.tick = this.clock.ticks;
    run.elapsed ??= elapsed;
    this.traffic.reseed?.(run.seed, run.x, run.z);
    this.run = run;
    capturePose(car, this.prev);
    capturePose(car, this.curr);
    this.onRun?.(run, car);
    return run.elapsed;
  }

  // One tick of everything the car's run depends on, in the order the frame loop ran them
  step(car, tick) {
    this.placeView(car);
    this.traffic.view?.(this.view);
    stepSwim(this.controllers, tick);
    this.director.step(tick);
    this.traffic.step?.(tick, this.elapsed, this.view.position, car, 'swim', this.view);
  }

  // The traffic's stand-in camera: behind the car on its camera yaw, looking at it
  placeView(car) {
    const yaw = car.cameraYaw ?? car.heading;
    const view = this.view;
    view.position.set(car.position.x - Math.sin(yaw) * VIEW_BACK, VIEW_UP, car.position.z - Math.cos(yaw) * VIEW_BACK);
    view.lookAt(car.position.x + Math.sin(yaw) * VIEW_BACK, 1, car.position.z + Math.cos(yaw) * VIEW_BACK);
  }

  // The car drawn between its last two ticks until endFrame()
  drawFrame(car) {
    capturePose(car, this.saved);
    drawPose(car, this.prev, this.curr, this.clock.alpha);
    this.drawnAt.x = car.position.x;
    this.drawnAt.z = car.position.z;
    this.drawnAt.heading = car.heading;
    this.drawn = true;
  }

  /** After the frame is drawn (main.js): the car's sim state back, as the next ticks and any key handler expect it. */
  endFrame() {
    if (!this.drawn) return;
    this.drawn = false;
    restorePose(this.controllers.entities.swim, this.saved);
  }

  // The run's seeded random source (a fresh seed for a roam the player hands back, say)
  random() {
    return trafficMath.random();
  }
}

export { FixedClock, SWIM_TICK, SwimClock, capturePose, drawPose, restorePose };
