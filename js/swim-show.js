import * as THREE from 'three/webgpu';
import { avenueX, nearestRoads, streetZ } from './city-config.js';
import {
  BODY_SPECS,
  buildCarGeometry,
  buildLightbarGeometry,
  buildSteerableWheelGeo,
  carStyleCode,
  createCarWheelMaterial,
  createLightbarMaterial,
  createLoftedCarMaterial
} from './cars.js';
import { createContactShadowMaterial } from './tsl-materials.js';
import { KEYBOARD_DRIVER, KeyboardDriver, M5_DRIFT, stepDriftCar } from './drift-physics.js';
import { DriftAutopilot, Hands, steeringKey, travelHeading } from './drift-autopilot.js';
import { resolveVehicleContact, vehicleContact } from './vehicle-physics.js';
import { RoamRoute } from './swim-roam.js';

// The swimming show: the AI takes the car through the reference clips' greatest hits, and keeps driving for as long as
// the player lets it. Times Square is cleared of traffic, an NYPD cruiser watches with its lights on, the car rolls up
// to it at a crawl, floors it and drifts circles round it, runs from the cop down 7th Ave and swims through traffic up
// 8th Ave, and then roams Midtown on its own (swim-roam.js), swimming every avenue and drifting every corner. Any
// driving key takes the wheel; I hands it back (main.js), and the AI drives on from wherever the car is.

const RAD = Math.PI / 180;

// The cruiser parks in the middle of 7th Ave & 45th St, at the foot of the bowtie, facing west across it. The car
// comes down 7th Ave toward it at a crawl, on the line that passes it on the left at the circle's radius, and drifts
// round it from there: it joins the circle due west of the cop, travelling south (the way 7th Ave runs), so the last
// lap leaves it pointing down the avenue.
const COP_SPOT = { x: avenueX('7') - 2, z: streetZ(45) };
const COP_HEADING = -Math.PI / 2;
const DRIFT_RADIUS = 11; // m from the cop to the car: the circle fills the crossing, the way the clip's does, and
// clears the Con Ed steam stack 6 m from the cop by two
const ENTRY_BEARING = -Math.PI / 2; // bearing from the cop where the car joins the circle (due west)
const ROLL_DISTANCE = 22; // m of crawl up 7th Ave before it is level with the cop
const SHOW_SPOT = { x: COP_SPOT.x - DRIFT_RADIUS, z: COP_SPOT.z - ROLL_DISTANCE, heading: 0 };
const SHOW_TRAFFIC_SEED = 1; // traffic layout of the opening (traffic.js reseed)
// Where in the 60 s signal cycle (city-config.js SIGNAL_TIMING) the show starts: the avenues turn green as the car
// leaves the drift circle (~20 s in: the roll, two laps), so the run down 7th Ave meets the same lights every time
const SHOW_SIGNAL_TIME = 40;
const SHOW_CLEAR_RADIUS = 42; // m of Times Square kept clear of traffic for the stunts
// The run: down 7th Ave, west on 42nd St, up 8th Ave past Smith's, west on 57th St to 9th Ave, where the roam takes
// over (swim-roam.js; past 10th Ave a block stands across 57th St). The avenues are one-way, so the line runs down
// their middle; 42nd and 57th are two-way, so it keeps to the westbound (north, -z) half.
const WESTBOUND = -3.5;
// The drift into 42nd St turns at this offset instead: its slide swings about 2 m wide, which from the westbound line
// would end nose to nose with the eastbound queue (where the show once stalled for good)
const INTO_42ND = -5.5;
const ESCAPE_ROUTE = [
  [COP_SPOT.x, COP_SPOT.z],
  [avenueX('7'), streetZ(42) + INTO_42ND],
  [avenueX('8'), streetZ(42) + WESTBOUND],
  [avenueX('8'), streetZ(57) + WESTBOUND],
  [avenueX('9'), streetZ(57) + WESTBOUND]
].map(([x, z]) => ({ x, z }));

const DONUT_LAPS = 2; // laps round the cop before it looks for the way out
const DONUT_TIME_LIMIT = 30; // s of donuts before it powers out wherever it is (a fallback: the show goes on)
// The roll-up and the first lap are seen from the chase camera turned across the car at the cop, so the circle round
// it reads; the second lap from the driver's seat, as the BMW short is filmed: the driver looks across at the cop and
// puts the bird out of the window (where the short has it against the chorus), the last thing before driving off
const POV_FROM_LAP = 1;
const BIRD_FROM_LAP = 1.15;
const BIRD_TO_LAP = 1.85;
const CHASE_ACROSS = 0.45; // rad the chase camera turns past the line to the cop, so the car and the cop share the shot
const COP_GLANCE_LIMIT = 70 * RAD; // how far round from the windshield the driver turns to watch the cop
const GLANCE_RATE = 2.5; // 1/s easing of the driver's look
const EXIT_WINDOW = 25 * RAD; // the way out this far ahead of the direction of travel: power out (later in the lap,
// the slide comes out already pointing down the avenue and the car can floor it)
const EXIT_TIME_LIMIT = 3; // s of powering out before the autopilot takes over however straight the car is
const EXIT_SLIP = 10 * RAD; // the slide is over below this drift angle,
const EXIT_ALIGN = 60 * RAD; // and with the car travelling roughly the way out, the autopilot steers it back onto the avenue
const ESCAPE_MERGE = 40; // m down 7th Ave from the cop where the escape is back in the avenue's middle: a long merge,
// so the swing back from the plaza is a gentle one taken flat out
const EXIT_LOOKAHEAD = 30; // m down the avenue's middle line ahead of the car that it powers out of the circle toward
const CHASE_TIME = 14; // s the cop keeps up the chase before it gives up
const LOOK_BACK_TIME = 2.5; // s the swim's chase camera opens looking back at the cop giving up
const ROUTE_AHEAD = 3; // corners the route is kept ahead of the car, so the planner always sees the next turn
const ROAM_SEED = 7; // the roam's choices, the same every show (a hand-back roams differently each time)
const STUCK_TIME = 2; // s standing still before the AI backs out
const HOLD_BACK = 15; // m the cop keeps behind the car it chases
const CORNER_CLEAR_DISTANCE = 110; // m out from a drift corner that the show starts holding its traffic
const CORNER_CLEAR_RADIUS = 26;
const HELD_QUEUE_REACH = 40; // m short of that zone that a queue may be cars held for it (not a red light's: see unstick)
const QUEUE_PATIENCE = 40; // s it waits in a queue at most (a red light lasts 34 s, city-config.js SIGNAL_TIMING)
// m past a corner where the street's staged traffic starts (traffic.js stageRoute): past a drifted corner, more, so the
// car has caught the slide and is running straight before the first pair to split
const STAGE_GAP = 30;
const STAGE_GAP_AFTER_DRIFT = 45;
const REVERSE_TIME = 1.1; // s backing out, times the tries so far (up to MAX_REVERSE_TRIES) while it is still stuck
const MAX_REVERSE_TRIES = 3;
const UNSTUCK_SPEED = 8; // m/s: going again, the tries start over
const UNSTICK_AIM = 15; // m down the route that the nose is swung toward while backing out,
const UNSTICK_ALIGNED = 5 * RAD; // to within this
const SIM_STEPS_PER_SECOND = 240; // the drift model's step rate (controllers.js steps the M5 the same)

// The show's swimmer is sketchier than the autopilot's defaults (drift-autopilot.js AUTOPILOT): flat out at 90 mph,
// threading gaps with a hand's width of air and going out of its way for a close pass, but sure of its line before it
// commits to a split (planSpread: at that speed a row comes up every second or two), and heading for the gap of the
// next pair while it is still out of reach (splitLineUp), so it isn't a lane off when it gets there
const SHOW_SWIMMING = {
  cruiseSpeed: 40,
  planSpread: 0.2,
  lateBonus: 20,
  passMargin: 0.2,
  closeBonus: 60,
  splitBonus: 100,
  splitLineUp: 20
};

const GATHER_RANGE = 130; // m round the car that traffic is handed to the AI (it plans 120 m ahead)
const CURB_MARGIN = 1.4; // m between the curb and the middle of the car at the edge of a swim

// The street under each leg of a route, as lateral bounds about the route line (m, + left of travel) for the AI's
// swimming: the whole curb-to-curb width, and on a two-way street the centre line it should only cross to pass.
function routeCorridors(route) {
  const corridors = [];
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length;
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    // The street running the same way as the leg, nearest the leg's middle
    let best = null;
    for (const { road } of nearestRoads(mx, mz, 30)) {
      for (let k = 0; k < road.pts.length - 1; k++) {
        const p = road.pts[k], q = road.pts[k + 1];
        const dx = q.x - p.x, dz = q.z - p.z;
        const segLength = Math.hypot(dx, dz) || 1;
        if (Math.abs((dx * ux + dz * uz) / segLength) < 0.9) continue;
        const t = Math.max(0, Math.min(1, ((mx - p.x) * dx + (mz - p.z) * dz) / (segLength * segLength)));
        const cx = p.x + dx * t, cz = p.z + dz * t;
        const distance = Math.hypot(cx - mx, cz - mz);
        if (!best || distance < best.distance) best = { road, cx, cz, distance };
      }
    }
    if (!best) {
      corridors.push({ left: 3.5, right: -3.5, centre: null });
      continue;
    }
    const centre = (best.cx - mx) * uz - (best.cz - mz) * ux;
    const half = Math.max(1, best.road.w / 2 - CURB_MARGIN);
    corridors.push({ left: centre + half, right: centre - half, centre: best.road.dir === 'TW' ? centre : null });
  }
  return corridors;
}

// The opening as the BMW short drives it, on the keys as a player holds them, closed-loop on what the driver sees (how
// far the cop is, whether the car is closing on it or running wide, and the angle of the slide), so it holds when the
// handling changes:
//   roll:     down the avenue at a crawl on a feathered W, lined up to pass the cop on the left;
//   launch:   alongside the cop, W floored (the rears spin up as the traction control lets them) and the wheel turned
//             onto the circle, aiming a little way round it;
//   kick:     at speed, a flick of the handbrake with the lock on: the tail comes round;
//   drift:    round and round the cop (below);
//   powerOut: the way out comes round: flat out, the counter-steer unwinding the slide down the avenue.
const DONUT = {
  rollSpeed: 5, // m/s (11 mph) of the crawl up to the cop
  rollBand: 0.6, // m/s under rollSpeed at which W is pressed again (a feathered pedal)
  rollLookahead: 8, // m down the roll line that it steers at
  rollSteerGain: 3, // share of lock per radian of aim error, rolling
  launchLead: 0.5, // s before the car is level with the cop that it floors it
  aheadArc: 0.7, // rad along the circle ahead that it aims at while it drives onto it
  steerGain: 5, // share of lock per radian of aim error while driving onto the circle
  kickSpeed: 9, // m/s at which it flicks into the slide
  kickTime: 0.25, // s of handbrake
  slideAngle: 20 * RAD, // a slide this deep while driving onto the circle is the drift already: no flick needed
  // On the circle it drives as a player feels a donut ahead: a few times a second it weighs each thing it could do
  // with its hands and feet (the wheel at one of `wheels`, W down or up, a dab of the handbrake), plays each a moment
  // ahead on the car's own physics through its own keyboard driver (so it knows the car as the player does, however
  // the handling is tuned), and takes the one that keeps the car sideways on the circle round the cop. Hand-tuned
  // rules on the angle and the radius held the circle on one tune and lost it on the next: lifting off W lets the rears
  // grip and kills the slide within half a second, W held makes the slide quicker and wider, and a dab of the
  // handbrake scrubs speed but swings the tail out.
  wheels: [1, 0.6, 0.3, 0, -0.4], // shares of lock (+ into the turn) it tries
  decideEvery: 0.1, // s between choices (the handbrake dab lasts one)
  horizon: 1.6, // s it looks ahead (a donut lap takes ~6)
  pedalTime: 0.3, // s a lift off W lasts in its look ahead, before W goes down again
  // (the look-ahead plays the game's own frames, as long as the last one: its hands press keys a frame at a time, and a
  // tap lasts a whole number of them, 83 ms at 60 Hz, 100 ms at 40)
  physicsStep: 1 / 120, // s per look-ahead physics step, about
  // The cost of a moment of the look-ahead: the square of each metre off the circle, of a slide dying (under
  // minAngle, per 10°) or spinning (over maxAngle), and of a crawl
  minAngle: 22 * RAD,
  maxAngle: 58 * RAD,
  deadCost: 20,
  spinCost: 10,
  minSpeed: 6, // m/s
  crawlCost: 2,
  exitAngle: 20 * RAD // powering out, flat out and counter-steering until the slide is down to this
};

// s: the frame times the donuts' look-ahead plays, at most and least (a hitch of a frame doesn't make it a coarse one)
const MAX_LOOK_FRAME = 1 / 30;
const MIN_LOOK_FRAME = 1 / 240;

// The car's own state, the numbers stepDriftCar and the keyboard driver read and write, copied out for a look-ahead
function snapshotCar(car, into = {}) {
  for (const key in car) {
    const value = car[key];
    if (typeof value === 'number' || typeof value === 'boolean') into[key] = value;
  }
  into.position = { x: car.position.x, z: car.position.z };
  into.drift = {};
  return into;
}

function restoreCar(snapshot, into) {
  // (its own position and telemetry objects: the look-ahead must not move the snapshot)
  const position = into.position, drift = into.drift;
  Object.assign(into, snapshot);
  into.position = position;
  into.drift = drift;
  position.x = snapshot.position.x;
  position.z = snapshot.position.z;
  return into;
}

function copyDriver(driver, into) {
  const input = into?.input ?? {};
  Object.assign(input, driver.input);
  into = Object.assign(into ?? Object.create(Object.getPrototypeOf(driver)), driver);
  into.input = input;
  return into;
}

class DonutDriver {
  // entry: the bearing from the centre where the car joins the circle; the roll comes up to it along the tangent.
  // hands: the Hands that press its keys (drift-autopilot.js), which it reads to choose keys they can press, and whose
  // copy its look-ahead plays its keys through
  constructor(center, radius, entry, options = {}, hands = new Hands()) {
    this.o = { ...DONUT, ...options };
    this.hands = hands;
    this.center = center;
    this.radius = radius;
    this.entry = entry;
    this.feather = false;
    this.phase = 'roll'; // 'roll' | 'launch' | 'kick' | 'drift' | 'powerOut'
    this.time = 0; // s in the current phase
    this.swept = 0; // rad swept round the centre since the launch
    this.bearing = null;
  }

  // Laps round the centre since the car floored it
  get laps() {
    return this.swept / (2 * Math.PI);
  }

  // Flat out and counter-steering the slide down, as a player drives out of a drift
  powerOut() {
    this.phase = 'powerOut';
    this.time = 0;
  }

  setPhase(phase) {
    this.phase = phase;
    this.time = 0;
  }

  // The hands and feet to use for the next moment of the drift: each choice played ahead on a copy of the car, of its
  // keyboard driver and of its hands (the wheel tapped toward its share of lock all the way, W up only for pedalTime,
  // the handbrake only for one decision, every key as the hands can press it), the one whose look-ahead stays sideways
  // on the circle wins
  choose(car, driver, frame) {
    const o = this.o;
    const model = driver.model;
    const base = this._base = snapshotCar(car, this._base);
    const sim = this._sim ??= snapshotCar(car);
    const keys = this._keys ??= { forward: 0, backward: 0, left: 0, right: 0, handbrake: 0 };
    const simHands = this._simHands ??= new Hands();
    const telemetry = this._telemetry ??= {};
    const frames = Math.round(o.horizon / frame);
    const substeps = Math.max(1, Math.round(frame / o.physicsStep));
    const step = frame / substeps;
    let best = null;
    for (const wheel of o.wheels) for (const forward of [1, 0]) for (const handbrake of [0, 1]) {
      restoreCar(base, sim);
      const simDriver = this._simDriver = copyDriver(driver, this._simDriver);
      simHands.copyFrom(this.hands);
      let cost = 0;
      for (let f = 0; f < frames; f++) {
        const t = f * frame;
        const key = steeringKey(simDriver, wheel, sim.speed, frame, simHands);
        keys.left = key > 0 ? 1 : 0;
        keys.right = key < 0 ? 1 : 0;
        keys.forward = t < o.pedalTime ? forward : 1;
        keys.handbrake = t < o.decideEvery ? handbrake : 0;
        const input = simDriver.update(sim, simHands.press(keys, frame), frame);
        for (let i = 0; i < substeps; i++) stepDriftCar(sim, input, step, model, telemetry);
        const distance = Math.hypot(sim.position.x - this.center.x, sim.position.z - this.center.z);
        const v = Math.hypot(sim.speed, sim.vx, sim.vz);
        const lateral = sim.vx * Math.cos(sim.heading) - sim.vz * Math.sin(sim.heading);
        const angle = v > 2 ? -Math.atan2(lateral, Math.abs(sim.speed)) : 0;
        const dead = Math.max(0, o.minAngle - angle) / (10 * RAD);
        const spin = Math.max(0, angle - o.maxAngle) / (10 * RAD);
        const crawl = Math.max(0, o.minSpeed - v);
        cost += (distance - this.radius) ** 2 + o.deadCost * dead * dead + o.spinCost * spin * spin + o.crawlCost * crawl * crawl;
      }
      if (!best || cost < best.cost) best = { cost, wheel, forward, handbrake };
    }
    return best;
  }

  // One frame of keys orbiting the centre to the left (the bearing from the centre grows)
  update(car, dt, driver, keys) {
    const o = this.o;
    this.time += dt;
    const dx = car.position.x - this.center.x, dz = car.position.z - this.center.z;
    const distance = Math.max(0.1, Math.hypot(dx, dz));
    const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
    const vx = sin * car.speed + car.vx, vz = cos * car.speed + car.vz;
    const ground = Math.hypot(vx, vz);
    const lateral = car.vx * cos - car.vz * sin;
    const angle = ground > 2 ? -Math.atan2(lateral, Math.abs(car.speed)) : 0; // a left drift's angle, + nose in
    const bearing = Math.atan2(dx, dz);
    if (this.phase !== 'roll' && this.bearing !== null) this.swept += wrapAngle(bearing - this.bearing);
    this.bearing = bearing;
    const radial = (vx * dx + vz * dz) / distance; // m/s away from the centre
    keys.forward = 0;
    keys.backward = 0;
    keys.handbrake = 0;
    let want = 0;
    if (this.phase === 'roll') {
      // The roll line is the circle's tangent at the bearing it joins on, run the way the orbit goes
      const entry = this.entry;
      const px = this.center.x + Math.sin(entry) * this.radius, pz = this.center.z + Math.cos(entry) * this.radius;
      const tx = Math.cos(entry), tz = -Math.sin(entry);
      const toEntry = (px - car.position.x) * tx + (pz - car.position.z) * tz; // m still to go to the tangent point
      const aimX = px - tx * (toEntry - o.rollLookahead), aimZ = pz - tz * (toEntry - o.rollLookahead);
      const error = wrapAngle(Math.atan2(aimX - car.position.x, aimZ - car.position.z) - travelHeading(car));
      want = Math.max(-1, Math.min(1, error * o.rollSteerGain));
      // A feathered W: pressed once the car has slowed under the band, let go once it is back up to the crawl
      if (ground < o.rollSpeed - o.rollBand) this.feather = true;
      else if (ground > o.rollSpeed) this.feather = false;
      keys.forward = this.feather ? 1 : 0;
      if (toEntry < ground * o.launchLead) this.setPhase('launch');
    } else if (this.phase === 'launch') {
      // Floored, the wheel turned onto the circle, aiming a little way round it
      keys.forward = 1;
      const aim = bearing + o.aheadArc;
      const aimX = this.center.x + Math.sin(aim) * this.radius, aimZ = this.center.z + Math.cos(aim) * this.radius;
      const error = wrapAngle(Math.atan2(aimX - car.position.x, aimZ - car.position.z) - travelHeading(car));
      want = Math.max(-1, Math.min(1, error * o.steerGain));
      // (on the reworked slide steering the car often steps out on its own here: that is the drift already)
      if (angle > o.slideAngle) this.setPhase('drift');
      else if (ground > o.kickSpeed) this.setPhase('kick');
    } else if (this.phase === 'kick') {
      // The flick: off the gas, the handbrake and the lock into the turn
      want = 1;
      keys.handbrake = 1;
      if (this.time > o.kickTime) this.setPhase('drift');
    } else if (this.phase === 'drift') {
      this.sinceChoice = (this.sinceChoice ?? Infinity) + dt;
      if (this.sinceChoice >= o.decideEvery) {
        this.choice = this.choose(car, driver, Math.min(MAX_LOOK_FRAME, Math.max(MIN_LOOK_FRAME, dt)));
        this.sinceChoice = 0;
      }
      want = this.choice.wheel;
      keys.forward = this.choice.forward;
      keys.handbrake = this.choice.handbrake;
    } else if (this.phase === 'powerOut') {
      keys.forward = 1;
      want = angle > o.exitAngle ? -1 : 0;
    }
    const key = steeringKey(driver, want, car.speed, dt, this.hands);
    keys.left = key > 0 ? 1 : 0;
    keys.right = key < 0 ? 1 : 0;
    return keys;
  }
}

function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// A police SUV: drift physics with less power than the M5, so it can chase but not catch
const COP_DRIFT = { ...M5_DRIFT, mass: 2250, yawInertia: 4300, power: 420000, peakTorque: 650, launchGrip: 1.6, topSpeed: 46 };
const COP_PAINT = new THREE.Color(0xf6f9fc);

// Two-tone wail: a square wave sweeping up and down through a low-pass, in the city's audio mix
class Siren {
  constructor(audioSystem) {
    this.audio = audioSystem;
    this.voice = null;
  }

  build(context) {
    const osc = context.createOscillator();
    osc.type = 'square';
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2400;
    const gain = context.createGain();
    gain.gain.value = 0;
    osc.connect(filter).connect(gain).connect(this.audio.mix);
    osc.start();
    this.voice = { context, osc, gain };
  }

  update(on, distance, elapsed) {
    const context = this.audio.context;
    if (!context || !this.audio.mix || context.state === 'closed') return;
    if (!this.voice || this.voice.context !== context) this.build(context);
    const now = context.currentTime;
    const sweep = 0.5 + 0.5 * Math.sin(elapsed * Math.PI * 2 / 3.4);
    this.voice.osc.frequency.setTargetAtTime(640 + sweep * 760, now, 0.04);
    const level = on && this.audio.enabled ? 0.11 / (1 + distance / 30) : 0;
    this.voice.gain.gain.setTargetAtTime(level, now, 0.15);
  }
}

class PoliceCruiser {
  constructor(scene, audioSystem) {
    const spec = BODY_SPECS.suv;
    this.spec = spec;
    this.root = new THREE.Group();
    this.root.name = 'SwimShowNYPDCruiser';
    this.root.visible = false;

    // The traffic material with the NYPD livery (style code 1) on a single instance
    const geometry = buildCarGeometry(spec, false);
    geometry.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array([COP_PAINT.r, COP_PAINT.g, COP_PAINT.b]), 3));
    geometry.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0, carStyleCode({ livery: 1 })]), 4));
    const body = new THREE.InstancedMesh(geometry, createLoftedCarMaterial(spec), 1);
    body.setMatrixAt(0, new THREE.Matrix4());
    body.castShadow = true;
    const lightbar = new THREE.InstancedMesh(buildLightbarGeometry(spec), createLightbarMaterial(), 1);
    lightbar.setMatrixAt(0, new THREE.Matrix4());
    this.root.add(body, lightbar);

    const wheelMat = createCarWheelMaterial({ wheelRadius: spec.wheelRadius });
    this.wheels = [];
    for (const [side, z] of [[-1, spec.wheelZ], [1, spec.wheelZ], [-1, -spec.wheelZ], [1, -spec.wheelZ]]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * spec.wheelX, spec.wheelRadius, z);
      const tire = new THREE.Mesh(buildSteerableWheelGeo(spec, side), wheelMat);
      pivot.add(tire);
      this.root.add(pivot);
      this.wheels.push({ pivot, tire, front: z > 0 });
    }
    const shadowGeo = new THREE.PlaneGeometry(2.4, 5.3).rotateX(-Math.PI * 0.5);
    const shadow = new THREE.Mesh(shadowGeo, createContactShadowMaterial());
    shadow.position.y = 0.02;
    shadow.renderOrder = 998;
    this.root.add(shadow);

    // Red & blue strobes over the light bar
    this.lights = [new THREE.PointLight(0xff1828, 0, 16, 1.25), new THREE.PointLight(0x1868ff, 0, 16, 1.25)];
    this.lights[0].position.set(0.4, 2.15, -0.5);
    this.lights[1].position.set(-0.4, 2.15, -0.5);
    this.root.add(...this.lights);
    scene.add(this.root);

    this.car = {
      position: new THREE.Vector3(), heading: 0, speed: 0, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, longAccel: 0,
      drift: { slipAngle: 0, rearSlide: 0, wheelspin: 0, steer: 0, loadFront: 0, loadRear: 0, lateralAccel: 0 }
    };
    this.pilot = new DriftAutopilot({ cruiseSpeed: 34, cornerSpeed: 12, lanes: 1, model: COP_DRIFT });
    this.driver = new KeyboardDriver(KEYBOARD_DRIVER, COP_DRIFT);
    this.holdBrake = 0;
    this.state = 'hidden'; // 'hidden' | 'parked' | 'chasing' | 'stopping'
    this.siren = new Siren(audioSystem);
    this.wheelSpin = 0;
    this._contact = {};
    this._a = {};
    this._b = {};
  }

  park(x, z, heading) {
    const c = this.car;
    c.position.set(x, 0, z);
    c.heading = heading;
    c.speed = c.vx = c.vz = c.angularVel = c.steerAngle = c.longAccel = 0;
    this.driver.reset();
    this.state = 'parked';
    this.retired = false;
    this.root.visible = true;
  }

  chase(route) {
    this.pilot.setPath([{ x: this.car.position.x, z: this.car.position.z }, ...route]);
    this.state = 'chasing';
  }

  giveUp() {
    if (this.state !== 'chasing') return;
    this.state = 'stopping';
    this.retired = true;
  }

  hide() {
    this.state = 'hidden';
    this.root.visible = false;
  }

  // Keep the M5 and the cruiser from passing through each other (a parked cruiser doesn't move)
  collide(player) {
    if (this.state === 'hidden') return;
    const a = this._a, b = this._b, c = this.car;
    const write = (body, e, halfW, halfL, mass) => {
      body.x = e.position.x; body.z = e.position.z;
      body.prevX = e.prevX ?? e.position.x; body.prevZ = e.prevZ ?? e.position.z;
      body.sin = Math.sin(e.heading); body.cos = Math.cos(e.heading);
      body.halfW = halfW; body.halfL = halfL; body.mass = mass;
      body.vx = body.sin * e.speed + e.vx; body.vz = body.cos * e.speed + e.vz;
      body.angularVel = e.angularVel;
    };
    write(a, player, 0.97, 2.52, M5_DRIFT.mass);
    write(b, c, 1.0, 2.4, this.state === 'parked' ? 0 : COP_DRIFT.mass);
    if (!vehicleContact(a, b, this._contact)) return;
    const hit = this._contact;
    resolveVehicleContact(a, b, hit);
    const share = b.mass === 0 ? 1 : b.mass / (a.mass + b.mass);
    player.position.x += hit.nx * hit.depth * share;
    player.position.z += hit.nz * hit.depth * share;
    c.position.x -= hit.nx * hit.depth * (1 - share);
    c.position.z -= hit.nz * hit.depth * (1 - share);
    for (const [e, body] of [[player, a], [c, b]]) {
      if (body.mass === 0) continue;
      e.speed = body.vx * body.sin + body.vz * body.cos;
      e.vx = body.vx - body.sin * e.speed;
      e.vz = body.vz - body.cos * e.speed;
      e.angularVel = body.angularVel;
    }
  }

  update(dt, elapsed, cameraPosition, obstacles, quarry) {
    if (this.state === 'hidden') {
      this.siren.update(false, 0, elapsed);
      return;
    }
    const c = this.car;
    c.prevX = c.position.x;
    c.prevZ = c.position.z;
    const distance = cameraPosition ? cameraPosition.distanceTo(c.position) : 0;
    if (this.state === 'chasing' || this.state === 'stopping') {
      // Chase, but never catch: hold back behind the car it chases, and give up if it ever gets past it
      let gap = Infinity;
      if (quarry && this.state === 'chasing') {
        const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
        gap = (quarry.position.x - c.position.x) * fx + (quarry.position.z - c.position.z) * fz;
        if (gap < -3) this.giveUp();
      }
      // The cop drives on the keys too, through its own hands: the autopilot's keys, with the brake pressed (for its
      // share of the frames) to hold back, or to stop (let go at a standstill, where S would reverse)
      const keys = this.pilot.drive(c, dt, obstacles, this.driver);
      let brake = 0;
      if (this.state === 'stopping') brake = 0.5;
      else if (gap < HOLD_BACK && c.speed > Math.abs(quarry.speed) - 2) brake = Math.min(1, (HOLD_BACK - gap) / HOLD_BACK + 0.2);
      if (brake > 0) {
        this.holdBrake += brake;
        keys.forward = 0;
        keys.backward = this.holdBrake >= 0.5 && c.speed > 0.6 ? 1 : 0;
        if (keys.backward) this.holdBrake -= 1;
      }
      const input = this.driver.update(c, this.pilot.hands.press(keys, dt), dt);
      const steps = Math.ceil(dt * SIM_STEPS_PER_SECOND);
      for (let i = 0; i < steps; i++) stepDriftCar(c, input, dt / steps, COP_DRIFT, c.drift);
      if (this.state === 'stopping' && Math.abs(c.speed) < 0.2) this.state = 'parked';
    } else if (this.state === 'parked' && this.retired && distance > 60) {
      // A cop that gave up leaves once nobody is looking
      this.hide();
      return;
    }
    this.root.position.copy(c.position);
    this.root.rotation.y = c.heading;
    const roll = (c.position.x - c.prevX) * Math.sin(c.heading) + (c.position.z - c.prevZ) * Math.cos(c.heading);
    this.wheelSpin = (this.wheelSpin + roll / this.spec.wheelRadius) % (Math.PI * 2);
    for (const w of this.wheels) {
      w.tire.rotation.x = this.wheelSpin;
      if (w.front) w.pivot.rotation.y = c.steerAngle;
    }
    // Alternate red and blue, as the light bar's lenses do
    const wave = Math.sin(elapsed * Math.PI * 6);
    this.lights[0].intensity = wave > 0 ? 60 * wave : 0;
    this.lights[1].intensity = wave < 0 ? -60 * wave : 0;
    this.root.updateMatrixWorld();
    this.siren.update(this.state === 'chasing', distance, elapsed);
  }
}

// The show itself: a timeline of phases, flown through the controllers' swimPilot hook
class SwimShow {
  constructor({ controllerManager, trafficSystem, cruiser, onPhase, onCamera }) {
    this.controllers = controllerManager;
    this.traffic = trafficSystem;
    this.cruiser = cruiser;
    this.onPhase = onPhase;
    this.onCamera = onCamera; // (preset id) the show cuts between the chase camera and the driver's seat
    // The avenues are four or five lanes wide: weave across all of them, faster and closer than a driver would
    this.pilot = new DriftAutopilot({ ...SHOW_SWIMMING, lanes: 2, laneWidth: 2.8 });
    // One pair of hands for everything the show presses: the swimming, the donuts, backing out (fly)
    this.hands = this.pilot.hands;
    this.phase = 'off';
    this.time = 0;
    this.total = 0;
    this.donut = null;
    this.obstacles = [];
  }

  get running() {
    return this.phase !== 'off';
  }

  // Called with the car already in Times Square (main.js teleports it to SHOW_SPOT first)
  start() {
    this.traffic.setClearZone({ x: COP_SPOT.x, z: COP_SPOT.z, r: SHOW_CLEAR_RADIUS });
    // The same traffic every time, so the escape threads the same cars
    this.traffic.reseed?.(SHOW_TRAFFIC_SEED, SHOW_SPOT.x, SHOW_SPOT.z);
    // The cruiser parks at the centre of the circle the car will drift round, side-on to the car coming down 7th Ave
    this.cruiser.park(COP_SPOT.x, COP_SPOT.z, COP_HEADING);
    this.takeWheel();
    this.roamer = null;
    this.donut = new DonutDriver(COP_SPOT, DRIFT_RADIUS, ENTRY_BEARING, {}, this.hands);
    this.onCamera?.('chase');
    this.setPhase('roll');
  }

  // The AI takes the wheel from wherever the car is and roams Midtown from there (the hand-back key, main.js): no
  // cop, no stunts, the next corner it comes to and on through the city. Returns whether it found a way on.
  roam(seed = Math.floor(Math.random() * 2 ** 31)) {
    const car = this.controllers.entities.swim;
    const roamer = new RoamRoute(seed).startFrom(car.position.x, car.position.z, car.heading);
    const route = [{ x: car.position.x, z: car.position.z }];
    for (let i = 0; i < ROUTE_AHEAD; i++) {
      const corner = roamer.next();
      if (!corner) break;
      route.push(corner);
    }
    if (route.length < 2) return false;
    this.takeWheel();
    this.roamer = roamer;
    this.donut = null;
    this.pilot.setPath(route, { corridors: routeCorridors(route) });
    this.setPhase('roam');
    return true;
  }

  // The AI's hands on the car: the swimPilot hook, a fresh keyboard driver and the automatic (a player in manual gets
  // their manual back when they take the wheel)
  takeWheel() {
    const c = this.controllers.entities.swim;
    this.controllers.swimPilot = (car, dt, keys, driver) => this.fly(car, dt, keys, driver);
    this.controllers.swimDriver?.reset();
    this.hands.reset();
    if (this.phase === 'off') this.playerManual = Boolean(c.manual);
    c.manual = false;
    this.traffic.releaseStaged?.();
    this.total = 0;
    this.clearedCorner = undefined;
    this.stuck = this.reversing = this.unstickTries = 0;
    this.exitAt = undefined;
    this.tookOver = false;
    this.inSeat = false;
  }

  // Keep the route a few corners ahead of the car: once the show's run is driven, the roam picks each next street
  extendRoute() {
    const path = this.pilot.path;
    if (path.length - 1 - this.pilot.segment > ROUTE_AHEAD) return;
    this.roamer ??= new RoamRoute(ROAM_SEED).continueFrom(path);
    const corner = this.roamer.next();
    if (!corner) return;
    const last = path[path.length - 1];
    path.push(corner);
    this.pilot.corridors?.push(...routeCorridors([last, corner]));
  }

  // The driver's look (cameras.js adds car.povYaw to the seat's view) and the bird (m5-cockpit.js reads car.showBird)
  glance(car, dt, yaw) {
    car.povYaw = (car.povYaw ?? 0) + (yaw - (car.povYaw ?? 0)) * (1 - Math.exp(-dt * GLANCE_RATE));
  }

  setPhase(phase) {
    this.phase = phase;
    this.time = 0;
    this.onPhase?.(phase);
  }

  // Hand the car to the player: clear the hooks and the stunt area
  stop() {
    if (this.phase === 'off') return;
    this.controllers.swimPilot = null;
    const car = this.controllers.entities.swim;
    car.cameraYawOverride = null;
    car.povYaw = 0;
    car.showBird = false;
    car.manual = this.playerManual ?? false;
    this.traffic.setClearZone(null);
    this.traffic.releaseStaged?.();
    this.cruiser.giveUp();
    this.setPhase('off');
  }

  // One frame of the show: called with the player's keys before the keyboard driver reads them; the AI presses its own
  // in their place, so it drives the car exactly as the player can. Whatever drives this frame (the donuts, the
  // swimmer, backing out) says which keys it wants; the show's one pair of hands presses them, as a player's can.
  fly(car, dt, keys, driver) {
    this.lastKeys = keys;
    // Any driving key takes the wheel (the key itself goes through to the car this frame)
    if (keys.forward || keys.backward || keys.left || keys.right || keys.handbrake) {
      this.tookOver = true;
      this.stop();
      return;
    }
    this.time += dt;
    this.total += dt;
    const wanted = this.wanted ??= { forward: 0, backward: 0, left: 0, right: 0, handbrake: 0 };
    for (const key in wanted) wanted[key] = 0;
    this.drive(car, dt, wanted, driver);
    if (this.phase !== 'off') Object.assign(keys, this.hands.press(wanted, dt));
  }

  // The keys the show wants this frame, by phase (fly)
  drive(car, dt, keys, driver) {
    // Show cameras look across the car toward the cruiser, so the cop is in the shot
    const cop = this.cruiser.car.position;
    const towardCop = Math.atan2(cop.x - car.position.x, cop.z - car.position.z);
    switch (this.phase) {
      case 'roll':
      case 'donuts': {
        this.donut.update(car, dt, driver, keys);
        if (this.phase === 'roll') {
          car.cameraYawOverride = towardCop + CHASE_ACROSS;
          if (this.donut.phase !== 'roll') this.setPhase('donuts');
          return;
        }
        const exiting = this.donut.phase === 'powerOut';
        const laps = this.donut.laps;
        // The first lap from outside, looking across the car at the cop in the middle of the circle; then into the
        // driver's seat, watching the cop over the drift (until the way out), the bird out of the window mid-lap
        if (laps < POV_FROM_LAP) {
          car.cameraYawOverride = towardCop + CHASE_ACROSS;
        } else if (!this.inSeat) {
          this.inSeat = true;
          car.cameraYawOverride = null;
          car.povYaw = 0;
          this.onCamera?.('pov');
        }
        const copBearing = Math.atan2(Math.sin(towardCop - car.heading), Math.cos(towardCop - car.heading));
        const watching = exiting ? 0 : Math.max(-COP_GLANCE_LIMIT, Math.min(COP_GLANCE_LIMIT, copBearing));
        this.glance(car, dt, watching);
        car.showBird = !exiting && laps > BIRD_FROM_LAP && laps < BIRD_TO_LAP;
        // Once it has done its laps and the way down the avenue comes round, power out onto it
        const aimZ = Math.max(car.position.z + EXIT_LOOKAHEAD, COP_SPOT.z + ESCAPE_MERGE);
        const exit = Math.atan2(COP_SPOT.x - car.position.x, aimZ - car.position.z);
        const travel = travelHeading(car);
        const ahead = Math.atan2(Math.sin(exit - travel), Math.cos(exit - travel)); // + to the left, the way it turns
        const done = laps > DONUT_LAPS - EXIT_WINDOW / (2 * Math.PI) || this.time > DONUT_TIME_LIMIT;
        if (!exiting && this.donut.phase === 'drift' && done && ahead > 0 && ahead < EXIT_WINDOW) {
          this.exitAt = this.time;
          this.donut.powerOut();
        }
        const lateral = car.vx * Math.cos(car.heading) - car.vz * Math.sin(car.heading);
        const gripping = Math.abs(Math.atan2(lateral, Math.max(1, Math.abs(car.speed)))) < EXIT_SLIP;
        if (exiting && ((gripping && Math.abs(ahead) < EXIT_ALIGN) || this.time - this.exitAt > EXIT_TIME_LIMIT)) {
          // The swim autopilot takes the car on from the slide's end
          this.exitAt = undefined;
          this.traffic.setClearZone(null);
          // Off the circle (which reaches over the curb) straight back onto the avenue, then the run
          const merge = { x: ESCAPE_ROUTE[0].x, z: ESCAPE_ROUTE[0].z + ESCAPE_MERGE };
          const escape = [{ x: car.position.x, z: car.position.z }, merge, ...ESCAPE_ROUTE.slice(1)];
          this.pilot.setPath(escape, { corridors: routeCorridors(escape) });
          this.cruiser.chase(ESCAPE_ROUTE.slice(1));
          this.setPhase('escape');
        }
        return;
      }
      case 'escape':
      case 'swim':
      case 'roam': {
        // The getaway is still the driver's view; the swimming cuts out to the chase camera, which opens looking back
        // over the car at the traffic it just came through. A hand-back leaves the camera to the player.
        this.glance(car, dt, 0);
        if (this.phase !== 'roam') {
          car.cameraYawOverride = this.phase === 'swim' && this.time < LOOK_BACK_TIME ? car.heading + Math.PI : null;
        }
        this.extendRoute();
        this.clearNextCorner(car);
        Object.assign(keys, this.pilot.drive(car, dt, this.obstacles, driver));
        this.unstick(car, dt, keys);
        // Off the end of the streets the roam knows: start over from wherever the car is (or give the car back)
        if (this.pilot.finished && !this.roam()) {
          this.stop();
          return;
        }
        if (this.phase === 'escape' && this.time > CHASE_TIME) {
          this.cruiser.giveUp();
          this.onCamera?.('chase');
          this.setPhase('swim');
        }
        return;
      }
      default:
        return;
    }
  }

  // Each drift corner is held clear as the car comes up to it (an intersection closed for the show), and released once
  // the car is round it
  clearNextCorner(car) {
    const path = this.pilot.path;
    const index = this.pilot.segment + 1;
    const corner = index < path.length - 1 ? path[index] : null;
    const near = corner && Math.hypot(corner.x - car.position.x, corner.z - car.position.z) < CORNER_CLEAR_DISTANCE;
    if (near && this.clearedCorner !== index) {
      this.clearedCorner = index;
      this.traffic.setClearZone({ x: corner.x, z: corner.z, r: CORNER_CLEAR_RADIUS });
      // ...and the street past it is laid out for swimming: pairs of cars side by side to split, staged as the car
      // comes up to the corner (round it, out of sight; down 7th Ave, as it powers out of the drift)
      const before = path[index - 1], after = path[index + 1], beyond = path[index + 2];
      const drifted = this.isDrifted(before, corner, after);
      // (and short of a drifted corner at its far end by the AI's line-up for it: a pair there would sit in its braking,
      // held up at the corner, where it can't be split at speed)
      const options = { startGap: drifted ? STAGE_GAP_AFTER_DRIFT : STAGE_GAP };
      if (beyond && this.isDrifted(corner, after, beyond)) options.endGap = this.pilot.options.lineUpDistance;
      this.traffic.stageRoute?.(corner, after, options);
    } else if (!near && this.clearedCorner !== undefined && this.clearedCorner !== index) {
      const last = path[this.clearedCorner];
      if (Math.hypot(last.x - car.position.x, last.z - car.position.z) > CORNER_CLEAR_RADIUS + 20) {
        this.clearedCorner = undefined;
        this.traffic.setClearZone(null);
      }
    }
  }

  // Whether the route's turn at b (from a, on to c) is sharp enough for the AI to drift it
  isDrifted(a, b, c) {
    const turn = wrapAngle(Math.atan2(c.x - b.x, c.z - b.z) - Math.atan2(b.x - a.x, b.z - a.z));
    return Math.abs(turn) > this.pilot.options.sharpTurn;
  }

  // Pinned against a bus or a wall, or boxed in by traffic that is waiting for it: back out for a moment, steering
  // the other way, and try again: S held at a standstill reverses, with the wheel set to swing the nose toward the route
  // ahead (backing up turns the car the opposite way to the wheel), longer each time it is still stuck. The show never
  // means to stand still, but in a queue (a red light's, across every lane: the AI's planner tells) it waits its turn,
  // unless that queue is short of the corner the show holds clear: those cars are waiting for it to go round first.
  unstick(car, dt, keys) {
    if (this.reversing > 0) {
      this.reversing -= dt;
      const aim = this.pilot.pointAhead(car, UNSTICK_AIM);
      const error = wrapAngle(Math.atan2(aim.x - car.position.x, aim.z - car.position.z) - car.heading);
      const steer = Math.abs(error) > UNSTICK_ALIGNED ? -Math.sign(error) : 0;
      Object.assign(keys, { forward: 0, backward: 1, left: steer > 0 ? 1 : 0, right: steer < 0 ? 1 : 0, handbrake: 0 });
      return;
    }
    if (car.speed > UNSTUCK_SPEED) this.unstickTries = 0;
    const held = this.clearedCorner !== undefined ? this.pilot.path[this.clearedCorner] : null;
    const heldQueue = held && Math.hypot(held.x - car.position.x, held.z - car.position.z) < CORNER_CLEAR_RADIUS + HELD_QUEUE_REACH;
    // (and never longer than a red light lasts: a queue still standing after that is waiting for something else)
    this.queuedTime = this.pilot.queued && Math.abs(car.speed) < 1 ? (this.queuedTime || 0) + dt : 0;
    const waiting = this.pilot.queued && !heldQueue && this.queuedTime < QUEUE_PATIENCE;
    this.stuck = Math.abs(car.speed) < 1 && !waiting ? (this.stuck || 0) + dt : 0;
    if (this.stuck > STUCK_TIME) {
      this.stuck = 0;
      this.unstickTries = (this.unstickTries || 0) + 1;
      this.reversing = REVERSE_TIME * Math.min(MAX_REVERSE_TRIES, this.unstickTries);
    }
  }

  // Traffic the AI weaves through: the cars and buses near the swimming car
  gatherObstacles(car, ...groups) {
    const list = this.obstacles;
    list.length = 0;
    for (const vehicles of groups) {
      for (const v of vehicles) {
        if (!v.edge) continue;
        if (Math.abs(v.x - car.position.x) < GATHER_RANGE && Math.abs(v.z - car.position.z) < GATHER_RANGE) list.push(v);
      }
    }
    return list;
  }
}

export {
  COP_SPOT, DONUT, DONUT_LAPS, DRIFT_RADIUS, DonutDriver, ESCAPE_ROUTE, PoliceCruiser, SHOW_SIGNAL_TIME, SHOW_SPOT, SwimShow,
  routeCorridors
};
