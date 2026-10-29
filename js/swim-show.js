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
import { M5_DRIFT, stepDriftCar } from './drift-physics.js';
import { DriftAutopilot, DriftCircle } from './drift-autopilot.js';
import { resolveVehicleContact, vehicleContact } from './vehicle-physics.js';

// The swimming show: the AI takes the car through the reference clips' greatest hits, then hands it over. Times Square
// is cleared of traffic, an NYPD cruiser watches with its lights on, the car does a burnout and donuts round it, runs
// from the cop down 7th Ave and swims through traffic up 8th Ave, and then it's the player's car.

const RAD = Math.PI / 180;

// The cruiser parks in the middle of 7th Ave & 45th St, at the foot of the bowtie, and the car starts on the circle it
// drifts round it: in the crossing's east arm, facing north with the cop off its left side
const COP_SPOT = { x: avenueX('7') - 2, z: streetZ(45) };
const DRIFT_RADIUS = 10; // m from the cop to the car: the circle fills the crossing, the way the clip's does
const SHOW_SPOT = { x: COP_SPOT.x + DRIFT_RADIUS, z: COP_SPOT.z, heading: Math.PI };
const SHOW_TRAFFIC_SEED = 1; // traffic layout of the opening (traffic.js reseed)
const SHOW_CLEAR_RADIUS = 42; // m of Times Square kept clear of traffic for the stunts
// The run: down 7th Ave, west on 42nd St, up 8th Ave past Smith's, west on 57th St. The avenues are one-way, so the
// line runs down their middle; 42nd and 57th are two-way, so it keeps to the westbound (north, -z) half.
const WESTBOUND = -3.5;
const ESCAPE_ROUTE = [
  [COP_SPOT.x, COP_SPOT.z],
  [avenueX('7'), streetZ(42) + WESTBOUND],
  [avenueX('8'), streetZ(42) + WESTBOUND],
  [avenueX('8'), streetZ(57) + WESTBOUND],
  [avenueX('11'), streetZ(57) + WESTBOUND]
].map(([x, z]) => ({ x, z }));

const BURNOUT_TIME = 2.6;
const DONUT_TIME = 11; // s of drifting round the cop (a lap takes about six) before looking for the way out
const EXIT_TIME = 0.7; // s straightening out of the circle before the escape
const CHASE_TIME = 24; // s the cop keeps up the chase before it gives up
const SHOW_TIME_LIMIT = 75; // s before the car is handed over wherever it is
const CORRIDOR = 7; // m off the route before the show eases the car back toward it
const LOOK_BACK_TIME = 2.5; // s the escape camera looks back at the cop
const STUCK_TIME = 2; // s standing still before the AI backs out
const HOLD_BACK = 15; // m the cop keeps behind the car it chases
const CORNER_CLEAR_DISTANCE = 110; // m out from a drift corner that the show starts holding its traffic
const CORNER_CLEAR_RADIUS = 26;
const REVERSE_TIME = 1.1;

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

// A police SUV: drift physics with less power than the M5, so it can chase but not catch
const COP_DRIFT = { ...M5_DRIFT, mass: 2250, yawInertia: 4300, power: 420000, launchGrip: 1.6, topSpeed: 46 };
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
    this.pilot = new DriftAutopilot({ cruiseSpeed: 34, cornerSpeed: 12, lanes: 1 });
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
      const steps = Math.ceil(dt * 120);
      const step = dt / steps;
      for (let i = 0; i < steps; i++) {
        const input = this.pilot.update(c, step, obstacles);
        if (this.state === 'stopping') {
          input.throttle = 0;
          input.brake = 0.5;
        } else if (gap < HOLD_BACK && c.speed > Math.abs(quarry.speed) - 2) {
          input.throttle = 0;
          input.brake = Math.min(1, (HOLD_BACK - gap) / HOLD_BACK + 0.2);
        }
        stepDriftCar(c, input, step, COP_DRIFT, c.drift);
      }
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
  constructor({ controllerManager, trafficSystem, cruiser, onPhase }) {
    this.controllers = controllerManager;
    this.traffic = trafficSystem;
    this.cruiser = cruiser;
    this.onPhase = onPhase;
    // The avenues are four or five lanes wide: weave across all of them
    this.pilot = new DriftAutopilot({ lanes: 2, laneWidth: 2.8 });
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
    this.controllers.swimPilot = (car, dt, input) => this.fly(car, dt, input);
    this.total = 0;
    this.clearedCorner = undefined;
    this.stuck = this.reversing = 0;
    this.setPhase('burnout');
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
    this.controllers.entities.swim.cameraYawOverride = null;
    this.traffic.setClearZone(null);
    this.cruiser.giveUp();
    this.setPhase('off');
  }

  fly(car, dt, input) {
    // Any pedal or the wheel takes over
    if (input.throttle || input.brake || input.reverse || input.steer || input.handbrake) {
      this.stop();
      return undefined;
    }
    this.time += dt;
    this.total += dt;
    if (this.total > SHOW_TIME_LIMIT) {
      this.stop();
      return undefined;
    }
    // Show cameras look across the car toward the cruiser, so the cop is in the shot
    const cop = this.cruiser.car.position;
    const towardCop = Math.atan2(cop.x - car.position.x, cop.z - car.position.z);
    switch (this.phase) {
      case 'burnout':
        car.cameraYawOverride = towardCop + 0.45;
        input.throttle = 1;
        input.burnout = 1;
        if (this.time > BURNOUT_TIME) {
          this.donut = DriftCircle.around(car, this.cruiser.car.position, { direction: 1, radius: DRIFT_RADIUS });
          this.setPhase('donuts');
        }
        return undefined;
      case 'donuts': {
        // The camera sways slowly round the cop's side while the car slides round it
        car.cameraYawOverride = towardCop + 0.6 * Math.sin(this.time * 0.45);
        this.donut.update(car, dt, car.drift);
        // Straighten out once it has done its laps and its line points down the avenue, then run
        const exit = Math.atan2(ESCAPE_ROUTE[1].x - car.position.x, ESCAPE_ROUTE[1].z - car.position.z);
        const facing = Math.abs(Math.atan2(Math.sin(this.donut.travel - exit), Math.cos(this.donut.travel - exit)));
        if (!this.donut.exiting && this.time > DONUT_TIME && facing < 20 * RAD) {
          this.donut.exiting = true;
          this.exitAt = this.time;
        }
        if (this.donut.exiting && this.time - this.exitAt > EXIT_TIME) {
          // The physics takes the car on at the speed and angle the circle left it with
          this.traffic.setClearZone(null);
          const escape = [{ x: car.position.x, z: car.position.z }, ...ESCAPE_ROUTE.slice(1)];
          this.pilot.setPath(escape, { corridors: routeCorridors(escape) });
          this.cruiser.chase(ESCAPE_ROUTE.slice(1));
          this.setPhase('escape');
        }
        return 'scripted';
      }
      case 'escape':
      case 'swim': {
        // The getaway opens looking back over the car at the cop setting off after it
        car.cameraYawOverride = this.phase === 'escape' && this.time < LOOK_BACK_TIME ? car.heading + Math.PI : null;
        this.clearNextCorner(car);
        Object.assign(input, this.pilot.update(car, dt, this.obstacles));
        this.unstick(car, dt, input);
        this.keepNearRoute(car, dt);
        if (this.phase === 'escape' && this.time > CHASE_TIME) {
          this.cruiser.giveUp();
          this.setPhase('swim');
        }
        if (this.pilot.finished) this.stop();
        return undefined;
      }
      default:
        return undefined;
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
    } else if (!near && this.clearedCorner !== undefined && this.clearedCorner !== index) {
      const last = path[this.clearedCorner];
      if (Math.hypot(last.x - car.position.x, last.z - car.position.z) > CORNER_CLEAR_RADIUS + 20) {
        this.clearedCorner = undefined;
        this.traffic.setClearZone(null);
      }
    }
  }

  // Pinned against a bus or a wall, or boxed in by traffic that is waiting for it: back out for a moment, steering
  // the other way, and try another lane. The show never means to stand still.
  unstick(car, dt, input) {
    if (this.reversing > 0) {
      this.reversing -= dt;
      Object.assign(input, { throttle: 0, brake: 0, reverse: 1, steer: -this.stuckSteer, handbrake: 0, burnout: 0 });
      return;
    }
    this.stuck = Math.abs(car.speed) < 1 ? (this.stuck || 0) + dt : 0;
    if (this.stuck > STUCK_TIME) {
      this.stuck = 0;
      this.reversing = REVERSE_TIME;
      this.stuckSteer = input.steer || 1;
      this.pilot.targetOffset = -this.pilot.targetOffset || this.pilot.options.laneWidth;
    }
  }

  // The stunt driving cheats a little: a car sliding well off the street line is eased back toward it
  keepNearRoute(car, dt) {
    const s = this.pilot.seg(this.pilot.segment);
    const along = Math.max(0, Math.min(s.length, (car.position.x - s.a.x) * s.ux + (car.position.z - s.a.z) * s.uz));
    const px = s.a.x + s.ux * along, pz = s.a.z + s.uz * along;
    const dx = car.position.x - px, dz = car.position.z - pz;
    const off = Math.hypot(dx, dz);
    if (off <= CORRIDOR) return;
    const pull = Math.min(off - CORRIDOR, 3 * dt) / off;
    car.position.x -= dx * pull;
    car.position.z -= dz * pull;
  }

  // Traffic the AI weaves through: the cars and buses near the swimming car
  gatherObstacles(car, ...groups) {
    const list = this.obstacles;
    list.length = 0;
    for (const vehicles of groups) {
      for (const v of vehicles) {
        if (!v.edge) continue;
        if (Math.abs(v.x - car.position.x) < 90 && Math.abs(v.z - car.position.z) < 90) list.push(v);
      }
    }
    return list;
  }
}

export { SHOW_SPOT, ESCAPE_ROUTE, PoliceCruiser, SwimShow };
