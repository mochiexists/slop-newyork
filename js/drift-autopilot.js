import { M5_DRIFT } from './drift-physics.js';

// The AI driver for swimming: it presses the same pedals and wheel a player does (input for stepDriftCar) to follow
// a route along the streets as fast as the corners allow, handbrake-flicks into a drift at every sharp corner, and
// weaves between the traffic ahead by moving across lanes. Pure and DOM-free, so it can be driven in tests.

const RAD = Math.PI / 180;

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
  laneWidth: 3.3, // m between the lanes it weaves through
  lanes: 1, // lanes either side of the route line it may use
  scanAhead: 55, // m of traffic it looks at
  carHalfWidth: 1.1, // m: a gap narrower than two of these is closed
  stopShort: 5 // m it stops short of a road that is blocked in every lane
};

const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

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

  setPath(points, { loop = false } = {}) {
    this.path = loop ? [...points, points[0]] : points.slice();
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

  // Lane choice: the lane whose corridor ahead holds the farthest-away (or no) traffic, with a bias to stay put
  chooseLane(car, obstacles) {
    const o = this.options;
    const s = this.seg(this.segment);
    let best = this.targetOffset, bestScore = -Infinity;
    for (let lane = -o.lanes; lane <= o.lanes; lane++) {
      const offset = lane * o.laneWidth;
      let clear = o.scanAhead;
      for (const ob of obstacles) {
        const dx = ob.x - car.position.x, dz = ob.z - car.position.z;
        // Something right on top of the car is the car itself (a shared traffic list), or already being hit
        if (dx * dx + dz * dz < 2.25) continue;
        const ahead = dx * s.ux + dz * s.uz;
        if (ahead < -2 || ahead > o.scanAhead) continue;
        // Lateral position of the obstacle relative to the route line
        const lateral = (ob.x - s.a.x) * s.uz - (ob.z - s.a.z) * s.ux;
        if (Math.abs(lateral - offset) < o.carHalfWidth * 2) clear = Math.min(clear, Math.max(0, ahead));
      }
      const score = clear - Math.abs(offset) * 0.4 + (offset === this.targetOffset ? 6 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = offset;
      }
    }
    this.targetOffset = best;
    return bestScore;
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

    // Weave: pick a lane through the traffic ahead, and slide across to it (straight back to the line for corners)
    const clearAhead = this.chooseLane(car, obstacles);
    const goal = sharp && toCorner < 30 ? 0 : this.targetOffset;
    this.offset += clamp(goal - this.offset, -6 * dt, 6 * dt);

    // Speed plan: as fast as the next corner allows, slower when every lane ahead is blocked close by
    let target = o.cruiseSpeed;
    if (sharp) target = Math.min(target, Math.sqrt(o.cornerSpeed ** 2 + 2 * o.braking * Math.max(0, toCorner - 8)));
    // Every lane blocked close ahead: slow down, and stop a few metres short of it
    if (clearAhead < 25) target = Math.min(target, Math.max(0, (clearAhead - o.stopShort) * 1.1));

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
    const aim = this.pointAhead(car, o.lookahead + o.lookaheadTime * Math.abs(u));
    const desired = Math.atan2(aim.x - car.position.x, aim.z - car.position.z);
    const slip = Math.abs(u) > 2 ? Math.atan2(car.vx * Math.cos(car.heading) - car.vz * Math.sin(car.heading), Math.abs(u)) : 0;
    const travel = car.heading + slip;
    const error = wrap(desired - travel);
    const wheel = error * o.steerGain;
    // Off line and pointing the wrong way: slow to a speed the front tires can turn at (about 1 g of grip over the
    // radius it takes to swing back onto the route)
    if (!this.cornering && Math.abs(error) > o.offLine) {
      const radius = (o.lookahead + o.lookaheadTime * Math.abs(u)) / (2 * Math.sin(Math.min(Math.abs(error), Math.PI / 2)));
      target = Math.min(target, Math.max(8, Math.sqrt(9.5 * radius)));
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
    } else if (u > target + 1.5) {
      input.throttle = 0;
      input.brake = clamp((u - target) / 3, 0.3, 1);
    } else {
      input.brake = 0;
      // Traction control between corners: no more gas than the rears can put down (power ∝ throttle, so the limit
      // grows with speed), and less again while the car is still sliding
      const sliding = clamp(1 - (slipAbs - o.tractionSlip) / (12 * RAD), 0.05, 1);
      const grip = clamp(o.tractionThrottle * Math.max(6, u), 0.15, 1);
      input.throttle = Math.min(clamp((target - u) / 3 + 0.35, 0, 1), grip) * sliding;
    }
    if (this.finished) {
      input.throttle = 0;
      input.brake = 0.6;
    }
    return input;
  }
}

// A choreographed donut: the car pivots about a point near its front axle, the rear swinging round on spinning
// tires. Sets the car state directly (position, heading, velocities) so it stays on its spot for the show.
class DonutRoutine {
  constructor({ pivot, direction = 1, yawRate = 2.4, pivotOffset = 1.15 }) {
    this.pivot = pivot; // { x, z } the nose pivots on
    this.direction = Math.sign(direction) || 1;
    this.yawRate = yawRate;
    this.pivotOffset = pivotOffset; // m ahead of the centre of mass
    this.spin = 0; // eased yaw rate
  }

  // Put the pivot under the car's nose as it is now
  static from(car, options = {}) {
    const offset = options.pivotOffset ?? 1.15;
    const pivot = { x: car.position.x + Math.sin(car.heading) * offset, z: car.position.z + Math.cos(car.heading) * offset };
    return new DonutRoutine({ ...options, pivot, pivotOffset: offset });
  }

  update(car, dt, telemetry) {
    this.spin += (this.yawRate - this.spin) * (1 - Math.exp(-dt * 1.6));
    const r = this.spin * this.direction;
    car.heading += r * dt;
    const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
    const prevX = car.position.x, prevZ = car.position.z;
    car.position.x = this.pivot.x - sin * this.pivotOffset;
    car.position.z = this.pivot.z - cos * this.pivotOffset;
    // The centre of mass swings sideways round the pivot: no forward speed, lateral speed r × offset
    const vx = (car.position.x - prevX) / dt, vz = (car.position.z - prevZ) / dt;
    car.speed = 0.4;
    car.vx = vx;
    car.vz = vz;
    car.angularVel = r;
    car.steerAngle = M5_DRIFT.maxSteer * this.direction;
    car.longAccel = 0;
    if (telemetry) {
      telemetry.slipAngle = -this.direction * 80 * RAD * Math.min(1, this.spin / 1.2);
      telemetry.rearSlide = this.spin * (this.pivotOffset + M5_DRIFT.cgToRear) + 10;
      telemetry.wheelspin = 1;
      telemetry.steer = car.steerAngle;
      telemetry.lateralAccel = -r * Math.hypot(vx, vz);
    }
  }
}

export { AUTOPILOT, DriftAutopilot, DonutRoutine, driverLock };
