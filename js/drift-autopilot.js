import { M5_DRIFT } from './drift-physics.js';

// The AI driver for swimming: it presses the same pedals and wheel a player does (input for stepDriftCar) to follow
// a route along the streets as fast as the corners allow, handbrake-flicks into a drift at every sharp corner, and
// weaves between the traffic ahead by moving across lanes. Pure and DOM-free, so it can be driven in tests.

const RAD = Math.PI / 180;
const GRAVITY = 9.81;
const LEAD_STEPS = 4; // steps the steering's look at the move ahead is flown in

const AUTOPILOT = {
  cruiseSpeed: 38, // m/s on the straights (85 mph)
  cornerSpeed: 13, // m/s into a drifted 90° corner
  braking: 7.5, // m/s² it plans to brake at before a corner
  sharpTurn: 40 * RAD, // corners sharper than this are drifted
  kickTime: 0.32, // s of handbrake to break the rear loose
  driftThrottle: 0.32, // share of the engine's power that holds a slide (it has a lot)
  driftAngle: 30 * RAD, // body slip it holds through a corner
  exitAlign: 12 * RAD, // travelling this close to the new street's direction ends the corner
  tractionSlip: 5 * RAD, // slip it allows on the straights before easing off the gas
  tractionThrottle: 0.011, // throttle per m/s that the rear tires can take without spinning (~80% of their grip)
  offLine: 10 * RAD, // heading error beyond which it slows down to get back onto the route
  lookahead: 6, // m, plus lookaheadTime × speed
  lookaheadTime: 0.38,
  steerGain: 1.5, // wheel angle per radian of heading error
  laneWidth: 3.3, // m: without a street corridor, it may use `lanes` of these either side of the route line
  lanes: 1,
  scanAhead: 120, // m of traffic it plans through: at 85 mph, its look-ahead plus the room to brake to a queue
  carHalfWidth: 0.97, // m: the car's own half width and half length
  carHalfLength: 2.5,
  passMargin: 0.35, // m of air it leaves between itself and a car it passes (a swimmer's margin, not a driver's)
  followMargin: 1.5, // m it leaves to a bumper it closes on
  gapStep: 0.75, // m between the lateral positions it tries
  pedals: [-9.5, -6, -3, 0, 3.5, 7], // m/s² it tries for pedalTime: stamp on it, brake, ease off, hold, push, floor it
  pedalTime: 1, // s on the pedal before holding the speed it reached
  planTime: 2.5, // s it looks ahead
  planStep: 0.1,
  flickRate: 0.32, // lateral speed it moves across at, as a share of its speed (quick flicks)...
  maxLateralSpeed: 10, // ...up to this many m/s
  lateralAccel: 6, // m/s² it swings across with: a lane change at 85 mph takes about a second and a half, as it
  // does on the road (the tires hold about 1 g, and the car has to turn back straight at the far side)
  moveCost: 1.2, // score (m of ground) per metre moved across: it doesn't swerve for nothing
  commitBonus: 6, // score for keeping the gap it already chose, so it doesn't dither
  replanInterval: 0.12, // s between decisions
  speedGain: 2, // 1/s: how hard it closes a gap between the planned speed and its own
  openWeight: 0.5, // score per metre of open road ahead where a plan ends up
  speedWeight: 1.5, // score per m/s it carries out of a plan
  closeBonus: 3, // score for passing within a metre: a swimmer cuts it close
  hitCost: 200, // score against a plan that touches a car
  oncomingCost: 25 // score against the oncoming half of a two-way street: used to pass, not to cruise in
};

const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// One step of a move across the street, as the car can make it: lateral speed builds and comes off at `accel`, so
// it arrives at `goal` with no sideways speed left. Returns the new lateral speed.
function slideAcross(lat, vel, goal, dt, accel, maxSpeed) {
  const gap = goal - lat;
  const wanted = Math.sign(gap) * Math.min(maxSpeed, Math.sqrt(2 * accel * Math.abs(gap)));
  return vel + clamp(wanted - vel, -accel * dt, accel * dt);
}

// The car's sideways speed across a street running along (ux, uz), + to the left
function lateralVelocity(car, ux, uz) {
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  const vx = sin * car.speed + car.vx, vz = cos * car.speed + car.vz;
  return vx * uz - vz * ux;
}

// Front-wheel lock the driver gets at a speed (mirrors stepDriftCar), so a wanted wheel angle becomes an input
function driverLock(speed, params = M5_DRIFT) {
  return params.highSpeedSteer + (params.maxSteer - params.highSpeedSteer) / (1 + (Math.abs(speed) / 14) ** 2);
}

class DriftAutopilot {
  constructor(options = {}) {
    this.options = { ...AUTOPILOT, ...options };
    this.input = { throttle: 0, brake: 0, reverse: 0, steer: 0, handbrake: 0, burnout: 0, assist: 1 };
    this.path = [];
    this.segment = 0;
    this.offset = 0; // current lateral offset from the route line (m, + left)
    this.targetOffset = 0;
    this.kick = 0; // s of handbrake left in the current drift entry
    this.driftedCorner = -1;
    this.finished = false;
  }

  // corridors: optional per-leg street bounds, see corridor()
  setPath(points, { loop = false, corridors = null } = {}) {
    this.path = loop ? [...points, points[0]] : points.slice();
    this.corridors = corridors;
    this.segment = 0;
    this.driftedCorner = -1;
    this.finished = false;
  }

  // Segment geometry: start, unit direction, length
  seg(i) {
    const a = this.path[i], b = this.path[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    return { a, b, ux: dx / length, uz: dz / length, length };
  }

  // Track progress: move on to the next segment once the car is past the end of this one
  advance(car) {
    while (this.segment < this.path.length - 2) {
      const s = this.seg(this.segment);
      const along = (car.position.x - s.a.x) * s.ux + (car.position.z - s.a.z) * s.uz;
      if (along < s.length - 2) break;
      this.segment++;
    }
    const last = this.seg(this.path.length - 2);
    const along = (car.position.x - last.a.x) * last.ux + (car.position.z - last.a.z) * last.uz;
    if (this.segment === this.path.length - 2 && along > last.length - 4) this.finished = true;
  }

  // A point `distance` metres along the route from the car's projection, shifted by the lane offset
  pointAhead(car, distance) {
    let i = this.segment;
    let s = this.seg(i);
    let along = clamp((car.position.x - s.a.x) * s.ux + (car.position.z - s.a.z) * s.uz, 0, s.length) + distance;
    while (along > s.length && i < this.path.length - 2) {
      along -= s.length;
      s = this.seg(++i);
    }
    // Left of the direction of travel is (uz, -ux) in this world (heading 0 faces +z)
    return { x: s.a.x + s.ux * along + s.uz * this.offset, z: s.a.z + s.uz * along - s.ux * this.offset };
  }

  // The street either side of the route line on this leg: { left, right } lateral bounds (m, + left), and for a
  // two-way street `centre`, beyond which (to the left) is oncoming traffic. Without corridors: lanes × laneWidth.
  corridor() {
    const o = this.options;
    return this.corridors?.[this.segment] ?? { left: o.lanes * o.laneWidth, right: -o.lanes * o.laneWidth, centre: null };
  }

  // Swimming: a look a few seconds ahead. Every car nearby is run forward at its own velocity (along the street and
  // across it: a car changing lanes, traffic crossing a junction), and the AI tries each combination of a position
  // across the street and a pedal (brake hard, ease off, hold, floor it). It flies each one forward and keeps the one
  // that covers the most ground without touching anyone. The cars it is threading keep moving while it moves, so it
  // finds the staggered gaps a swimmer uses: pass one car on its left, then dive across in front of the next.
  planGap(car, obstacles) {
    const o = this.options;
    const s = this.seg(this.segment);
    const lx = s.uz, lz = -s.ux; // left of the direction of travel
    const u = Math.max(0, car.speed);
    const carLat = (car.position.x - s.a.x) * lx + (car.position.z - s.a.z) * lz;
    const lateralSpeed = clamp(Math.max(5, u) * o.flickRate, 3, o.maxLateralSpeed);
    this.lateralSpeed = lateralSpeed;
    // Every plan starts from where the car is and how fast it is already moving across
    const carLatVel = lateralVelocity(car, s.ux, s.uz);
    this.refLat = carLat;
    this.refVel = carLatVel;

    // Traffic in the street's frame: along (m ahead of the car, centre to centre), across, and both velocities
    // (entries are pooled: this runs several times a second with dozens of cars)
    const seen = this._seen ??= [];
    const band = this.corridor();
    const reachable = lateralSpeed * o.planTime + 4; // m: further across than that, a car can't be reached
    let count = 0;
    for (const ob of obstacles) {
      const dx = ob.x - car.position.x, dz = ob.z - car.position.z;
      // Something right on top of the car is the car itself (a shared traffic list), or already being hit
      if (dx * dx + dz * dz < 2.25) continue;
      const along = dx * s.ux + dz * s.uz;
      // Its footprint along and across this street, however it is turned (a bus across a junction fills lanes)
      const half = ob.half ?? 2.3, halfWidth = ob.halfWidth ?? 0.95;
      const rel = ob.yaw === undefined ? 0 : ob.yaw - Math.atan2(s.ux, s.uz);
      const cosRel = Math.abs(Math.cos(rel)), sinRel = Math.abs(Math.sin(rel));
      const extentAlong = half * cosRel + halfWidth * sinRel;
      const extentAcross = half * sinRel + halfWidth * cosRel;
      const length = extentAlong + o.carHalfLength + o.followMargin;
      if (along < -length - 10 || along > o.scanAhead) continue;
      const lateral = (ob.x - s.a.x) * lx + (ob.z - s.a.z) * lz;
      // Out of reach across the street for the whole look-ahead: skip it
      if (lateral - extentAcross > band.left + reachable || lateral + extentAcross < band.right - reachable) continue;
      // Its whole velocity: driving, plus any shove it is sliding with after a knock
      const speed = ob.speed || 0;
      const vx = (ob.yaw === undefined ? 0 : Math.sin(ob.yaw) * speed) + (ob.vx || 0);
      const vz = (ob.yaw === undefined ? 0 : Math.cos(ob.yaw) * speed) + (ob.vz || 0);
      const reach = extentAcross + o.carHalfWidth + o.passMargin;
      // Already inside the margins (tailgating, or squeezed alongside): only getting closer counts as a hit, or every
      // plan, the escape too, would fail in its first instant
      const inside = Math.abs(lateral - carLat) < reach && Math.abs(along) < length;
      const entry = seen[count] ??= {};
      entry.along = along;
      entry.lateral = lateral;
      entry.vAlong = vx * s.ux + vz * s.uz;
      entry.vLateral = vx * lx + vz * lz;
      entry.length = inside ? Math.max(extentAlong + o.carHalfLength, Math.abs(along) - 0.2) : length;
      entry.reach = inside ? Math.max(extentAcross + o.carHalfWidth, Math.min(reach, Math.abs(lateral - carLat) - 0.05)) : reach;
      count++;
    }

    const oncoming = band.centre !== null && band.centre !== undefined ? band.centre : Infinity;
    let best = null;
    const near = this._near ??= [];
    const overshoot = carLatVel * Math.abs(carLatVel) / (2 * o.lateralAccel); // where its sideways speed carries it
    for (let y = band.right; y <= band.left + 1e-6; y += o.gapStep) {
      // Only the cars this move could come near: across the street, the move spans the car's line to y (plus any
      // overshoot); a car spans where it drifts to over the look-ahead, plus the passing reach
      const low = Math.min(carLat, y, carLat + overshoot), high = Math.max(carLat, y, carLat + overshoot);
      let nearCount = 0;
      for (let i = 0; i < count; i++) {
        const ob = seen[i];
        const drift = ob.vLateral * o.planTime;
        if (ob.lateral + Math.max(0, drift) + ob.reach > low && ob.lateral + Math.min(0, drift) - ob.reach < high) {
          near[nearCount++] = ob;
        }
      }
      for (const accel of o.pedals) {
        // Fly the plan: speed eases toward the pedal's, position slides across at the flick rate
        let travelled = 0, speed = u, lat = carLat, latVel = carLatVel, hitAt = Infinity, closest = Infinity;
        for (let step = 1; step * o.planStep <= o.planTime && hitAt === Infinity; step++) {
          const t = step * o.planStep;
          // A punch (or a brake) into the gap, then holding that speed through it
          if (t <= o.pedalTime) speed = clamp(speed + accel * o.planStep, 0, o.cruiseSpeed);
          travelled += speed * o.planStep;
          latVel = slideAcross(lat, latVel, y, o.planStep, o.lateralAccel, lateralSpeed);
          lat += latVel * o.planStep;
          for (let i = 0; i < nearCount; i++) {
            const ob = near[i];
            const gapAlong = Math.abs(ob.along + ob.vAlong * t - travelled) - ob.length;
            const gapAcross = Math.abs(ob.lateral + ob.vLateral * t - lat) - ob.reach;
            if (gapAlong < 0 && gapAcross < 0) {
              hitAt = t;
              break;
            }
            if (gapAlong < 4) closest = Math.min(closest, gapAcross);
          }
        }
        // Ground covered, less the swerving it takes; a near pass is a small bonus (it's a swim, not a cruise), the
        // oncoming half a cost. A plan that meets a car is only taken when every plan does: then the one that meets it
        // latest, slowest, wins (time to brake or for the next move to find a way).
        let score = travelled;
        if (hitAt === Infinity) {
          // Where the plan leaves it matters as much as the ground it covers: open road ahead in the lane it ends in,
          // and the speed it carries into it. And a plan is only safe if it ends with room to brake to the speed of the car ahead in its lane: otherwise
          // it is a trap a step past the look-ahead (closing at 30 mph on a queue)
          let open = o.scanAhead, trapped = false;
          for (let i = 0; i < nearCount; i++) {
            const ob = near[i];
            const ahead = ob.along + ob.vAlong * o.planTime - travelled - ob.length;
            if (ahead > -1 && Math.abs(ob.lateral + ob.vLateral * o.planTime - lat) < ob.reach) {
              open = Math.min(open, Math.max(0, ahead));
              const closing = speed - ob.vAlong;
              if (closing > 0 && ahead < closing * closing / (2 * o.braking)) trapped = true;
            }
          }
          if (trapped) hitAt = o.planTime;
          score += o.openWeight * open + o.speedWeight * speed;
        }
        score -= Math.abs(y - carLat) * o.moveCost;
        if (closest < 1) score += o.closeBonus * (1 - Math.max(0, closest));
        if (y > oncoming) score -= o.oncomingCost;
        // Keeping to the line already chosen wins ties: changing its mind takes a clearly better gap
        if (Math.abs(y - this.targetOffset) < o.gapStep * 0.5) score += o.commitBonus;
        // Unsafe plans rank by how late they meet trouble, then by how slow they are by then
        if (hitAt !== Infinity) score = -o.hitCost * (o.planTime - hitAt) - speed;
        const safe = hitAt === Infinity;
        if (!best || (safe && !best.safe) || (safe === best.safe && score > best.score)) {
          best = this._best ??= {};
          best.score = score;
          best.safe = safe;
          best.y = y;
          best.accel = accel;
        }
      }
    }
    this.targetOffset = best.y;
    // The executor flies the same speed profile: the chosen pedal for pedalTime from this speed, then hold
    const plan = this._plan ??= {};
    plan.start = u;
    plan.accel = best.accel;
    plan.safe = best.safe;
    return plan;
  }

  update(car, dt, obstacles = []) {
    const o = this.options;
    const input = this.input;
    input.burnout = 0;
    input.reverse = 0;
    if (this.path.length < 2) {
      input.throttle = 0;
      input.brake = 1;
      return input;
    }
    this.advance(car);
    const u = car.speed;
    const s = this.seg(this.segment);
    const hasCorner = this.segment < this.path.length - 2;
    const next = hasCorner ? this.seg(this.segment + 1) : null;
    const turn = next ? wrap(Math.atan2(next.ux, next.uz) - Math.atan2(s.ux, s.uz)) : 0;
    const toCorner = Math.max(0, s.length - ((car.position.x - s.a.x) * s.ux + (car.position.z - s.a.z) * s.uz));
    const sharp = hasCorner && Math.abs(turn) > o.sharpTurn;

    // Swim: find the line through the traffic ahead and flick across to it (straight back to the line for corners)
    // A driver decides a few times a second, not every frame: between decisions it flies the last plan
    this.sincePlan = (this.sincePlan ?? Infinity) + dt;
    if (this.sincePlan >= o.replanInterval || !this.plan) {
      this.plan = this.planGap(car, obstacles);
      this.sincePlan = 0;
    }
    const plan = this.plan;
    const goal = sharp && toCorner < 30 ? 0 : this.targetOffset;
    // The move across the street the plan was made with, flown forward; the wheel aims where that move will have the
    // car by the time it reaches the aim point (so the steering leads the move rather than chasing it)
    this.refVel = slideAcross(this.refLat, this.refVel, goal, dt, o.lateralAccel, this.lateralSpeed);
    this.refLat += this.refVel * dt;
    const reach = o.lookahead + o.lookaheadTime * Math.abs(u);
    const lead = reach / Math.max(5, Math.abs(u));
    let aheadLat = this.refLat, aheadVel = this.refVel;
    for (let i = 0; i < LEAD_STEPS; i++) {
      aheadVel = slideAcross(aheadLat, aheadVel, goal, lead / LEAD_STEPS, o.lateralAccel, this.lateralSpeed);
      aheadLat += aheadVel * lead / LEAD_STEPS;
    }
    this.offset = aheadLat;

    // Speed: the plan's pedal, flown as planned (its acceleration fed straight to the pedals, so the car keeps to the
    // timing the gaps were picked with), capped by what the next corner allows
    const planned = clamp(plan.start + plan.accel * Math.min(this.sincePlan, o.pedalTime), 0, o.cruiseSpeed);
    let target = planned;
    let feedForward = this.sincePlan < o.pedalTime && planned > 0 && planned < o.cruiseSpeed ? plan.accel : 0;
    if (sharp) {
      const cornerLimit = Math.sqrt(o.cornerSpeed ** 2 + 2 * o.braking * Math.max(0, toCorner - 8));
      if (cornerLimit < target) {
        target = cornerLimit;
        feedForward = u > cornerLimit ? -o.braking : 0;
      }
    }

    // Drift entry: a handbrake flick and full lock into the turn as the corner arrives
    const entry = Math.max(10, Math.abs(u) * 0.85);
    if (sharp && toCorner < entry && this.driftedCorner !== this.segment && u > 8) {
      this.driftedCorner = this.segment;
      this.kick = o.kickTime;
      this.cornering = true;
    }
    const kicking = this.kick > 0;
    this.kick = Math.max(0, this.kick - dt);

    // Steering: aim the velocity (not the nose) at a point down the route, which holds a drift on its line
    const aim = this.pointAhead(car, reach);
    const desired = Math.atan2(aim.x - car.position.x, aim.z - car.position.z);
    const slip = Math.abs(u) > 2 ? Math.atan2(car.vx * Math.cos(car.heading) - car.vz * Math.sin(car.heading), Math.abs(u)) : 0;
    const travel = car.heading + slip;
    const error = wrap(desired - travel);
    const wheel = error * o.steerGain;
    // Off line and pointing the wrong way: slow to a speed the front tires can turn at (about 1 g of grip over the
    // radius it takes to swing back onto the route)
    if (!this.cornering && Math.abs(error) > o.offLine) {
      const radius = (o.lookahead + o.lookaheadTime * Math.abs(u)) / (2 * Math.sin(Math.min(Math.abs(error), Math.PI / 2)));
      const turnLimit = Math.max(8, Math.sqrt(9.5 * radius));
      if (turnLimit < target) {
        target = turnLimit;
        feedForward = Math.min(0, feedForward);
      }
    }
    input.steer = kicking ? Math.sign(turn) : clamp(wheel / driverLock(u), -1, 1);
    input.handbrake = kicking ? 1 : 0;

    // The corner is done once the car is on the new street and either travelling along it or gripping again
    const slipAbs = Math.abs(slip);
    const lineError = Math.abs(wrap(Math.atan2(s.ux, s.uz) - travel));
    if (this.cornering && !kicking && this.segment > this.driftedCorner
      && (lineError < o.exitAlign || (slipAbs < o.exitAlign && lineError < 3 * o.exitAlign))) {
      this.cornering = false;
    }
    if (kicking) {
      input.throttle = 0;
      input.brake = 0;
    } else if (this.cornering) {
      // Hold the slide: more gas when it straightens too early, a lift when it swings past the angle
      input.brake = 0;
      if (slipAbs > o.driftAngle + 8 * RAD) input.throttle = o.driftThrottle * 0.3;
      else if (slipAbs < o.driftAngle - 10 * RAD) input.throttle = o.driftThrottle * 1.3;
      else input.throttle = o.driftThrottle;
    } else {
      // The force the wanted acceleration takes, on top of drag and rolling resistance: positive is gas, negative brake
      const p = M5_DRIFT;
      const want = feedForward + (target - u) * o.speedGain;
      const resistance = p.dragArea * u * Math.abs(u) + p.rolling * p.mass * GRAVITY;
      const force = p.mass * want + resistance;
      if (force < 0) {
        input.throttle = 0;
        input.brake = clamp(-force / (p.brakeGrip * p.mass * GRAVITY), 0, 1);
      } else {
        input.brake = 0;
        // Traction control between corners: no more gas than the rears can put down (power ∝ throttle, so the limit
        // grows with speed), and less again while the car is still sliding
        const sliding = clamp(1 - (slipAbs - o.tractionSlip) / (12 * RAD), 0.05, 1);
        const grip = clamp(o.tractionThrottle * Math.max(6, u), 0.15, 1);
        const fullForce = Math.min(p.launchForce * p.mass * GRAVITY, p.power / Math.max(1, Math.abs(u)));
        input.throttle = Math.min(force / fullForce, grip) * sliding;
      }
    }
    if (this.finished) {
      input.throttle = 0;
      input.brake = 0.6;
    }
    return input;
  }
}

// A choreographed drift circle (the street "donut"): the car orbits a centre point at a steady speed with its nose
// turned in by the drift angle, rear tires spinning and the front wheels counter-steered along the slide, the way a
// driver holds a power-slide round a parked car. The orbit is a drift equilibrium: lateral grip of about 1 g gives
// speed ≈ √(g·radius) and a yaw rate of speed / radius. Sets the car state directly (position, heading, velocities),
// easing in from whatever the car was doing, so the physics can take the car back at the same speed when it ends.
const DRIFT_CIRCLE = {
  radius: 10, // m from the centre to the car
  speed: 10.5, // m/s over the ground on the orbit
  slip: 42 * RAD, // drift angle between the heading and the direction of travel
  tightSlip: 58 * RAD, // with the handbrake (or a tighter line): more angle, a smaller circle
  tightRadius: 6.5,
  exitSlip: 12 * RAD, // straightening out before handing back
  speedRate: 1.1, // 1/s easing of speed, angle and radius toward their targets
  slipRate: 1.8,
  radiusRate: 0.9,
  counterSteer: 0.6 // front wheels follow the slide by this share of the drift angle (about 25° at 42°, as measured
  // on a held 13 m circle: Velenis et al. 2011)
};

class DriftCircle {
  constructor({ center, direction = 1, radius, options = {} }) {
    this.o = { ...DRIFT_CIRCLE, ...options };
    this.center = { x: center.x, z: center.z };
    this.direction = Math.sign(direction) || 1;
    this.targetRadius = radius ?? this.o.radius;
    this.tight = false; // handbrake: tighter and more sideways
    this.exiting = false; // straighten up on the current tangent
    this.started = false;
  }

  // Orbit a fixed point (the show: round the cop car) from wherever the car is now
  static around(car, center, options = {}) {
    const radius = options.radius ?? Math.hypot(car.position.x - center.x, car.position.z - center.z);
    return new DriftCircle({ center, direction: options.direction, radius, options });
  }

  // Start a circle that carries on from the car's line: its centre sits off the side it is turning toward
  static from(car, options = {}) {
    const direction = Math.sign(options.direction) || 1;
    const radius = options.radius ?? DRIFT_CIRCLE.radius;
    const travel = travelHeading(car);
    const center = {
      x: car.position.x + direction * radius * Math.cos(travel),
      z: car.position.z - direction * radius * Math.sin(travel)
    };
    return new DriftCircle({ center, direction, radius, options });
  }

  // Direction of travel along the orbit at the car's position: the tangent, turning in `direction`
  tangent(car) {
    const dx = car.position.x - this.center.x, dz = car.position.z - this.center.z;
    // position = centre + direction·radius·(−cos ψ, sin ψ) for a car travelling along ψ
    return Math.atan2(dz * this.direction, -dx * this.direction);
  }

  update(car, dt, telemetry) {
    const o = this.o;
    const dir = this.direction;
    if (!this.started) {
      // Take over the car's speed, angle and distance as they are, so the move eases in rather than snapping
      this.started = true;
      this.speed = Math.hypot(car.speed, car.vx, car.vz);
      this.radius = Math.max(2, Math.hypot(car.position.x - this.center.x, car.position.z - this.center.z));
      this.travel = this.tangent(car);
      this.slip = Math.atan2(Math.sin(car.heading - this.travel), Math.cos(car.heading - this.travel));
    }
    const radiusGoal = this.tight ? o.tightRadius : this.targetRadius;
    // Steady speed for the radius: about 1 g of lateral grip
    const speedGoal = this.exiting ? this.speed : Math.min(o.speed, Math.sqrt(9.81 * 1.05 * this.radius));
    let slipGoal = dir * (this.tight ? o.tightSlip : o.slip);
    if (this.exiting) slipGoal = dir * o.exitSlip;
    this.speed += (speedGoal - this.speed) * (1 - Math.exp(-dt * o.speedRate));
    this.radius += (radiusGoal - this.radius) * (1 - Math.exp(-dt * o.radiusRate));
    this.slip += (slipGoal - this.slip) * (1 - Math.exp(-dt * o.slipRate));

    const prevX = car.position.x, prevZ = car.position.z, prevHeading = car.heading;
    if (this.exiting) {
      // Run straight out along the last tangent while the angle comes off
      car.position.x += Math.sin(this.travel) * this.speed * dt;
      car.position.z += Math.cos(this.travel) * this.speed * dt;
    } else {
      this.travel += dir * this.speed / this.radius * dt;
      car.position.x = this.center.x - dir * this.radius * Math.cos(this.travel);
      car.position.z = this.center.z + dir * this.radius * Math.sin(this.travel);
    }
    car.heading = this.travel + this.slip;

    // Velocities from the motion itself, split into the car's frame
    const vx = (car.position.x - prevX) / dt, vz = (car.position.z - prevZ) / dt;
    const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
    const forward = vx * sin + vz * cos;
    const lateral = vx * cos - vz * sin;
    car.speed = forward;
    car.vx = cos * lateral;
    car.vz = -sin * lateral;
    const turn = Math.atan2(Math.sin(car.heading - prevHeading), Math.cos(car.heading - prevHeading));
    car.angularVel = turn / dt;
    car.steerAngle = Math.max(-M5_DRIFT.maxSteer, Math.min(M5_DRIFT.maxSteer, -this.slip * o.counterSteer));
    car.longAccel = 0;
    if (telemetry) {
      telemetry.slipAngle = Math.atan2(lateral, Math.abs(forward));
      telemetry.rearSlide = Math.abs(lateral - M5_DRIFT.cgToRear * car.angularVel) + 8;
      telemetry.wheelspin = 1;
      telemetry.steer = car.steerAngle;
      telemetry.lateralAccel = -car.angularVel * Math.hypot(vx, vz);
    }
  }
}

// Heading of the car's velocity over the ground (its nose when it is barely moving)
function travelHeading(car) {
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  const vx = sin * car.speed + car.vx, vz = cos * car.speed + car.vz;
  return Math.hypot(vx, vz) > 1 ? Math.atan2(vx, vz) : car.heading;
}

export { AUTOPILOT, DRIFT_CIRCLE, DriftAutopilot, DriftCircle, driverLock };
