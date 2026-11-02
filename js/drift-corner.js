// A drifted corner as a path the AI can hold the car to: in along an entry line on the outside of the street it is on,
// round an arc, out along an exit line on the outside of the street it turns into. The arc is fitted to the road
// itself (swim-carriageway.js, the roadway off the curb islands and the plazas, as the show's donuts use it): every
// pose along the path, the car's whole body turned as a drift turns it (the nose into the turn by the slide's angle),
// grown by a reserve for how far the keys hold it off its line, has to stay on the road. The widest such arc wins (the
// fastest slide). Pure and DOM-free: the road is handed in, so tests can lay out their own.

const RAD = Math.PI / 180;

const CORNER_FIT = {
  reserve: 0.4, // m round the body it keeps clear of the curb (the keys hold a slide to its line to a few tenths)
  insideClearance: 1.3, // m in from the inside edge of the corridors (themselves 1.4 m off the curb, swim-show.js) the
  // widest arc it tries keeps: the body's half width across at 40° of slide (2.2 m) and the reserve, from the curb
  minRadius: 12,
  maxRadius: 60,
  radiusStep: 2.5, // m between the radii it tries, widest first
  lineSteps: [0, 0.8, 1.6, 2.6], // m in from the outside line it also tries the entry and exit lines at
  sampleStep: 1.5, // m between the poses checked along the path
  entryCheck: 12, // m of the entry line before the arc that are checked (the turn-in, the flick)
  exitCheck: 30, // m of the exit line after it (the tail still out as the slide unwinds)
  arcSlips: [0, 25 * RAD, 45 * RAD], // body angles off the path checked round the arc,
  entrySlips: [0, 15 * RAD], // ...on the entry line,
  exitSlips: [0, 20 * RAD, 35 * RAD] // ...and on the exit line
};

const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

// The corner's path. vertex: where the route's two legs meet; (ux, uz) the leg in, (vx, vz) the leg out (unit);
// entryLine / exitLine: the lines' offsets from the legs (m, + left of travel); radius: the arc's.
class CornerPath {
  constructor({ vertex, ux, uz, vx, vz, entryLine, exitLine, radius }) {
    Object.assign(this, { vertex, ux, uz, vx, vz, entryLine, exitLine, radius });
    this.turn = wrap(Math.atan2(vx, vz) - Math.atan2(ux, uz));
    this.into = Math.sign(this.turn) || 1; // +1 a left turn, -1 a right
    // (left of each leg; the arc's centre is `radius` to the inside of both lines)
    const n1x = uz, n1z = -ux, n2x = vz, n2z = -vx;
    const beta = entryLine + this.into * radius;
    const cross = ux * n2x + uz * n2z;
    const alpha = Math.abs(cross) > 1e-6 ? (exitLine + this.into * radius - beta * (n1x * n2x + n1z * n2z)) / cross : 0;
    this.cx = vertex.x + ux * alpha + n1x * beta;
    this.cz = vertex.z + uz * alpha + n1z * beta;
    // Where the arc meets the lines: in (t1) and out (t2), as distances along each leg from the vertex
    this.t1 = { x: this.cx - n1x * this.into * radius, z: this.cz - n1z * this.into * radius };
    this.t2 = { x: this.cx - n2x * this.into * radius, z: this.cz - n2z * this.into * radius };
    this.turnIn = -((this.t1.x - vertex.x) * ux + (this.t1.z - vertex.z) * uz); // m before the vertex the arc starts
    this.turnOut = (this.t2.x - vertex.x) * vx + (this.t2.z - vertex.z) * vz; // m past it the arc ends
    this.length = Math.abs(this.turn) * radius;
  }

  /**
   * Where (x, z) is on the path: phase 'entry' | 'arc' | 'exit'; `out`, m off the path to the outside of the turn
   * (- inside, toward the corner); `heading`, the path's direction there; `progress`, the share of the turn made
   * (0 at the arc's start, 1 at its end); `toGo`, m of path left to the arc's end.
   */
  locate(x, z) {
    const { ux, uz, vx, vz, into } = this;
    const before = (x - this.t1.x) * ux + (z - this.t1.z) * uz;
    const after = (x - this.t2.x) * vx + (z - this.t2.z) * vz;
    // (the arc's sweep from its start, round the centre)
    const start = Math.atan2(this.t1.x - this.cx, this.t1.z - this.cz);
    // (a left turn swings the bearing from the centre the same way as the heading: up)
    const swept = wrap(Math.atan2(x - this.cx, z - this.cz) - start) * into;
    const total = Math.abs(this.turn);
    if (before < 0 && !(swept > 0 && swept < total)) {
      const lateral = (x - this.t1.x) * uz - (z - this.t1.z) * ux;
      return { phase: 'entry', out: -into * lateral, heading: Math.atan2(ux, uz), progress: 0, toGo: -before + this.length };
    }
    if (after > 0 || swept >= total) {
      const lateral = (x - this.t2.x) * vz - (z - this.t2.z) * vx;
      return { phase: 'exit', out: -into * lateral, heading: Math.atan2(vx, vz), progress: 1, toGo: -Math.max(0, after) };
    }
    const r = Math.hypot(x - this.cx, z - this.cz);
    const share = Math.max(0, Math.min(1, swept / total));
    return {
      phase: 'arc', out: r - this.radius, heading: Math.atan2(ux, uz) + this.turn * share, progress: share,
      toGo: (1 - share) * this.length
    };
  }

  // The path's poses every `step` m: `entry` m of the entry line, the arc, `exit` m of the exit line. Each is
  // { x, z, heading, phase }.
  poses(step, entry, exit) {
    const out = [];
    const { ux, uz, vx, vz } = this;
    for (let d = entry; d > 0; d -= step) out.push({ x: this.t1.x - ux * d, z: this.t1.z - uz * d, heading: Math.atan2(ux, uz), phase: 'entry' });
    const start = Math.atan2(this.t1.x - this.cx, this.t1.z - this.cz);
    const count = Math.max(2, Math.ceil(this.length / step));
    for (let i = 0; i <= count; i++) {
      const share = i / count;
      const bearing = start + this.turn * share;
      out.push({
        x: this.cx + Math.sin(bearing) * this.radius, z: this.cz + Math.cos(bearing) * this.radius,
        heading: Math.atan2(ux, uz) + this.turn * share, phase: 'arc'
      });
    }
    for (let d = step; d <= exit; d += step) out.push({ x: this.t2.x + vx * d, z: this.t2.z + vz * d, heading: Math.atan2(vx, vz), phase: 'exit' });
    return out;
  }

  /** How many outline points of the car's body, turned as a drift turns it along the path, are off `road` */
  offRoad(road, options = CORNER_FIT) {
    const o = { ...CORNER_FIT, ...options };
    let off = 0;
    for (const pose of this.poses(o.sampleStep, o.entryCheck, o.exitCheck)) {
      const slips = pose.phase === 'arc' ? o.arcSlips : pose.phase === 'entry' ? o.entrySlips : o.exitSlips;
      for (const slip of slips) off += road.footprintOff(pose.x, pose.z, pose.heading + this.into * slip, o.reserve);
    }
    return off;
  }
}

/**
 * The widest drifted corner the road has room for. corner: { vertex, ux, uz, vx, vz } (the route's legs in and out);
 * lines: { entry, exit, entryInside, exitInside }, the outside lines the street's corridors give (m, + left of each
 * leg) and the inside edges; road: { footprintOff(x, z, heading, margin) }. Tries the entry and exit lines from the
 * outside in (lineSteps) and the radius from the widest the two streets allow down (radiusStep): the first whose whole
 * path keeps the turned body on the road. Returns a CornerPath, `fits` false when none does (the tightest one then, the
 * show still goes round).
 */
function fitCorner(corner, lines, road, options = {}) {
  const o = { ...CORNER_FIT, ...options };
  const turn = wrap(Math.atan2(corner.vx, corner.vz) - Math.atan2(corner.ux, corner.uz));
  const into = Math.sign(turn) || 1;
  let best = null;
  for (const entryStep of o.lineSteps) {
    for (const exitStep of o.lineSteps) {
      // (in from the outside: toward the inside, + left for a left turn)
      const entryLine = lines.entry + into * entryStep;
      const exitLine = lines.exit + into * exitStep;
      // The widest arc clear of the inside corner by insideClearance: a and b the room from each line to there
      const a = Math.max(1, into * (lines.entryInside - entryLine) - o.insideClearance);
      const b = Math.max(1, into * (lines.exitInside - exitLine) - o.insideClearance);
      const widest = Math.min(o.maxRadius, a + b + Math.sqrt(2 * a * b));
      for (let radius = widest; radius >= o.minRadius - 1e-6; radius -= o.radiusStep) {
        const path = new CornerPath({ ...corner, entryLine, exitLine, radius });
        // (no wider than one already found: the outer lines go first, so a tie keeps them)
        if (best?.fits && radius <= best.radius + 1e-6) break;
        const off = path.offRoad(road, o);
        if (off === 0) {
          path.fits = true;
          best = path;
          break;
        }
        if (!best || (!best.fits && off < best.off)) {
          path.fits = false;
          path.off = off;
          best = path;
        }
      }
    }
  }
  return best;
}

/**
 * The fitted corner (fitCorner) tightened to `radius` (the arc a slide at the speed the car has takes: R = v² / grip),
 * on the same lines; the fitted one itself if that's no tighter, or if the tighter one doesn't keep the body on the
 * road. A slide slower than its arc was planned for turns inside it: 8th Ave into 57th St at 17 m/s on a 46 m arc
 * ran 12 m inside it, over the curb.
 */
function sizeCorner(fitted, radius, road, options = {}) {
  const tighter = Math.max(options.minRadius ?? CORNER_FIT.minRadius, radius);
  if (tighter >= fitted.radius - 0.5) return fitted;
  const path = new CornerPath({ ...fitted, radius: tighter });
  if (path.offRoad(road, options) > 0) return fitted;
  path.fits = fitted.fits;
  return path;
}

// The slide round a fitted corner, driven as the show's donuts are (swim-show.js DonutDriver): a few times a second it
// weighs each thing it could do with its hands and feet (the wheel into the turn, let go or counter-steering, W down or
// up, a dab of the handbrake), plays each a moment ahead on the car's own physics through a copy of its keyboard driver
// and of its hands, and takes the one that keeps the car on the path, its body on the road and the slide alive until
// the turn is nearly made, then lets the slide unwind onto the new street. A rule on the angle alone held no line: the
// slide's line is whatever its speed and angle make of it, and the tail went over the inside curb (Codex #4).
const CORNER_DRIVE = {
  wheels: [1, 0.5, 0, -0.5, -1], // shares of lock it tries (+ into the turn, - counter-steer)
  handbrakes: [0], // and the handbrake (a dab mid-slide over-rotated it: 58°, 5 m/s, circling the crossing)...
  fromTurnIn: true, // it drives the corner from the turn-in, flick and all (not from after a scripted kick: braking
  // for 57th St the car stepped 15° the wrong way, and the kick threw it into a slide the wrong way round),
  kickHandbrakes: [0, 1], // ...with the handbrake to break the rear loose on the way in (the entry line's last
  kickShare: 0.25, // preRotate m and this share of the turn), and the brake on the entry line
  preRotate: 8, // m before the arc where the slide may start (the car turns in a moment before its arc)
  braking: 9.5, // m/s² of braking its speed on the entry line is reckoned against
  overCost: 4, // per (m/s)² over the speed it can still brake to the corner's from where it is
  decideEvery: 0.1, // s between choices
  horizon: 1.2, // s it looks ahead
  pedalTime: 0.3, // s a lift off W lasts in its look ahead, before W goes down again
  physicsStep: 1 / 240, // s per look-ahead physics step (the swim car's own, swim-car.js)
  roadEvery: 2, // look-ahead frames between the checks of its body against the road
  reserve: 0.4, // m round the body that counts as off the road in the look ahead (the corner's own reserve, CORNER_FIT)
  pathCost: 1, // per m² off the path, per frame
  headingCost: 3, // per (10°)² the way it travels is off the path's direction, per frame (the position and the yaw
  // together: near the line but crossing it is no better than off it)
  roadCost: 300, // per outline point off the road, per check (at 40 and 150 the slide's angle won: tails over the curb)
  slideUntil: 0.9, // share of the turn it keeps the slide alive to (musa's corners slide over 49-100% of the turn, for
  // 0.9-4 s: eval-loop/fixes/harness/drift-calibration.json; at 0.8 and 22° the offline run's corners slid 49-65%)
  minAngle: 26 * RAD, // the slide's angle it keeps to before then,
  maxAngle: 45 * RAD,
  deadCost: 15, // per (10°)² short of it, per frame
  spinCost: 20, // per (10°)² past it
  exitAngle: 12 * RAD, // past slideUntil, the slide's angle beyond which it costs (unwinding onto the new street)
  exitCost: 3, // per (10°)² past it
  crawlShort: 4, // m/s under the corner's speed below which the slide is a crawl
  crawlCost: 3 // per (m/s)² under it
};

const PEDALS = ['W', '-']; // W down, or off both pedals
const PEDALS_IN = ['W', '-', 'S']; // ...or the brake, on the way in

// The car's own numbers (what stepDriftCar and the keyboard driver read and write), copied for a look-ahead
function snapshotCar(car, into = {}) {
  for (const key in car) {
    const value = car[key];
    if (typeof value === 'number' || typeof value === 'boolean') into[key] = value;
  }
  into.position = { x: car.position.x, z: car.position.z };
  into.drift ??= {};
  return into;
}

function restoreCar(snapshot, into) {
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

class CornerDriver {
  // tools: { stepDriftCar, steeringKey, Hands } (drift-physics.js, drift-autopilot.js: handed in, as drift-autopilot.js
  // imports this module); road: { footprintOff }
  constructor(tools, road, options = {}) {
    this.tools = tools;
    this.road = road;
    this.o = { ...CORNER_DRIVE, ...options };
    this.sinceChoice = Infinity;
    this.choice = null;
  }

  // The choice for this moment (re-weighed every decideEvery): { wheel (share of lock, + left as the driver's steer),
  // forward (W), handbrake }
  update(car, dt, driver, hands, path, speed) {
    this.speed = speed; // m/s the corner is planned at
    this.sinceChoice += dt;
    if (!this.choice || this.sinceChoice >= this.o.decideEvery - 1e-9) {
      this.choice = this.choose(car, driver, hands, path, dt);
      this.sinceChoice = 0;
    }
    return this.choice;
  }

  choose(car, driver, hands, path, frame) {
    const o = this.o;
    const { stepDriftCar, steeringKey, Hands } = this.tools;
    const model = driver.model;
    const base = this._base = snapshotCar(car, this._base);
    const sim = this._sim ??= snapshotCar(car);
    sim.drift ??= {};
    const keys = this._keys ??= { forward: 0, backward: 0, left: 0, right: 0, handbrake: 0 };
    const simHands = this._simHands ??= new Hands();
    const telemetry = this._telemetry ??= {};
    const frames = Math.max(1, Math.round(o.horizon / frame));
    const substeps = Math.max(1, Math.round(frame / o.physicsStep));
    const step = frame / substeps;
    const into = path.into;
    // (on the way in: the handbrake to flick it, and the brake)
    const now = path.locate(car.position.x, car.position.z);
    const entering = now.phase === 'entry' || (now.phase === 'arc' && now.progress < o.kickShare);
    const handbrakes = o.fromTurnIn && entering ? o.kickHandbrakes : o.handbrakes;
    const pedals = o.fromTurnIn && now.phase === 'entry' ? PEDALS_IN : PEDALS;
    let best = null;
    for (const wheel of o.wheels) for (const pedal of pedals) for (const handbrake of handbrakes) {
      const forward = pedal === 'W' ? 1 : 0;
      const brake = pedal === 'S' ? 1 : 0;
      restoreCar(base, sim);
      const simDriver = this._simDriver = copyDriver(driver, this._simDriver);
      simHands.copyFrom(hands);
      let cost = 0;
      for (let f = 0; f < frames; f++) {
        const t = f * frame;
        const key = steeringKey(simDriver, wheel * into, sim.speed, frame, simHands);
        keys.left = key > 0 ? 1 : 0;
        keys.right = key < 0 ? 1 : 0;
        keys.forward = t < o.pedalTime ? forward : 1;
        keys.backward = t < o.pedalTime && brake && sim.speed > 1 ? 1 : 0;
        if (keys.backward) keys.forward = 0;
        keys.handbrake = t < o.decideEvery ? handbrake : 0;
        const input = simDriver.update(sim, simHands.press(keys, frame), frame);
        for (let i = 0; i < substeps; i++) stepDriftCar(sim, input, step, model, telemetry);
        cost += this.cost(sim, path, f);
      }
      if (!best || cost < best.cost) best = { cost, wheel: wheel * into, forward, brake, handbrake };
    }
    return best;
  }

  // The cost of one look-ahead frame's pose
  cost(sim, path, frame) {
    const o = this.o;
    const at = path.locate(sim.position.x, sim.position.z);
    let cost = o.pathCost * at.out * at.out;
    if (frame % o.roadEvery === 0) cost += o.roadCost * this.road.footprintOff(sim.position.x, sim.position.z, sim.heading, o.reserve);
    const sin = Math.sin(sim.heading), cos = Math.cos(sim.heading);
    const vx = sin * sim.speed + sim.vx, vz = cos * sim.speed + sim.vz;
    const ground = Math.hypot(vx, vz);
    // (the slide's angle into the turn: the nose turned past the way the car is going)
    const angle = ground > 2 ? wrap(sim.heading - Math.atan2(vx, vz)) * path.into : 0;
    const toArc = at.phase === 'entry' ? at.toGo - path.length : 0; // m still to the arc's start
    if (at.phase === 'entry') {
      // (on the entry line: no faster than it can brake to the corner's speed by the arc)
      const over = Math.max(0, ground - Math.sqrt((this.speed ?? 15) ** 2 + 2 * o.braking * toArc));
      cost += o.overCost * over * over;
    }
    if (at.phase === 'entry' && toArc > o.preRotate) {
      // (straight on the way in)
    } else if (at.phase !== 'exit' && at.progress < o.slideUntil) {
      const dead = Math.max(0, o.minAngle - angle) / (10 * RAD);
      const spin = Math.max(0, angle - o.maxAngle) / (10 * RAD);
      cost += o.deadCost * dead * dead + o.spinCost * spin * spin;
    } else {
      const over = Math.max(0, Math.abs(angle) - o.exitAngle) / (10 * RAD);
      cost += o.exitCost * over * over;
    }
    const heading = wrap(Math.atan2(vx, vz) - at.heading) / (10 * RAD);
    cost += o.headingCost * heading * heading;
    const crawl = Math.max(0, (this.speed ?? 15) - o.crawlShort - ground);
    return cost + o.crawlCost * crawl * crawl;
  }
}

export { CORNER_DRIVE, CORNER_FIT, CornerDriver, CornerPath, fitCorner, sizeCorner };
