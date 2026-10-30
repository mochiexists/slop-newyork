import { M5_DRIFT, fullDriveForce } from './drift-physics.js';

// The AI driver for swimming: it presses the player's keys (W, S, A, D, the handbrake), one frame at a time, through
// the car's own KeyboardDriver, to follow a route along the streets as fast as the corners allow, handbrake-flick into
// a drift at every sharp corner, and swim through the traffic ahead, threading the gaps between cars. It can do
// nothing a player at the keyboard couldn't: it decides the wheel and pedal it wants, then taps the keys that bring the
// driver's wheel and pedal there (it watches them, as a player watches their wheel). Pure and DOM-free, for tests.

const RAD = Math.PI / 180;
const GRAVITY = 9.81;
const DRIFT_SPEED_MARGIN = 1.2; // share over the corner speed a drift may carry before it lifts
const TURN_GRIP = 9.5; // m/s²: the lateral grip a drifted corner is planned with
const ALONG_STREET = 15 * RAD; // travelling this close to the street's direction counts as running along it
const MIN_PEDAL = 0.05; // pedal below which the traction control's share of it isn't read
const MIN_PASSED = 0.1; // least share of the pedal it reckons the traction control passes on

const AUTOPILOT = {
  cruiseSpeed: 38, // m/s on the straights (85 mph)
  cornerSpeed: 9, // m/s into a drifted 90° corner: slow enough that a 45° slide stays inside a Manhattan crossing
  braking: 7.5, // m/s² it plans to brake at before a corner
  sharpTurn: 40 * RAD, // corners sharper than this are drifted
  kickTime: 0.32, // s of handbrake to break the rear loose
  kickSteer: 0.25, // share of the lock the wheel is wound on to before the handbrake flick
  driftAngle: 30 * RAD, // body slip it holds through a corner
  driftAngleRange: 20 * RAD, // past the angle, the lock into the turn comes off over this much more slip
  exitAlign: 12 * RAD, // travelling this close to the new street's direction ends the corner
  tractionSlip: 5 * RAD, // slip it allows on the straights before easing off the gas
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
  maxLateralSpeed: 10, // ...up to this many m/s,
  crawlAcross: 0.58, // ...and no more than this share of its speed along the street (pointing 30° across it)
  lateralAccel: 6, // m/s² it swings across with: a lane change at 85 mph takes about a second and a half, as it
  // does on the road (the tires hold about 1 g, and the car has to turn back straight at the far side)
  moveCost: 1.2, // score (m of ground) per metre moved across: it doesn't swerve for nothing
  lineUpDistance: 30, // m before a drifted corner where it lines up on the route line for it,
  lineUpCost: 40, // score per metre off that line: whenever a plan there is safe, it takes it
  commitBonus: 6, // score for keeping the gap it already chose, so it doesn't dither
  replanInterval: 0.12, // s between decisions
  speedGain: 2, // 1/s: how hard it closes a gap between the planned speed and its own
  openWeight: 0.5, // score per metre of open road ahead where a plan ends up
  speedWeight: 1.5, // score per m/s it carries out of a plan
  closeBonus: 3, // score for a close call (swim-mode.js CloseCalls): a swimmer cuts it close
  closeGap: 1, // m of air at most beside a car passed for a close call,
  closeSpeed: 8, // m/s at least it passes it by,
  splitWindow: 0.8, // s between close calls on either side that make a split (threading two cars)
  splitBonus: 4, // score for a split, on top of its two close calls
  splitAlong: 5, // m apart along the street at most that two cars count as side by side, a gap to split
  keepSpeedWeight: 12, // score per m/s a plan slows below keepSpeed (set while the show counts down the hand-over)
  brakeSteerLoss: 0.6, // share of the sideways grip lost to the brake key held down (all or nothing: 1.05 g)
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
    this.model = this.options.model ?? M5_DRIFT; // the car's drift model parameters
    // What it wants of the wheel and pedals (the driver's steer -1..1 and pedal 0..1), and the keys it presses for it
    this.want = { throttle: 0, brake: 0, reverse: 0, steer: 0, handbrake: 0 };
    this.keys = { forward: 0, backward: 0, left: 0, right: 0, handbrake: 0 };
    this.brakeDuty = 0;
    this.lockHeld = 0;
    this.keepSpeed = 0; // m/s its plans should not slow below (0: no such wish)
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
    // Every plan starts from where the car is and how fast it is already moving across
    const carLatVel = lateralVelocity(car, s.ux, s.uz);

    // Traffic in the street's frame: along (m ahead of the car, centre to centre), across, and both velocities
    // The swimmer's own footprint along and across the street, turned as it is (a flick turns it 10-20°, which widens it
    // by half a metre)
    const egoRel = car.heading - Math.atan2(s.ux, s.uz);
    const egoCos = Math.abs(Math.cos(egoRel)), egoSin = Math.abs(Math.sin(egoRel));
    const egoAlong = o.carHalfLength * egoCos + o.carHalfWidth * egoSin;
    const egoAcross = o.carHalfWidth * egoCos + o.carHalfLength * egoSin;
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
      const length = extentAlong + egoAlong + o.followMargin;
      if (along < -length - 10 || along > o.scanAhead) continue;
      const lateral = (ob.x - s.a.x) * lx + (ob.z - s.a.z) * lz;
      // Out of reach across the street for the whole look-ahead: skip it
      if (lateral - extentAcross > band.left + reachable || lateral + extentAcross < band.right - reachable) continue;
      // Its whole velocity: driving, plus any shove it is sliding with after a knock
      const speed = ob.speed || 0;
      const vx = (ob.yaw === undefined ? 0 : Math.sin(ob.yaw) * speed) + (ob.vx || 0);
      const vz = (ob.yaw === undefined ? 0 : Math.cos(ob.yaw) * speed) + (ob.vz || 0);
      const reach = extentAcross + egoAcross + o.passMargin;
      // Already inside the margins (tailgating, or squeezed alongside): only getting closer counts as a hit, or every
      // plan, the escape too, would fail in its first instant
      const inside = Math.abs(lateral - carLat) < reach && Math.abs(along) < length;
      const entry = seen[count] ??= {};
      entry.along = along;
      entry.lateral = lateral;
      entry.vAlong = vx * s.ux + vz * s.uz;
      entry.vLateral = vx * lx + vz * lz;
      entry.length = inside ? Math.max(extentAlong + egoAlong, Math.abs(along) - 0.2) : length;
      entry.reach = inside ? Math.max(extentAcross + egoAcross, Math.min(reach, Math.abs(lateral - carLat) - 0.05)) : reach;
      count++;
    }

    const oncoming = band.centre !== null && band.centre !== undefined ? band.centre : Infinity;
    let best = null;
    const near = this._near ??= [];
    // Per car near the move: the least air beside it while alongside, the side it was on, when the plan passes it
    const air = this._air ??= [];
    const side = this._side ??= [];
    const passedAt = this._passedAt ??= [];
    const aimReach = o.lookahead + o.lookaheadTime * u; // how far down the street the wheel aims (decide)
    const overshoot = carLatVel * Math.abs(carLatVel) / (2 * o.lateralAccel); // where its sideways speed carries it
    // The lines it tries across the street: one every gapStep, and the middle of every gap between two cars side by
    // side that it fits through (a split: the steps can miss a gap that leaves a hand's width either side)
    const lines = this._lines ??= [];
    let lineCount = 0;
    for (let y = band.right; y <= band.left + 1e-6; y += o.gapStep) lines[lineCount++] = y;
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        const rightCar = seen[i], leftCar = seen[j];
        if (leftCar.lateral <= rightCar.lateral || Math.abs(leftCar.along - rightCar.along) > o.splitAlong) continue;
        const from = rightCar.lateral + rightCar.reach, to = leftCar.lateral - leftCar.reach;
        const y = (from + to) / 2;
        if (to >= from && y >= band.right && y <= band.left) lines[lineCount++] = y;
      }
    }
    for (let line = 0; line < lineCount; line++) {
      const y = lines[line];
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
        // Fly the plan: speed eases toward the pedal's, position slides across at the flick rate. The brake key is all
        // or nothing, and the frames it is down leave the front tires little to turn with: the harder the plan brakes,
        // the slower it can move across.
        const braking = accel < 0 ? Math.min(1, -accel / (this.model.brakeGrip * GRAVITY)) : 0;
        const sideways = o.lateralAccel * (1 - o.brakeSteerLoss * braking);
        let travelled = 0, speed = u, lat = carLat, latVel = carLatVel, hitAt = Infinity;
        for (let i = 0; i < nearCount; i++) {
          air[i] = Infinity;
          passedAt[i] = Infinity;
        }
        for (let step = 1; step * o.planStep <= o.planTime && hitAt === Infinity; step++) {
          const t = step * o.planStep;
          // A punch (or a brake) into the gap, then holding that speed through it
          if (t <= o.pedalTime) speed = clamp(speed + accel * o.planStep, 0, o.cruiseSpeed);
          travelled += speed * o.planStep;
          // (a car only moves across as it rolls: at a crawl it can't step sideways round the car in front)
          latVel = slideAcross(lat, latVel, y, o.planStep, sideways, Math.min(lateralSpeed, speed * o.crawlAcross));
          lat += latVel * o.planStep;
          for (let i = 0; i < nearCount; i++) {
            const ob = near[i];
            const ahead = ob.along + ob.vAlong * t - travelled;
            const across = ob.lateral + ob.vLateral * t - lat;
            const gapAlong = Math.abs(ahead) - ob.length;
            const gapAcross = Math.abs(across) - ob.reach;
            if (gapAlong < 0 && gapAcross < 0) {
              hitAt = t;
              break;
            }
            // A close call, as the swim mode scores it: the air beside the car while alongside it, then passing it
            if (gapAlong + o.followMargin < 0) {
              air[i] = Math.min(air[i], gapAcross + o.passMargin);
              side[i] = Math.sign(across);
            } else if (ahead < 0 && air[i] < Infinity && passedAt[i] === Infinity && speed - ob.vAlong > o.closeSpeed) {
              passedAt[i] = t;
            }
          }
        }
        // Ground covered, less the swerving it takes; a near pass is a small bonus (it's a swim, not a cruise), the
        // oncoming half a cost. A plan that meets a car is only taken when every plan does: then the one that meets it
        // latest, slowest, wins (time to brake or for the next move to find a way).
        let score = travelled;
        let open = 0;
        if (hitAt === Infinity) {
          // Where the plan leaves it matters as much as the ground it covers: open road ahead in the lane it ends in,
          // and the speed it carries into it. And a plan is only safe if it ends with room to brake to the speed of the car ahead in its lane: otherwise
          // it is a trap a step past the look-ahead (closing at 30 mph on a queue)
          open = o.scanAhead;
          let trapped = false;
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
        if (this.lineUp) score -= Math.abs(y) * o.lineUpCost;
        score += this.closeCallScore(nearCount);
        if (y > oncoming) score -= o.oncomingCost;
        // Keeping to the line already chosen wins ties: changing its mind takes a clearly better gap
        if (Math.abs(y - this.targetOffset) < o.gapStep * 0.5) score += o.commitBonus;
        // Holding a speed (the hand-over count): a plan that slows below it is worth less the more it loses. A move far
        // across aims the wheel far off the street, and the executor slows for that (offLine, in decide)
        let slowest = Math.min(u, speed);
        const swerve = Math.atan2(Math.abs(y - carLat), aimReach);
        if (swerve > o.offLine) slowest = Math.min(slowest, Math.max(8, Math.sqrt(9.5 * aimReach / (2 * Math.sin(swerve)))));
        if (this.keepSpeed > 0) score -= o.keepSpeedWeight * Math.max(0, this.keepSpeed - slowest);
        // Unsafe plans rank by how late they meet trouble, then by how slow they are by then
        if (hitAt !== Infinity) score = -o.hitCost * (o.planTime - hitAt) - speed;
        const safe = hitAt === Infinity;
        if (!best || (safe && !best.safe) || (safe === best.safe && score > best.score)) {
          best = this._best ??= {};
          best.score = score;
          best.safe = safe;
          best.y = y;
          best.accel = accel;
          best.slowest = slowest;
          best.open = open;
        }
      }
    }
    this.targetOffset = best.y;
    // The executor flies the same speed profile: the chosen pedal for pedalTime from this speed, then hold
    const plan = this._plan ??= {};
    plan.start = u;
    plan.accel = best.accel;
    plan.safe = best.safe;
    plan.slowest = best.slowest; // the lowest speed the plan flies at
    plan.open = best.open; // m of clear road ahead in its lane where it ends
    return plan;
  }

  /**
   * Whether the road ahead lets the car hold `speed` for `seconds`: the plan it is flying is safe and never slower,
   * ends with clear road for the rest of the time and the braking from that speed after it, and no drifted corner
   * comes up within that distance and the braking for it. (The show starts its hand-over count only then, so the
   * player takes a car that is flying.)
   */
  holdsSpeed(car, speed, seconds) {
    const o = this.options;
    const plan = this.plan;
    if (!plan || !plan.safe || plan.slowest < speed || this.cornering || this.finished) return false;
    if (plan.open < speed * Math.max(0, seconds - o.planTime) + speed * speed / (2 * o.braking)) return false;
    const reach = speed * seconds + (speed * speed - o.cornerSpeed * o.cornerSpeed) / (2 * o.braking);
    let distance = this.seg(this.segment).length - this.alongSegment(car);
    for (let i = this.segment; i < this.path.length - 2 && distance < reach; i++) {
      const s = this.seg(i), next = this.seg(i + 1);
      if (Math.abs(wrap(Math.atan2(next.ux, next.uz) - Math.atan2(s.ux, s.uz))) > o.sharpTurn) return false;
      distance += next.length;
    }
    return true;
  }

  // Metres along the current segment the car has come
  alongSegment(car) {
    const s = this.seg(this.segment);
    return (car.position.x - s.a.x) * s.ux + (car.position.z - s.a.z) * s.uz;
  }

  /**
   * One frame of driving: decides the wheel and pedals it wants, and returns the keys to press this frame for the
   * car's KeyboardDriver (`driver`, whose wheel and pedal it reads). Call once per frame, before driver.update.
   */
  // What a flown plan's passes are worth: each close call (passed at speed with under closeGap of air) more the closer
  // it is, and a split (close calls on both sides within splitWindow: threading the gap between two cars) on top
  closeCallScore(count) {
    const o = this.options;
    const air = this._air, side = this._side, passedAt = this._passedAt;
    let score = 0;
    for (let i = 0; i < count; i++) {
      if (passedAt[i] === Infinity || !(air[i] < o.closeGap)) continue;
      score += o.closeBonus * (1 - Math.max(0, air[i]) / o.closeGap);
      for (let j = 0; j < i; j++) {
        if (passedAt[j] === Infinity || !(air[j] < o.closeGap) || side[j] !== -side[i]) continue;
        if (Math.abs(passedAt[i] - passedAt[j]) < o.splitWindow) score += o.splitBonus;
      }
    }
    return score;
  }

  update(car, dt, obstacles = [], driver) {
    this.decide(car, dt, obstacles, driver);
    return this.press(car, dt, driver);
  }

  // The keys that move the driver's wheel and pedal toward what it wants. A key is on or off for a whole frame, so it
  // taps them: each frame it picks the steering key (left, right or neither) whose wind-on or self-centring lands the
  // wheel nearest the wanted lock, holds W while the pedal is short of the wanted throttle, and pulses the brake for
  // its share of the frames. Holding the gas and one steering key is a power-over to the keyboard driver (it lets the
  // rears spin), so outside a drift it lifts W for a frame before that counts as meant.
  press(car, dt, driver) {
    const want = this.want;
    const keys = this.keys;
    const p = driver.params;
    const best = steeringKey(driver, want.steer, car.speed, dt);
    keys.left = best > 0 ? 1 : 0;
    keys.right = best < 0 ? 1 : 0;

    // The traction control passes on only part of the pedal (a quarter of it off the line): it presses for the throttle
    // it wants after that, reading last frame's share as a driver feels the car hold back
    const passed = driver.throttle > MIN_PEDAL ? clamp(driver.input.throttle / driver.throttle, MIN_PASSED, 1) : 1;
    const pedal = Math.min(1, want.throttle / passed);
    const up = approachValue(driver.throttle, 1, dt / p.throttleTime);
    const down = approachValue(driver.throttle, 0, dt / p.liftTime);
    keys.forward = pedal > 0 && Math.abs(up - pedal) <= Math.abs(down - pedal) ? 1 : 0;
    // A held lock with the gas: a power-over once commitDelay is up, unless it means one (a drift)
    this.lockHeld = keys.forward && best !== 0 && best === this.lockKey ? this.lockHeld + dt : 0;
    this.lockKey = keys.forward ? best : 0;
    if (!this.cornering && this.lockHeld + dt > p.commitDelay * 0.75) {
      keys.forward = 0;
      this.lockHeld = 0;
      this.lockKey = 0;
    }

    // The brake key is all or nothing: pressed for its share of the frames (never at a stop, where S reverses)
    this.brakeDuty = want.brake > 0 && car.speed > 0.6 ? this.brakeDuty + want.brake : 0;
    keys.backward = this.brakeDuty >= 0.5 ? 1 : 0;
    if (keys.backward) this.brakeDuty -= 1;
    if (want.reverse > 0) {
      keys.backward = 1;
      keys.forward = 0;
    }
    if (keys.backward) keys.forward = 0;
    keys.handbrake = want.handbrake > 0.5 ? 1 : 0;
    return keys;
  }

  decide(car, dt, obstacles, driver) {
    const o = this.options;
    const input = this.want;
    input.reverse = 0;
    input.handbrake = 0;
    if (this.path.length < 2) {
      input.throttle = 0;
      input.brake = 1;
      input.steer = 0;
      return;
    }
    this.advance(car);
    const u = car.speed;
    const s = this.seg(this.segment);
    const hasCorner = this.segment < this.path.length - 2;
    const next = hasCorner ? this.seg(this.segment + 1) : null;
    const turn = next ? wrap(Math.atan2(next.ux, next.uz) - Math.atan2(s.ux, s.uz)) : 0;
    const toCorner = Math.max(0, s.length - ((car.position.x - s.a.x) * s.ux + (car.position.z - s.a.z) * s.uz));
    const sharp = hasCorner && Math.abs(turn) > o.sharpTurn;

    // Swim: find the line through the traffic ahead and flick across to it (back onto the route line for a drifted
    // corner, unless a car is in the way there: traffic queues at the edge of a corner the show holds clear)
    // A driver decides a few times a second, not every frame: between decisions it flies the last plan
    this.lineUp = sharp && toCorner < o.lineUpDistance;
    this.sincePlan = (this.sincePlan ?? Infinity) + dt;
    if (this.sincePlan >= o.replanInterval || !this.plan) {
      this.plan = this.planGap(car, obstacles);
      this.sincePlan = 0;
    }
    const plan = this.plan;
    const goal = this.targetOffset;
    const reach = o.lookahead + o.lookaheadTime * Math.abs(u);
    // The wheel aims at the gap itself, down the street. (Aiming where the planned move would have the car by the aim
    // point led the steering when it was instant; on the keys the wheel winds on over a few tenths of a second and
    // that lead swung the car past the gap.)
    this.offset = goal;

    // Speed: the plan's pedal, flown as planned (its acceleration fed straight to the pedals, so the car keeps to the
    // timing the gaps were picked with), capped by what the next corner allows
    const planned = clamp(plan.start + plan.accel * Math.min(this.sincePlan, o.pedalTime), 0, o.cruiseSpeed);
    let target = planned;
    let feedForward = this.sincePlan < o.pedalTime && planned > 0 && planned < o.cruiseSpeed ? plan.accel : 0;
    if (sharp) {
      const cornerLimit = Math.sqrt(o.cornerSpeed ** 2 + 2 * o.braking * Math.max(0, toCorner - 8));
      if (cornerLimit < target) {
        target = cornerLimit;
        // Braking for the corner: at least the planned rate, more if it is late (the rate that still gets there)
        const late = (u * u - o.cornerSpeed ** 2) / (2 * Math.max(2, toCorner - 6));
        feedForward = u > cornerLimit ? -Math.max(o.braking, late) : 0;
      }
    }

    // Drift entry, as a player does it on the keys: hold the lock into the turn, and once the wheel is wound on far
    // enough, flick the handbrake. It flicks about a turning radius before the corner (at ~1 g of grip: speed² / g, at
    // the speed it will turn at), so the arc ends on the new street rather than across it; the lock goes on before that,
    // for as long as the wheel takes to wind on at this speed.
    const kp = driver.params;
    const windUp = o.kickSteer * (kp.steerTime + kp.steerTimePerSpeed * Math.abs(u));
    const entry = Math.max(10, o.cornerSpeed * o.cornerSpeed / TURN_GRIP) + Math.abs(u) * windUp;
    if (sharp && toCorner < entry && this.driftedCorner !== this.segment && u > 8) {
      this.driftedCorner = this.segment;
      this.turningIn = true;
      this.cornering = true;
    }
    if (this.turningIn && Math.abs(driver.steer) >= o.kickSteer) {
      this.turningIn = false;
      this.kick = o.kickTime;
    }
    const kicking = this.kick > 0 || this.turningIn;
    this.kick = Math.max(0, this.kick - dt);

    // Steering: aim the velocity (not the nose) at a point down the route, which holds a drift on its line
    const aim = this.pointAhead(car, reach);
    const desired = Math.atan2(aim.x - car.position.x, aim.z - car.position.z);
    const slip = Math.abs(u) > 2 ? Math.atan2(car.vx * Math.cos(car.heading) - car.vz * Math.sin(car.heading), Math.abs(u)) : 0;
    const travel = car.heading + slip;
    const error = wrap(desired - travel);
    const wheel = error * o.steerGain;
    // Off line and pointing the wrong way: slow to a speed the front tires can turn at (about 1 g of grip over the
    // radius it takes to swing back onto the route). A big swerve to a gap far across counts too (planGap allows for it).
    if (!this.cornering && Math.abs(error) > o.offLine) {
      const radius = (o.lookahead + o.lookaheadTime * Math.abs(u)) / (2 * Math.sin(Math.min(Math.abs(error), Math.PI / 2)));
      const turnLimit = Math.max(8, Math.sqrt(9.5 * radius));
      if (turnLimit < target) {
        target = turnLimit;
        feedForward = Math.min(0, feedForward);
      }
    }
    input.steer = kicking ? Math.sign(turn) : clamp(wheel / driverLock(u, this.model), -1, 1);
    input.handbrake = this.kick > 0 ? 1 : 0;
    const slipAbs = Math.abs(slip);
    if (this.cornering && !kicking) {
      // In the slide the lock into the turn asks for more angle (drift-physics.js): past the angle it wants, it takes
      // the lock off, and counter-steers when the tail swings well past it
      const into = Math.sign(turn) || 1;
      const most = clamp(1 - (slipAbs - o.driftAngle) / o.driftAngleRange, 0, 1);
      input.steer = into * Math.min(input.steer * into, most);
    }

    // The corner is done once the car is on the new street and either travelling along it or gripping again
    const lineError = Math.abs(wrap(Math.atan2(s.ux, s.uz) - travel));
    if (this.cornering && !kicking && this.segment > this.driftedCorner
      && (lineError < o.exitAlign || (slipAbs < o.exitAlign && lineError < 3 * o.exitAlign))) {
      this.cornering = false;
    }
    if (this.turningIn) {
      // Winding the lock on: still braking for the corner (trail braking), off the gas
      input.throttle = 0;
      input.brake = u > o.cornerSpeed ? clamp((u - o.cornerSpeed) * o.speedGain / (this.model.brakeGrip * GRAVITY), 0, 1) : 0;
    } else if (kicking) {
      input.throttle = 0;
      input.brake = 0;
    } else if (this.cornering) {
      // Hold the slide on the gas: the keyboard driver works the throttle for the angle while W is held. The gas holds
      // the angle, not a faster car: past the corner speed it lifts, or the slide carries the car across the new street
      input.brake = 0;
      input.throttle = u > o.cornerSpeed * DRIFT_SPEED_MARGIN ? 0 : 1;
    } else {
      // The force the wanted acceleration takes, on top of drag and rolling resistance: positive is gas, negative brake
      // (the keyboard driver's traction control keeps the gas to what the rears can put down)
      const p = this.model;
      const want = feedForward + (target - u) * o.speedGain;
      const resistance = p.dragArea * u * Math.abs(u) + p.rolling * p.mass * GRAVITY;
      const force = p.mass * want + resistance;
      if (force < 0) {
        input.throttle = 0;
        input.brake = clamp(-force / (p.brakeGrip * p.mass * GRAVITY), 0, 1);
      } else {
        input.brake = 0;
        // Easing off while the car is still sliding after a corner, so the tail comes back in line
        const sliding = clamp(1 - (slipAbs - o.tractionSlip) / (12 * RAD), 0.05, 1);
        input.throttle = Math.min(1, force / fullDriveForce(car, p)) * sliding;
      }
    }
    if (this.finished) {
      input.throttle = 0;
      input.brake = 0.6;
    }
  }
}

// The keyboard driver's wheel one frame on with a steering key (+1 left, -1 right) or none: it winds on toward the
// held key's lock, swings back faster against the current lock, and self-centres when let go (drift-physics.js)
function nextSteer(steer, key, speed, dt, p) {
  const windOn = dt / (p.steerTime + p.steerTimePerSpeed * speed);
  if (key === 0) return approachValue(steer, 0, dt / p.centreTime);
  if (key * steer < 0) return approachValue(steer, key, windOn * p.counterSteerRate);
  return approachValue(steer, key, windOn);
}

/** The steering key (+1 left, -1 right, 0 neither) that lands a keyboard driver's wheel nearest `want` next frame. */
function steeringKey(driver, want, speed, dt) {
  let best = 0, bestError = Infinity;
  for (const key of [0, 1, -1]) {
    const error = Math.abs(nextSteer(driver.steer, key, Math.abs(speed), dt, driver.params) - want);
    if (error < bestError - 1e-9) {
      best = key;
      bestError = error;
    }
  }
  return best;
}

function approachValue(value, target, step) {
  return value + Math.max(-step, Math.min(step, target - value));
}

// Heading of the car's velocity over the ground (its nose when it is barely moving)
function travelHeading(car) {
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  const vx = sin * car.speed + car.vx, vz = cos * car.speed + car.vz;
  return Math.hypot(vx, vz) > 1 ? Math.atan2(vx, vz) : car.heading;
}

export { AUTOPILOT, DriftAutopilot, driverLock, steeringKey, travelHeading };
