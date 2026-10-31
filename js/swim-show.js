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
import { DriftAutopilot, steeringKey, travelHeading } from './drift-autopilot.js';
import { resolveVehicleContact, vehicleContact } from './vehicle-physics.js';

// The swimming show: the AI takes the car through the reference clips' greatest hits, then hands it over. Times Square
// is cleared of traffic, an NYPD cruiser watches with its lights on, the car does a burnout and donuts round it, runs
// from the cop down 7th Ave and swims through traffic up 8th Ave, and then it's the player's car.

const RAD = Math.PI / 180;

// The cruiser parks in the middle of 7th Ave & 45th St, at the foot of the bowtie, and the car starts on the circle it
// drifts round it: in the crossing's east arm, facing north with the cop off its left side
const COP_SPOT = { x: avenueX('7') - 2, z: streetZ(45) };
const DRIFT_RADIUS = 11; // m from the cop to the car: the circle fills the crossing, the way the clip's does, and
// clears the Con Ed steam stack 6 m from the cop by two
const SHOW_SPOT = { x: COP_SPOT.x + DRIFT_RADIUS, z: COP_SPOT.z, heading: Math.PI };
const SHOW_TRAFFIC_SEED = 1; // traffic layout of the opening (traffic.js reseed)
// Where in the 60 s signal cycle (city-config.js SIGNAL_TIMING) the show starts: the avenues turn green as the car
// leaves the drift circle, so the run down 7th Ave meets the same lights every time
const SHOW_SIGNAL_TIME = 45;
const SHOW_CLEAR_RADIUS = 42; // m of Times Square kept clear of traffic for the stunts
// The run: down 7th Ave, west on 42nd St, up 8th Ave past Smith's, west on 57th St. The avenues are one-way, so the
// line runs down their middle; 42nd and 57th are two-way, so it keeps to the westbound (north, -z) half.
const WESTBOUND = -3.5;
// The drift into 42nd St turns at this offset instead: its slide swings about 2 m wide, which from the westbound line
// would end nose to nose with the eastbound queue (where the show once stalled for good)
const INTO_42ND = -5.5;
const ESCAPE_ROUTE = [
  [COP_SPOT.x, COP_SPOT.z],
  [avenueX('7'), streetZ(42) + INTO_42ND],
  [avenueX('8'), streetZ(42) + WESTBOUND],
  [avenueX('8'), streetZ(57) + WESTBOUND],
  [avenueX('11'), streetZ(57) + WESTBOUND]
].map(([x, z]) => ({ x, z }));

const BURNOUT_TIME = 2.6;
const DONUT_TIME = 9.5; // s of drifting round the cop (a lap takes about six) before looking for the way out
// The donuts are seen from the driver's seat, as the BMW short is filmed: the driver looks across at the cop and puts
// the bird out of the window (where the short has it against the chorus), the last thing before driving off
const BIRD_FROM = 6;
const BIRD_TO = 9.5;
const COP_GLANCE_LIMIT = 70 * RAD; // how far round from the windshield the driver turns to watch the cop
const GLANCE_RATE = 2.5; // 1/s easing of the driver's look
const EXIT_WINDOW = 25 * RAD; // the way out this far ahead of the direction of travel: let go of A and power out (later
// in the lap, the slide comes out already pointing down the avenue and the car can floor it)
const EXIT_TIME_LIMIT = 3; // s of powering out before the autopilot takes over however straight the car is
const EXIT_SLIP = 10 * RAD; // the slide is over below this drift angle,
const EXIT_ALIGN = 60 * RAD; // and with the car travelling roughly the way out, the autopilot steers it back onto the avenue
const ESCAPE_MERGE = 40; // m down 7th Ave from the cop where the escape is back in the avenue's middle: a long merge,
// so the swing back from the plaza is a gentle one taken flat out
const EXIT_LOOKAHEAD = 30; // m down the avenue's middle line ahead of the car that it powers out of the circle toward
const CHASE_TIME = 14; // s the cop keeps up the chase before it gives up
// The hand-over, like the opening of a racing game: a few seconds into the swim, at speed, a 3-2-1 count and the car
// is the player's
const SWIM_TIME = 6; // s of swimming before it looks for a moment to hand over
// m/s (65 mph) the count starts at and holds through, so the player takes a car that is flying: the count waits for
// the planner to see clear road at that speed for the whole count, and during it the AI prefers plans that keep it
const HANDOVER_SPEED = 29;
const COUNTDOWN_TIME = 3; // s of "3, 2, 1"
const SHOW_TIME_LIMIT = 60; // s before the count starts wherever the car is (a fallback: the show has to end)
const LOOK_BACK_TIME = 2.5; // s the swim's chase camera opens looking back at the cop giving up
const STUCK_TIME = 2; // s standing still before the AI backs out
const HOLD_BACK = 15; // m the cop keeps behind the car it chases
const CORNER_CLEAR_DISTANCE = 110; // m out from a drift corner that the show starts holding its traffic
const CORNER_CLEAR_RADIUS = 26;
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
// commits to a split (planSpread: at that speed a row comes up every second or two)
const SHOW_SWIMMING = {
  cruiseSpeed: 40,
  planSpread: 0.2,
  lateBonus: 20,
  passMargin: 0.2,
  closeBonus: 60,
  splitBonus: 100
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

// The donuts round the cop, on the keys as a player holds them: out of the burnout it drives onto the circle in grip,
// at speed flicks the handbrake with the lock on, then holds the slide on W with A for the angle, tapping the handbrake
// when it runs wide and fast. The keyboard driver's own drift throttle holds about 35° with A held, at ~10 m/s.
const DONUT = {
  aheadArc: 0.7, // rad along the circle ahead that it aims at while it drives onto it
  steerGain: 5, // share of lock per radian of aim error while driving onto the circle
  burnoutLock: 0.3, // share of lock wound on during the burnout
  kickSpeed: 11, // m/s at which it flicks into the slide
  kickTime: 0.25, // s of handbrake
  angle: 45 * RAD, // A held while the drift angle is below this (the driver's throttle settles it nearer 35°),
  anglePerMetre: 2 * RAD, // more when it is outside the circle
  liftAngle: 50 * RAD, // W lifted past this angle
  speed: 10.5, // m/s: past this, and outside the circle, it taps the handbrake
  radialLead: 1.2, // s ahead the distance from the cop is read from how fast it is changing
  exitAngle: 25 * RAD // powering out, flat out and counter-steering until the slide is down to this
};

class DonutDriver {
  constructor(center, radius, options = {}) {
    this.o = { ...DONUT, ...options };
    this.center = center;
    this.radius = radius;
    this.phase = 'launch'; // 'launch' | 'kick' | 'drift' | 'powerOut'
    this.kick = 0;
  }

  // Let go of A and power out flat out, counter-steering the slide down, as a player drives out of a drift
  powerOut() {
    this.phase = 'powerOut';
  }

  // One frame of keys orbiting the centre to the left (the bearing from the centre grows)
  update(car, dt, driver, keys) {
    const o = this.o;
    const dx = car.position.x - this.center.x, dz = car.position.z - this.center.z;
    const distance = Math.hypot(dx, dz);
    const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
    const vx = sin * car.speed + car.vx, vz = cos * car.speed + car.vz;
    const ground = Math.hypot(vx, vz);
    const lateral = car.vx * cos - car.vz * sin;
    const angle = ground > 2 ? -Math.atan2(lateral, Math.abs(car.speed)) : 0; // a left drift's angle, + nose in
    const outward = distance - this.radius + o.radialLead * (vx * dx + vz * dz) / Math.max(1, distance);
    keys.forward = 1;
    keys.backward = 0;
    keys.handbrake = 0;
    let want = 0;
    if (this.phase === 'launch') {
      const bearing = Math.atan2(dx, dz) + o.aheadArc;
      const aimX = this.center.x + Math.sin(bearing) * this.radius, aimZ = this.center.z + Math.cos(bearing) * this.radius;
      const error = wrapAngle(Math.atan2(aimX - car.position.x, aimZ - car.position.z) - travelHeading(car));
      want = Math.max(-1, Math.min(1, error * o.steerGain));
      if (ground > o.kickSpeed) {
        this.phase = 'kick';
        this.kick = o.kickTime;
      }
    } else if (this.phase === 'kick') {
      want = 1;
      keys.forward = 0;
      keys.handbrake = 1;
      this.kick -= dt;
      if (this.kick <= 0) this.phase = 'drift';
    } else if (this.phase === 'drift') {
      want = angle < o.angle + o.anglePerMetre * outward ? 1 : 0;
      if (angle > o.liftAngle) keys.forward = 0;
      if (ground > o.speed && outward > 0) keys.handbrake = 1;
    } else if (this.phase === 'powerOut') {
      want = angle > o.exitAngle ? -1 : 0;
    }
    const key = steeringKey(driver, want, car.speed, dt);
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
      // The cop drives on the keys too: the autopilot's keys, with the brake pressed (for its share of the frames) to
      // hold back, or to stop (let go at a standstill, where S would reverse)
      const keys = this.pilot.update(c, dt, obstacles, this.driver);
      let brake = 0;
      if (this.state === 'stopping') brake = 0.5;
      else if (gap < HOLD_BACK && c.speed > Math.abs(quarry.speed) - 2) brake = Math.min(1, (HOLD_BACK - gap) / HOLD_BACK + 0.2);
      if (brake > 0) {
        this.holdBrake += brake;
        keys.forward = 0;
        keys.backward = this.holdBrake >= 0.5 && c.speed > 0.6 ? 1 : 0;
        if (keys.backward) this.holdBrake -= 1;
      }
      const input = this.driver.update(c, keys, dt);
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
    const c = this.controllers.entities.swim;
    this.traffic.setClearZone({ x: SHOW_SPOT.x, z: SHOW_SPOT.z, r: SHOW_CLEAR_RADIUS });
    // The same traffic every time, so the escape threads the same cars
    this.traffic.reseed?.(SHOW_TRAFFIC_SEED, SHOW_SPOT.x, SHOW_SPOT.z);
    // The cruiser parks off the car's left side, side-on to it, at the centre of the circle the car will drift round
    const side = DRIFT_RADIUS;
    this.cruiser.park(c.position.x + Math.cos(c.heading) * side, c.position.z - Math.sin(c.heading) * side, c.heading + Math.PI * 0.5);
    this.controllers.swimPilot = (car, dt, keys, driver) => this.fly(car, dt, keys, driver);
    this.controllers.swimDriver?.reset();
    // The AI drives the automatic; a player in manual gets their manual back at the hand-over
    this.playerManual = Boolean(c.manual);
    c.manual = false;
    this.traffic.releaseStaged?.();
    this.total = 0;
    this.clearedCorner = undefined;
    this.stuck = this.reversing = this.unstickTries = 0;
    this.exitAt = undefined;
    this.onCamera?.('chase');
    this.setPhase('burnout');
  }

  // "3, 2, 1": the AI keeps swimming through the count, then the car is the player's
  countDown() {
    if (this.phase === 'countdown') return;
    this.pilot.keepSpeed = HANDOVER_SPEED;
    this.setPhase('countdown');
  }

  // Whole seconds left on the hand-over count (3, 2, 1), or 0 when not counting
  get count() {
    return this.phase === 'countdown' ? Math.max(1, Math.ceil(COUNTDOWN_TIME - this.time)) : 0;
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
    this.pilot.keepSpeed = 0;
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
  // in their place, so it drives the car exactly as the player can
  fly(car, dt, keys, driver) {
    // Any driving key takes over
    if (keys.forward || keys.backward || keys.left || keys.right || keys.handbrake) {
      this.stop();
      return;
    }
    this.time += dt;
    this.total += dt;
    if (this.total > SHOW_TIME_LIMIT && (this.phase === 'escape' || this.phase === 'swim')) this.countDown();
    // Show cameras look across the car toward the cruiser, so the cop is in the shot
    const cop = this.cruiser.car.position;
    const towardCop = Math.atan2(cop.x - car.position.x, cop.z - car.position.z);
    switch (this.phase) {
      case 'burnout': {
        // W and S together at a standstill, the lock wound on for the launch into the donuts
        car.cameraYawOverride = towardCop + 0.45;
        keys.forward = keys.backward = 1;
        const key = steeringKey(driver, DONUT.burnoutLock, car.speed, dt);
        keys.left = key > 0 ? 1 : 0;
        keys.right = key < 0 ? 1 : 0;
        if (this.time > BURNOUT_TIME) {
          this.donut = new DonutDriver({ x: cop.x, z: cop.z }, DRIFT_RADIUS);
          // Into the driver's seat for the drift, looking across at the cop
          car.cameraYawOverride = null;
          car.povYaw = 0;
          this.onCamera?.('pov');
          this.setPhase('donuts');
        }
        return;
      }
      case 'donuts': {
        this.donut.update(car, dt, driver, keys);
        const exiting = this.donut.phase === 'powerOut';
        // The driver watches the cop over the drift (until the way out), and gives them the bird mid-circle
        const copBearing = Math.atan2(Math.sin(towardCop - car.heading), Math.cos(towardCop - car.heading));
        const watching = exiting ? 0 : Math.max(-COP_GLANCE_LIMIT, Math.min(COP_GLANCE_LIMIT, copBearing));
        this.glance(car, dt, watching);
        car.showBird = this.time > BIRD_FROM && this.time < BIRD_TO;
        // Once it has done its laps and the way down the avenue comes round, let go of A and power out onto it
        const aimZ = Math.max(car.position.z + EXIT_LOOKAHEAD, COP_SPOT.z + ESCAPE_MERGE);
        const exit = Math.atan2(COP_SPOT.x - car.position.x, aimZ - car.position.z);
        const travel = travelHeading(car);
        const ahead = Math.atan2(Math.sin(exit - travel), Math.cos(exit - travel)); // + to the left, the way it turns
        if (!exiting && this.donut.phase === 'drift' && this.time > DONUT_TIME && ahead > 0 && ahead < EXIT_WINDOW) {
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
      case 'countdown': {
        // The getaway is still the driver's view; the swimming cuts out to the chase camera, which opens looking back
        // over the car at the traffic it just came through
        this.glance(car, dt, 0);
        car.cameraYawOverride = this.phase === 'swim' && this.time < LOOK_BACK_TIME ? car.heading + Math.PI : null;
        this.clearNextCorner(car);
        Object.assign(keys, this.pilot.update(car, dt, this.obstacles, driver));
        this.unstick(car, dt, keys);
        if (this.phase === 'countdown' && this.time > COUNTDOWN_TIME) {
          this.stop();
          return;
        }
        if (this.phase === 'swim' && this.time > SWIM_TIME && this.pilot.holdsSpeed(car, HANDOVER_SPEED, COUNTDOWN_TIME)) {
          this.countDown();
        }
        if (this.phase === 'escape' && this.time > CHASE_TIME) {
          this.cruiser.giveUp();
          this.onCamera?.('chase');
          this.setPhase('swim');
        }
        if (this.pilot.finished) this.countDown();
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
  // means to stand still.
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
    this.stuck = Math.abs(car.speed) < 1 ? (this.stuck || 0) + dt : 0;
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

export { SHOW_SPOT, SHOW_SIGNAL_TIME, ESCAPE_ROUTE, PoliceCruiser, SwimShow, routeCorridors };
