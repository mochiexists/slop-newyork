import { M5_DRIFT, fullDriveForce, stepDriftCar } from './drift-physics.js';
import { CornerDriver, copyDriver, fitCorner, restoreCar, sizeCorner, snapshotCar } from './drift-corner.js';

// The AI driver for swimming: it presses the player's keys (W, S, A, D, the handbrake), one frame at a time, through
// the car's own KeyboardDriver, to follow a route along the streets as fast as the corners allow, handbrake-flick into
// a drift at every sharp corner, and swim through the traffic ahead, threading the gaps between cars. It can do
// nothing a player at the keyboard couldn't: it decides the wheel and pedal it wants, then taps the keys that bring the
// driver's wheel and pedal there (it watches them, as a player watches their wheel). Pure and DOM-free, for tests.

const RAD = Math.PI / 180;
const GRAVITY = 9.81;
const ALONG_STREET = 15 * RAD; // travelling this close to the street's direction counts as running along it
const MIN_PEDAL = 0.05; // pedal below which the traction control's share of it isn't read
const MIN_PASSED = 0.1; // least share of the pedal it reckons the traction control passes on
const NO_HOLD = [0]; // a split or a step along its own line is flown at once
const NO_TRAFFIC = []; // a plan flown again sees the traffic its planner saw, not this (flyPlan)
const SAFE_RANK = 1e6; // a plan clear on the sketch ranks above every one that isn't (planGap's shortlist)
const COMMIT_CLEARANCE = 0.05; // share of the lock it keeps short of the keyboard driver's power-over lock, swimming
const COAST = 'coast'; // the pedal plan off both pedals (a lift)
const FLINCH_MARGIN = 0.3; // m a driver adds round both cars, reckoning whether the swimmer will hit it (traffic.js)
const CRAWL_BRAKE = 0.6; // m/s below which the brake key isn't pressed (it would reverse): it stops the car otherwise,
const SAME_WAY = Math.cos(45 * RAD); // a car headed within this of the street's direction is going its way
const CRAWL_HOLD = 0.3; // ...holding it on the handbrake below this (drift-physics.js holds a braked car still there)
const BRAKE_TAP = 0.05; // s of full brake: the least a tap of the brake key is worth (taps and holds, not a 60 Hz duty)
const GAS_TAP = 0.02; // s × pedal: the pedal a tap of W is worth before it is let go

const AUTOPILOT = {
  cruiseSpeed: 38, // m/s on the straights (85 mph)
  cornerSpeed: 20, // m/s it takes a drifted corner at, at most (shapeCorner: the streets' room sets each one's speed)
  braking: 9.5, // m/s² it plans to brake at before a corner (the brake key holds 10.3: it brakes late and hard)
  turnGrip: 8.8, // m/s²: the lateral grip a drifted corner's arc is planned with (0.9 g), which sets its speed
  minRadius: 12, // m: the tightest and widest arcs it plans a drifted corner on
  maxRadius: 60,
  minTurnIn: 8, // m short of the corner it turns in at least (where the arc starts: turned in earlier, by 0.15-0.5 s
  // of its speed, the roam's corners cut into the inside block)
  centreAllowance: 2, // m past a two-way street's centre line it lines up or drifts out to, at most (at 1, a right turn
  // into 42nd St came out of its tighter arc onto the north sidewalk)
  sharpTurn: 40 * RAD, // corners sharper than this are drifted
  kickTime: 0.18, // s of handbrake to break the rear loose (0.25 over-rotated the slide on a player's keys)
  kickSteer: 0.25, // share of the lock the wheel is wound on to before the handbrake flick
  driftAngle: 35 * RAD, // drift angle it holds through a corner (the yaw it carries out of the flick peaks ~8° past it)
  angleGain: 1 / (10 * RAD), // share of the lock per radian of drift angle short of (into the turn) or past (counter-steer) it
  slipLead: 0.35, // s ahead it reads the drift angle from how fast it is swinging
  counterLock: 1, // share of the lock it counter-steers with at most (with no key the wheels self-align and the fronts
  // still bite into the turn: catching the flick's swing takes the counter-steer key, drift-physics.js)
  slipRateFilter: 20, // 1/s: how quickly its feel for that swing follows the car
  liftAngle: 10 * RAD, // read ahead this far past the angle it wants, it lifts off W
  slideSpeedMargin: 2, // m/s over the corner's speed it lets a slide run: the gas comes off as the slide's ground speed
  // rises to it (a faster slide is a wider one)
  driftThrottleGain: 0.5, // share of the pedal per m/s under that
  exitTurn: 70 * RAD, // turn still to go below which it asks for less angle, down to none on the new street's line:
  // over most of the corner, so the slide is coming back in as the car comes round (at 20° the roam's corners
  // over-rotated and drove on 20-30 m into the block beyond, 33 samples off the roadway in 220 s; at 50° 16, at 70° 2)
  // (and still lifts as the slide swings past that: holding the gas there gained 0.04 s back to speed in the sims and
  // ran a drift into 57th St wide into a storefront in the browser)
  cornerDrive: {}, // with a road: the look-ahead that drives the slide round the fitted corner (drift-corner.js
  // CORNER_DRIVE), options over its own
  releaseAngle: 14 * RAD, // coming out, the counter-steer is let go below this angle
  exitLead: 0.3, // s ahead it reads the turn still to go from the car's yaw rate
  exitSlip: 6 * RAD, // drift angle below which the corner is done (swimSlip: the swimming then keeps W down),
  exitAlign: 20 * RAD, // ...travelling this close to the new street's direction
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
  yawSettle: 0.5, // s: in a plan, how quickly the car straightens from the angle it is turned at now (the wheel's lag
  // and the yaw damping catching a flick),
  yawCarry: 0.25, // ...after swinging on at its yaw rate for this long (the wheel takes that to catch it)
  yawLead: 2, // ...and how far its nose is turned in a move across, as a share of the angle it travels across at (in a
  // flick at 85 mph the nose leads: 12° at 8° of travel, the tail stepping out a little)
  passMargin: 0.35, // m of air it leaves between itself and a car it passes (a swimmer's margin, not a driver's)
  followMargin: 1.5, // m it leaves to a bumper it closes on
  gapStep: 0.75, // m between the lateral positions it tries
  thenStride: 2, // ...and every this many of them it tries moving on to past a split (every other one: a plan on a
  // street of rows takes a third less time, ~13 ms, and splits as many)
  pedals: [-9.5, -6, -3, 0, 3.5, 7, 10.5], // m/s² it tries for pedalTime: stamp on it, brake, ease off, hold, push, floor it
  // (10.5: all the M xDrive puts down off the line; it is traction- and power-limited above that anyway)
  coastPedal: true, // it also tries lifting off both pedals (the drag and the tires' rolling slow it: ~0.5 m/s² at 85 mph)
  brakeMoveCost: 3, // score per metre a plan moves across with the brake key down: it brakes straight, then flicks
  pedalTime: 1, // s on the pedal before holding the speed it reached
  planTime: 2.5, // s it looks ahead
  planStep: 0.1,
  flickRate: 0.32, // lateral speed it moves across at, as a share of its speed (quick flicks)...
  maxLateralSpeed: 10, // ...up to this many m/s,
  crawlAcross: 0.58, // ...and no more than this share of its speed along the street (pointing 30° across it)
  lateralAccel: 6, // m/s² it plans to shed its sideways speed at by the far side of a move (the tires hold about 1 g,
  // and the car has to turn back straight there)
  lateralSwing: 6, // m/s² its sideways speed swings toward the move's at: the wheel winding on, the car turning to it
  swimSlip: 6 * RAD, // slip past which a swimming flick lifts off the gas until the tail is back in line
  slipCatch: 0.75, // wheel angle per radian of slip it counter-steers with, swimming
  slideSpeed: 8, // m/s below which the body's slip is the geometry of a slow turn (about 10° on the lock at a crawl),
  // not a slide: the swimming neither lifts for it nor counter-steers it, or a crawl off a curb never gets going again
  swimLock: 0.6, // share of the lock it swims with at most: the tires' grip peaks there (about 1.1 g) at any speed
  planSpread: 0.1, // m the passing margin widens by per metre a plan has moved across: how far a move on the keys
  // drifts off the line it was planned on (the lane-change probe: about half a metre over a 3-lane swing)
  settleTime: 0.5, // s it closes the last of a move in (the sideways speed falls off linearly over the last metre)
  yawDamping: 0.05, // s: wheel angle taken off per rad/s the car is turning, swimming (catches a flick as it arrives)
  steerLead: 0.15, // s ahead it reads the gap to its line from its sideways speed: the wheel's lag, swimming
  moveCost: 1.2, // score (m of ground) per metre moved across: it doesn't swerve for nothing
  lineUpDistance: 150, // m before a drifted corner where it lines up on its entry line: before it brakes (moving across
  // with the brake key down steps the tail out) and turns in (still moving across then, the slide runs wide),
  lineUpTime: 6, // ...or this many seconds of its speed before it, if more (at 80 mph, 150 m left a move across two
  // lanes still going as it braked: it ran on 5 m past its line, over 8th Ave's curb into 57th St)
  lineUpCost: 40, // score per metre off that line: whenever a plan there is safe, it takes it
  entryMargin: 1.5, // m in from the street's outside edge that it lines up on for a drifted corner (the widest arc)
  holds: [0, 0.4], // s it tries holding its line before a move across: at once, or a late flick
  holdLateral: 1, // m/s of sideways speed past which it is already moving across: no holding where it is
  holdLockout: 1, // s after a late flick goes in which it doesn't hold again
  lateWindow: 1, // s: a move that starts within this of coming alongside the car on its line is a late flick,
  lateBonus: 8, // ...worth this much score (the swerve the player wants, not an early lane change)
  commitBonus: 6, // score for keeping the gap it already chose, so it doesn't dither,
  commitShare: 0.2, // ...or this share of the biggest bonus in play (close call, split, late flick), if more
  reverseLock: 0.5, // s after a move across starts that turning it back costs reverseCost
  reverseCost: 30,
  replanInterval: 0.12, // s between decisions
  speedGain: 2, // 1/s: how hard it closes a gap between the planned speed and its own
  openWeight: 0.5, // score per metre of open road ahead where a plan ends up
  speedWeight: 1.5, // score per m/s it carries out of a plan
  closeBonus: 3, // score for a close call (swim-mode.js CloseCalls): a swimmer cuts it close
  closeGap: 1, // m of air at most beside a car passed for a close call,
  closeSpeed: 8, // m/s at least it passes it by,
  splitWindow: 0.8, // s between close calls on either side that make a split (threading two cars)
  splitBonus: 4, // score for a split, on top of its two close calls
  splitAlong: 5, // m apart along the street at most that two cars count as side by side, a gap to split,
  splitRoom: 0.4, // m of room at least it leaves beyond its margins (on the keys it can't hold a line to the centimetre)
  splitLineUp: 0, // score per metre a plan ends off the gap of the nearest pair to split ahead (0: it doesn't seek them)
  keepSpeedWeight: 12, // score per m/s a plan slows below keepSpeed (set while the show counts down the hand-over)
  brakeSteerLoss: 0.6, // share of the sideways grip lost to the brake key held down (all or nothing: 1.05 g)
  queueSpeed: 2, // m/s: below this, behind a car no faster this close ahead in its line, it is waiting in a queue
  queueGap: 6, // m of bumper-to-bumper gap
  queueReach: 60, // m ahead a car standing in its line makes the oncoming half free to use (oncomingCost)
  // A red light's queue standing across its line (redLeft: s of red still to come at the light ahead, which the show
  // reads off the city's clock): it rolls up to the queue's tail timed to reach it as the queue moves off, rather than
  // standing behind it for the rest of the red (Midtown's lights change together: on an avenue it meets a red queue
  // about once a minute, and stood 32 s at each in the baseline runs)
  creepDischarge: 3, // s after the green that the tail of a queue moves off
  creepMin: 1.4, // m/s it creeps at, at least (a walking pace: not standing)
  wayRoundReach: 20, // m ahead it looks for a way round something it is stopped behind (wayRound)
  pullSpeed: 4, // m/s it pulls round at (pullRound),
  pullAim: 8, // ...aiming at the line round this far ahead,
  pullTime: 3, // ...for this long at most,
  pullDone: 0.5, // ...or until it is this close to the line round,
  pullStraight: 6 * RAD, // ...and this straight along the street
  // Traffic flinches (traffic.js react): a driver the swimmer is aimed at, straight on as both go, within flinchNotice s
  // of a hit, reacts once that has lasted its reaction time (0.6-1 s): floors it or brakes, and swerves. Then the gap it
  // was threading moves into it. A plan that stays aimed at a car flinchTime or more costs flinchCost.
  flinchNotice: 1.8,
  flinchTime: 0.6,
  flinchCost: 20,
  flinchHorizon: 1.2, // s of each plan it checks that over
  hitCost: 200, // score against a plan that touches a car
  // A plan inside its passing margins of a car but with squeezeMargin of real air left is a squeeze: worse than any
  // plan clear of the margins, better than one that touches (with every plan inside the margins, "the one that meets
  // trouble latest" was a line straight behind the car being passed, braking: it rear-ended it at 16 m/s)
  squeezeMargin: 0.1,
  squeezeCost: 150,
  // Its best few safe plans are flown again before it takes one: its own keys through a copy of the keyboard driver,
  // its hands and the car's physics (the plans' lateral flight is a sketch of that), against traffic that may speed up
  // by trafficGas or brake by trafficBrake and drift across by trafficDrift m/s, the boxes swept tick by tick. The best
  // that clears every car by verifyMargin is the one it flies (Codex 2026-11-03 #5: fresh-s1's contacts came from plans
  // marked safe on the sketch)
  verifyPlans: 3, // plans it checks (0: none)
  verifyTime: 1.2, // s it flies each
  verifyEvery: 2, // ticks between the checks against the traffic
  verifyMargin: 0.12, // m of air below which a flown plan touches a car
  trafficGas: 2, // m/s²: a driver's IDM pick-up (traffic.js), and its flinch's floor-it is 3 s from now at most
  trafficBrake: 4,
  trafficDrift: 0.4, // m/s across
  splitLockout: 1, // s a split it gave up on (the pair still ahead) is not tried again
  openingWeight: 8, // score per m/s a split's gap is opening (its pair moving apart; closing, against)
  oncomingCost: 25 // score against the oncoming half of a two-way street: used to pass, not to cruise in
};

// The AI's hands on the keys. Every key the AI presses (the swimmer, the show's donuts and its backing out, the cop)
// goes through a Hands, so it presses them as a player's fingers can: a key once pressed, or let go, stays that way
// for at least minHold (a quick tap on a keyboard), and changes at most maxRate times in any second. Without it the
// AI picked each key afresh every frame: A and D changing 21 times a second and W 8, one-frame presses, the brake
// pulsed at 60 Hz. That is pulse-width modulation, an analog wheel and pedal and an ABS on a keyboard, which no
// player has (review 2026-11-01, finding 1).
const HANDS = {
  minHold: 0.08, // s a key stays down, or up, at least
  maxRate: 6, // changes of one key in any second at most
  changeCost: 0.02 // share of the lock a steering change has to gain over keeping the key it holds (no fidgeting)
};
const KEY_NAMES = ['forward', 'backward', 'left', 'right', 'handbrake'];
const TIME_EPSILON = 1e-6;

class Hands {
  constructor(options = {}) {
    this.o = { ...HANDS, ...options };
    this.keys = { forward: 0, backward: 0, left: 0, right: 0, handbrake: 0 };
    this.lastChange = {}; // per key: the clock's time it last changed
    this.recent = {}; // per key: the clock's times of its changes within the last second
    this.reset();
  }

  reset() {
    this.clock = 0;
    for (const key of KEY_NAMES) {
      this.keys[key] = 0;
      this.lastChange[key] = -Infinity;
      this.recent[key] = [];
    }
    return this;
  }

  // The same hands in another body: a look-ahead plays its keys through a copy, so it plans presses it can make
  copyFrom(other) {
    this.o = other.o;
    this.clock = other.clock;
    for (const key of KEY_NAMES) {
      this.keys[key] = other.keys[key];
      this.lastChange[key] = other.lastChange[key];
      const recent = this.recent[key];
      recent.length = 0;
      for (const time of other.recent[key]) recent.push(time);
    }
    return this;
  }

  // Whether a key may change now: held its state for minHold, and fewer than maxRate changes in the last second
  free(key) {
    if (this.clock - this.lastChange[key] < this.o.minHold - TIME_EPSILON) return false;
    const recent = this.recent[key];
    while (recent.length && this.clock - recent[0] >= 1 - TIME_EPSILON) recent.shift();
    return recent.length < this.o.maxRate;
  }

  // Whether a key could be in `state` after this frame
  reaches(key, state) {
    return this.keys[key] === state || this.free(key);
  }

  // The steering key down now: +1 A (left), -1 D (right), 0 neither
  get steering() {
    return this.keys.left - this.keys.right;
  }

  // Whether the steering can be `key` (+1, -1, 0) after this frame: the other key up, this one down
  canSteer(key) {
    return this.reaches('left', key > 0 ? 1 : 0) && this.reaches('right', key < 0 ? 1 : 0);
  }

  change(key, state) {
    if (this.keys[key] === state || !this.free(key)) return;
    this.keys[key] = state;
    this.lastChange[key] = this.clock;
    this.recent[key].push(this.clock);
  }

  // One frame `dt` long: the keys it wants down (each 0 or 1), as far as the hands can follow. Returns its keys (the
  // same object each call). A and D are never down together, nor W and S (gas and brake together at a stop is a burnout):
  // a key waits until the other one has come up.
  press(wanted, dt) {
    this.clock += dt;
    const want = (key) => (wanted[key] ? 1 : 0);
    // (releases first, so the other key of a pair can go down in the same frame)
    for (const key of KEY_NAMES) if (!want(key)) this.change(key, 0);
    if (want('left') && !want('right') && !this.keys.right) this.change('left', 1);
    if (want('right') && !want('left') && !this.keys.left) this.change('right', 1);
    if (want('forward') && !this.keys.backward) this.change('forward', 1);
    if (want('backward') && !this.keys.forward) this.change('backward', 1);
    if (want('handbrake')) this.change('handbrake', 1);
    return this.keys;
  }
}

const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// The sideways speed a move across the street wants `gap` metres short of its line: as quick as it may go (`maxSpeed`),
// but no quicker than it can shed at `accel` by the line, so it arrives with none left. The planner flies its moves on
// it and the wheel steers the car onto it (decide), so the car moves across the way its plan did.
// The last few tenths of a metre it closes in `settle` seconds, gently, or the wheel hunts either side of the line.
function acrossSpeed(gap, accel, maxSpeed, settle) {
  const distance = Math.abs(gap);
  return Math.sign(gap) * Math.min(maxSpeed, Math.sqrt(2 * accel * distance), distance / settle);
}

// Seconds until a box `ahead` m in front and `across` m to the side (+ left), closing at `closing` m/s along and moving
// `sideways` m/s toward it (the swimmer's sideways speed less its own), would overlap one `reachAlong` × `reachAcross`
// (half extents summed) about it; Infinity if not within `horizon`. Both keeping on straight, as traffic.js's drivers
// reckon it (threatTime).
function timeToHit(ahead, across, closing, sideways, reachAlong, reachAcross, horizon) {
  // (each axis in turn: the time span its gap is closed; the hit is where both spans meet. It runs in the planner's
  // innermost loop, so no arrays)
  let enter = 0, exit = horizon;
  if (Math.abs(closing) < 1e-6) {
    if (Math.abs(ahead) >= reachAlong) return Infinity;
  } else {
    const t0 = (ahead - reachAlong) / closing, t1 = (ahead + reachAlong) / closing;
    enter = Math.max(enter, Math.min(t0, t1));
    exit = Math.min(exit, Math.max(t0, t1));
  }
  if (Math.abs(sideways) < 1e-6) {
    if (Math.abs(across) >= reachAcross) return Infinity;
  } else {
    const t0 = (across - reachAcross) / sideways, t1 = (across + reachAcross) / sideways;
    enter = Math.max(enter, Math.min(t0, t1));
    exit = Math.min(exit, Math.max(t0, t1));
  }
  return enter < exit ? enter : Infinity;
}

// How fast the car slows off both pedals at a speed: its drag and rolling resistance (m/s², negative)
function coastAccel(speed, p) {
  return -(p.dragArea * speed * speed + p.rolling * p.mass * GRAVITY) / p.mass;
}

// The swimmer's own half extent along and across the street, turned `yaw` (rad) off it
function footprintAlong(o, yaw) {
  return o.carHalfLength * Math.abs(Math.cos(yaw)) + o.carHalfWidth * Math.abs(Math.sin(yaw));
}

function footprintAcross(o, yaw) {
  return o.carHalfWidth * Math.abs(Math.cos(yaw)) + o.carHalfLength * Math.abs(Math.sin(yaw));
}

// One step of a move across the street, as the car makes it: its sideways speed swings toward acrossSpeed at no more
// than `swing` m/s² (the wheel winding on and the car turning to it). Returns the new lateral speed.
function slideAcross(lat, vel, goal, dt, accel, maxSpeed, swing, settle) {
  const wanted = acrossSpeed(goal - lat, accel, maxSpeed, settle);
  return vel + clamp(wanted - vel, -swing * dt, swing * dt);
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
    this.keys = { forward: 0, backward: 0, left: 0, right: 0, handbrake: 0 }; // the keys it wants down this frame
    this.hands = new Hands(this.options.hands); // ...and the hands that press them
    this.brakeDebt = 0; // s of full brake it wanted and hasn't pressed yet (- pressed and didn't want)
    this.braking = 0; // the brake key it wants down
    this.gasDebt = 0; // s × pedal it wanted beyond the pedal its W has given (press, below)
    this.gassing = 0; // W it wants down
    this.keepSpeed = 0; // m/s its plans should not slow below (0: no such wish)
    this.redLeft = 0; // s of red still to come at the light ahead on its street (set by the show from the city clock)
    this.path = [];
    this.segment = 0;
    this.offset = 0; // current lateral offset from the route line (m, + left)
    this.targetOffset = 0;
    this.kick = 0; // s of handbrake left in the current drift entry
    this.driftedCorner = -1;
    this.finished = false;
    this.queued = false; // waiting behind a queue (planGap)
    this.creeping = false; // rolling up to a red light's queue (creepSpeed)
    this.clock = 0; // s it has been driving (decide)
    this.flickAt = undefined; // the clock's time a late flick it chose goes
    this.moveWay = 0; // the way its line last moved across (+1 left, -1 right) and when that move started
    this.moveStart = -Infinity;
    this.holdLockUntil = -Infinity; // no new late flick before this (a flick has just gone)
  }

  // corridors: optional per-leg street bounds, see corridor()
  setPath(points, { loop = false, corridors = null } = {}) {
    this.path = loop ? [...points, points[0]] : points.slice();
    this.corridors = corridors;
    this.segment = 0;
    this.driftedCorner = -1;
    this.finished = false;
    // A new route starts fresh: no corner entry, handbrake flick or plan carried over from the last one
    this.turningIn = this.cornering = false;
    this.kick = 0;
    this.plan = null;
    this.pull = null;
    this.flickAt = undefined;
    this.moveWay = 0;
    this.moveStart = -Infinity;
    this.holdLockUntil = -Infinity;
  }

  // Behind a queue standing in the line it is on, with the light still red for redLeft s: the speed that reaches the
  // queue's tail as it moves off (creepDischarge after the green), at least creepMin; Infinity with no such queue. From
  // the cars its last plan saw.
  creepSpeed(car) {
    const o = this.options;
    const seen = this._seen, count = this._seenCount ?? 0;
    if (!(this.redLeft > 0) || !seen || this.path.length < 2) return Infinity;
    const line = this.targetOffset;
    const egoAlong = footprintAlong(o, 0), egoAcross = footprintAcross(o, 0);
    let gap = Infinity;
    for (let i = 0; i < count; i++) {
      const ob = seen[i];
      if (!ob.sameWay || ob.along <= 0 || Math.abs(ob.vAlong) > o.queueSpeed) continue;
      if (Math.abs(ob.lateral - line) > ob.across + egoAcross + o.passMargin) continue;
      gap = Math.min(gap, ob.along - ob.extentAlong - egoAlong);
    }
    if (gap === Infinity || gap > o.scanAhead) return Infinity;
    // (up to its tail and no further)
    if (gap <= o.queueGap) return 0;
    return Math.max(o.creepMin, (gap - o.queueGap) / (this.redLeft + o.creepDischarge));
  }

  // Getting going again after backing out (swim-show.js unstick): the plans it made for where it was, any corner it
  // was in and any move across it had begun are no longer about where the car is
  forgetPlans() {
    this.plan = null;
    this.sincePlan = Infinity;
    this.flickAt = undefined;
    this.moveWay = 0;
    this.moveStart = -Infinity;
    this.holdLockUntil = -Infinity;
    this.turningIn = this.cornering = false;
    this.kick = 0;
    this.cornerChoice = null;
    if (this.cornerDriver) this.cornerDriver.choice = null;
  }

  // Segment geometry: start, unit direction, length
  seg(i) {
    const a = this.path[i], b = this.path[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    return { a, b, ux: dx / length, uz: dz / length, length };
  }

  // Track progress: move on to the next segment once the car is past the end of this one, or round the corner onto the
  // next one (a slide can carry it onto the new street a few metres short of the old one's end: it is on the new street
  // once it is past the corner along it and nearer its line than the old one's)
  advance(car) {
    while (this.segment < this.path.length - 2) {
      const s = this.seg(this.segment);
      const along = (car.position.x - s.a.x) * s.ux + (car.position.z - s.a.z) * s.uz;
      const next = this.seg(this.segment + 1);
      const alongNext = (car.position.x - next.a.x) * next.ux + (car.position.z - next.a.z) * next.uz;
      const offThis = Math.abs((car.position.x - s.a.x) * s.uz - (car.position.z - s.a.z) * s.ux);
      const offNext = Math.abs((car.position.x - next.a.x) * next.uz - (car.position.z - next.a.z) * next.ux);
      const rounded = alongNext > 0 && offNext < offThis && !this.turningIn && this.kick === 0;
      // (never mid-flick: on a short leg the next corner would take over the one it is turning into)
      if ((along < s.length - 2 && !rounded) || this.turningIn || this.kick > 0) break;
      this.segment++;
    }
    const last = this.seg(this.path.length - 2);
    const along = (car.position.x - last.a.x) * last.ux + (car.position.z - last.a.z) * last.uz;
    if (this.segment === this.path.length - 2 && along > last.length - 4) this.finished = true;
  }

  // A point `distance` metres along the route from the car's projection, shifted by the lane offset (or `offset`)
  pointAhead(car, distance, offset = this.offset) {
    let i = this.segment;
    let s = this.seg(i);
    let along = clamp((car.position.x - s.a.x) * s.ux + (car.position.z - s.a.z) * s.uz, 0, s.length) + distance;
    while (along > s.length && i < this.path.length - 2) {
      along -= s.length;
      s = this.seg(++i);
    }
    // Left of the direction of travel is (uz, -ux) in this world (heading 0 faces +z)
    return { x: s.a.x + s.ux * along + s.uz * offset, z: s.a.z + s.uz * along - s.ux * offset };
  }

  // The street either side of the route line on this leg: { left, right } lateral bounds (m, + left), and for a
  // two-way street `centre`, beyond which (to the left) is oncoming traffic. Without corridors: lanes × laneWidth.
  corridor(segment = this.segment) {
    const o = this.options;
    return this.corridors?.[segment] ?? { left: o.lanes * o.laneWidth, right: -o.lanes * o.laneWidth, centre: null };
  }

  // The drifted corner at the end of this leg (turning `turn` rad onto the next), as the streets have room for it: in
  // from the outside of this street (entryLine, entryMargin in from its edge) round to the outside of the next, on the
  // widest arc that clears the inside corner. With a and b the room across the two streets from that line to the inside
  // edge, the arc's radius is a + b + √(2ab) (a 15 m avenue into a two-way cross street: ~40 m), the slide holds
  // √(turnGrip × R) round it (18-20 m/s: research swimming-craft.md §2), and it turns in where the arc starts, R short
  // of the next street's outside line. A two-way street's outside past its centre line is the oncoming half: it uses no
  // more of it than centreAllowance.
  // With a road to fit it to (options.road: swim-carriageway.js), the corner is a path (drift-corner.js fitCorner): those
  // same outside lines and arc, narrowed until the car's whole body, turned as the slide turns it, stays on the road
  // with a reserve round it the whole way (an arc touching the corridor's inside edge put a 40° slide's tail 1 m over the
  // curb, Codex 2026-11-03 #4). The slide then holds to it (decide).
  shapeCorner(turn) {
    const o = this.options;
    const band = this.corridor(), next = this.corridor(this.segment + 1);
    const leftEdge = (b) => (b.centre === null || b.centre === undefined ? b.left : Math.min(b.left, b.centre + o.centreAllowance));
    const right = turn < 0;
    this.entryLine = right ? leftEdge(band) - o.entryMargin : band.right + o.entryMargin;
    // (m across each street from that line to the inside edge, and how far past the corner the next street's line runs)
    const a = Math.max(1, right ? this.entryLine - band.right : band.left - this.entryLine);
    const exitLine = right ? leftEdge(next) - o.entryMargin : next.right + o.entryMargin;
    const b = Math.max(1, right ? exitLine - next.right : next.left - exitLine);
    const beyond = right ? exitLine : -exitLine;
    if (o.road) {
      // (a right turn into a two-way street comes out on its own half: its outside is the oncoming one, and the queue the
      // show holds short of the corner stands there, 26 m out: fresh-s1 stopped nose to nose with it and backed out
      // six times)
      const twoWay = next.centre !== null && next.centre !== undefined;
      const ownHalf = right && twoWay ? Math.min(exitLine, next.centre - o.carHalfWidth - o.passMargin) : exitLine;
      const fitted = this.fittedCorner(ownHalf, right ? band.right : band.left, right ? next.right : next.left);
      // (no wider than the speed it takes the corner at allows: cornerSpeed caps it)
      this.cornerV = Math.min(o.cornerSpeed, Math.sqrt(o.turnGrip * fitted.radius));
      this.sizeCornerPath(this.cornerV);
      return;
    }
    this.cornerPath = this.cornerFit = null;
    const radius = clamp(a + b + Math.sqrt(2 * a * b), o.minRadius, o.maxRadius);
    this.cornerRadius = radius;
    this.cornerV = Math.min(o.cornerSpeed, Math.sqrt(o.turnGrip * radius));
    this.turnInAt = Math.max(o.minTurnIn, radius - beyond);
  }

  // The corner at the end of this leg fitted to the road (once per corner: drift-corner.js fitCorner), from the outside
  // lines shapeCorner gives and the corridors' inside edges
  fittedCorner(exitLine, entryInside, exitInside) {
    const vertex = this.path[this.segment + 1];
    const key = `${this.segment}:${vertex.x}:${vertex.z}`;
    if (this.cornerKey === key && this.cornerFit) return this.cornerFit;
    const s = this.seg(this.segment), next = this.seg(this.segment + 1);
    this.cornerKey = key;
    this.cornerFit = fitCorner({ vertex, ux: s.ux, uz: s.uz, vx: next.ux, vz: next.uz },
      { entry: this.entryLine, exit: exitLine, entryInside, exitInside }, this.options.road, this.options.cornerFit);
    this.cornerPath = null;
    return this.cornerFit;
  }

  // The fitted corner's arc for a slide at `speed` (drift-corner.js sizeCorner), and the entry line and turn-in it sets
  sizeCornerPath(speed) {
    const o = this.options;
    const radius = speed * speed / o.turnGrip;
    if (!this.cornerPath || Math.abs(this.cornerPath.sizedFor - radius) > 1) {
      this.cornerPath = sizeCorner(this.cornerFit, radius, o.road, o.cornerFit);
      this.cornerPath.sizedFor = radius;
    }
    this.entryLine = this.cornerPath.entryLine;
    this.cornerRadius = this.cornerPath.radius;
    this.turnInAt = Math.max(o.minTurnIn, this.cornerPath.turnIn);
  }

  // Swimming: a look a few seconds ahead. Every car nearby is run forward at its own velocity (along the street and
  // across it: a car changing lanes, traffic crossing a junction), and the AI tries each combination of a position
  // across the street and a pedal (brake hard, ease off, hold, floor it). It flies each one forward and keeps the one
  // that covers the most ground without touching anyone. The cars it is threading keep moving while it moves, so it
  // finds the staggered gaps a swimmer uses: pass one car on its left, then dive across in front of the next.
  planGap(car, obstacles, driver = null, dt = 1 / 120) {
    const o = this.options;
    const s = this.seg(this.segment);
    const lx = s.uz, lz = -s.ux; // left of the direction of travel
    const u = Math.max(0, car.speed);
    const carLat = (car.position.x - s.a.x) * lx + (car.position.z - s.a.z) * lz;
    const lateralSpeed = this.lateralSpeed(u);
    // Every plan starts from where the car is and how fast it is already moving across
    const carLatVel = lateralVelocity(car, s.ux, s.uz);

    // Traffic in the street's frame: along (m ahead of the car, centre to centre), across, and both velocities
    // The swimmer's own footprint along and across the street, turned as it is (a flick turns it 10-20°, which widens it
    // by half a metre). In flight it is turned the way the plan moves across, or as it is now while that settles
    // (yawSettle): straight again by the time it reaches a pair a second ahead, it can split them.
    const egoYawSigned = wrap(car.heading - Math.atan2(s.ux, s.uz));
    const egoYaw = Math.abs(egoYawSigned);
    const egoAlong = footprintAlong(o, egoYaw);
    const egoAcross = footprintAcross(o, egoYaw);
    // (a car still swinging turns on for a moment before the wheel catches it: the turn it settles from is the most of
    // now and where its yaw rate carries it over yawCarry)
    const egoYawPeak = Math.max(egoYaw, Math.abs(egoYawSigned + (car.angularVel || 0) * o.yawCarry));
    // (at its widest, however it turns: the half diagonal)
    const egoWidest = Math.hypot(o.carHalfLength, o.carHalfWidth);
    // (entries are pooled: this runs several times a second with dozens of cars)
    const seen = this._seen ??= [];
    const alarms = this._alarms ??= new WeakMap(); // car → s it has been aimed at so far
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
      entry.across = extentAcross;
      entry.extentAlong = extentAlong;
      entry.sameWay = ob.yaw !== undefined && Math.cos(rel) > SAME_WAY;
      entry.ref = ob; // (the car itself: a split it gave up on is known by its pair)
      entry.inside = inside;
      entry.reach = inside ? Math.max(extentAcross + egoAcross, Math.min(reach, Math.abs(lateral - carLat) - 0.05)) : reach;
      // (the most it reaches across in any flight: see the footprint in the flight below)
      entry.widestReach = inside ? entry.reach : extentAcross + egoWidest + o.passMargin;
      // How long the car has been aimed at it already, as the driver in it sees the swimmer coming (straight on as it
      // goes: within flinchNotice of hitting it). Kept per car between decisions, from what it can see of them.
      if (o.flinchCost > 0) {
        const toHit = timeToHit(along, lateral - carLat, u - entry.vAlong, carLatVel - entry.vLateral,
          extentAlong + egoAlong + FLINCH_MARGIN, extentAcross + egoAcross + FLINCH_MARGIN, o.flinchNotice);
        const before = alarms.get(ob) ?? 0;
        entry.alarm = toHit < o.flinchNotice ? before + Math.min(this.sincePlan ?? 0, o.replanInterval * 2) : 0;
        alarms.set(ob, entry.alarm);
      } else {
        entry.alarm = 0;
      }
      count++;
    }
    this._seenCount = count;
    // Waiting in a queue: barely moving, lined up along the street, a car headed its way just ahead in its line (a red
    // light's queue across every lane). Then the way on is to wait, or thread through if a line opens, not to back out
    // (the show's unstick reads this)
    this.queued = false;
    if (u < o.queueSpeed && egoYaw < ALONG_STREET) {
      for (let i = 0; i < count && !this.queued; i++) {
        const ob = seen[i];
        const gap = ob.along - ob.extentAlong - egoAlong;
        const inLine = Math.abs(ob.lateral - carLat) < ob.across + egoAcross + o.passMargin;
        // (and facing the same way: nose to nose with oncoming cars at their red light it is in the wrong lane. A queue
        // pulling away on the green is still one: backing out then puts it into the queue behind)
        this.queued = ob.along > 0 && gap < o.queueGap && inLine && ob.vAlong > -o.queueSpeed && ob.sameWay;
      }
    }

    const oncoming = band.centre !== null && band.centre !== undefined ? band.centre : Infinity;
    // A queue standing in its line ahead (cars headed its way, stopped or crawling: a red light, a bus at its stop): the
    // oncoming half is the way past it, so it costs nothing then (its plans still meet any car coming the other way). A
    // swimmer never waits at a red with the other half of the street clear.
    let oncomingCost = o.oncomingCost;
    for (let i = 0; i < count && oncomingCost > 0; i++) {
      const ob = seen[i];
      const inLine = Math.abs(ob.lateral - carLat) < ob.across + egoAcross + o.passMargin;
      if (ob.sameWay && inLine && ob.along > 0 && ob.along < o.queueReach && ob.vAlong < o.queueSpeed) oncomingCost = 0;
    }
    let best = null;
    // (and its best few safe plans, best first, for flying again before it takes one)
    const short = this._short ??= [];
    const shortPool = this._shortPool ??= [];
    short.length = 0;
    // (and the best plan on the line it is flying now: flown clean, it is kept, whatever the sketch says)
    const onTarget = this._onTarget ??= {};
    onTarget.rank = -Infinity;
    const keep = Math.max(0, o.verifyPlans);
    const near = this._near ??= [];
    // Per car near the move: the least air beside it while alongside, the side it was on, when the plan passes it
    const air = this._air ??= [];
    const side = this._side ??= [];
    const passedAt = this._passedAt ??= [];
    const aimed = this._aimed ??= []; // s aimed at it (see the flinch below)
    const overshoot = carLatVel * Math.abs(carLatVel) / (2 * o.lateralAccel); // where its sideways speed carries it
    const holdLeft = this.flickAt === undefined ? 0 : this.flickAt - this.clock; // s to a late flick it committed to
    // (the score for keeping its line grows with the bonuses in play: next to a 100-point split, 6 is no margin at all)
    const commit = Math.max(o.commitBonus, o.commitShare * Math.max(o.closeBonus, o.splitBonus, o.lateBonus));
    const cornerBrake = o.braking; // m/s² the executor brakes for a corner at (decide)
    const brakingSideways = o.lateralAccel * (1 - o.brakeSteerLoss * Math.min(1, cornerBrake / (this.model.brakeGrip * GRAVITY)));
    // The lines it tries across the street: one every gapStep, and the middle of every gap between two cars side by
    // side that it fits through (a split: the steps can miss a gap that leaves a hand's width either side). A split
    // leaves it straddling two lanes, so it is flown as two moves: through the gap, and once past the pair (`clear`:
    // where the pair's tails are, and how fast that moves) on to each of the other lines.
    const lines = this._lines ??= [];
    const clear = this._clear ??= [];
    const clearSpeed = this._clearSpeed ??= [];
    const pairs = this._pairs ??= []; // per split line, its pair (right car, left car) and whether its gap is opening
    const opening = this._opening ??= [];
    const lockouts = this._lockouts ??= [];
    for (let i = lockouts.length - 1; i >= 0; i--) if (lockouts[i].until <= this.clock) lockouts.splice(i, 1);
    let lineCount = 0;
    for (let y = band.right; y <= band.left + 1e-6; y += o.gapStep) lines[lineCount++] = y;
    // (lining up for a drifted corner, its entry line too: the steps may miss it)
    if (this.lineUp) lines[lineCount++] = this.entryLine;
    const gridCount = lineCount;
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        const rightCar = seen[i], leftCar = seen[j];
        if (leftCar.lateral <= rightCar.lateral || Math.abs(leftCar.along - rightCar.along) > o.splitAlong) continue;
        // (with its own car straight, as it will be by then: turned in a flick now, the gap still counts)
        const from = rightCar.lateral + rightCar.across + o.carHalfWidth + o.passMargin;
        const to = leftCar.lateral - leftCar.across - o.carHalfWidth - o.passMargin;
        const y = (from + to) / 2;
        // (only pairs still ahead; a gap with more than a close call's air either side is just road, which the steps
        // already cover)
        const air = (leftCar.lateral - rightCar.lateral - leftCar.across - rightCar.across) / 2 - o.carHalfWidth;
        if (to - from < o.splitRoom || air > o.closeGap || rightCar.along < 0 || y < band.right || y > band.left) continue;
        // (a pair it gave up splitting a moment ago stays given up: no back and forth at a closing gap)
        if (lockouts.some((l) => l.right === rightCar.ref && l.left === leftCar.ref)) continue;
        pairs[lineCount] = pairs[lineCount] ?? {};
        pairs[lineCount].right = rightCar.ref;
        pairs[lineCount].left = leftCar.ref;
        opening[lineCount] = leftCar.vLateral - rightCar.vLateral;
        clear[lineCount] = Math.max(rightCar.along + rightCar.length, leftCar.along + leftCar.length);
        clearSpeed[lineCount] = Math.max(rightCar.vAlong, leftCar.vAlong);
        lines[lineCount++] = y;
      }
    }
    // The split it lines up on (splitLineUp): the gap of the nearest pair ahead, while that pair is still beyond where
    // its plans reach (closer, the plans themselves decide whether to thread it)
    let splitLine = null, splitClear = Infinity;
    for (let line = gridCount; line < lineCount; line++) {
      if (clear[line] < splitClear) {
        splitClear = clear[line];
        splitLine = lines[line];
      }
    }
    if (splitClear < u * o.planTime) splitLine = null;
    for (let line = 0; line < lineCount; line++) {
      const y = lines[line];
      const split = line >= gridCount;
      // (on from a split to every thenStride-th line: the move on past a pair needs no finer a choice, and each split
      // flies once per line it may move on to)
      for (let next = 0; next < (split ? gridCount : 1); next += split ? o.thenStride : 1) {
        const then = split ? lines[next] : y; // the line it moves on to once past a split pair
        // Only the cars this move could come near: across the street, the move spans the car's line to y (plus any
        // overshoot); a car spans where it drifts to over the look-ahead, plus the passing reach
        const low = Math.min(carLat, y, then, carLat + overshoot), high = Math.max(carLat, y, then, carLat + overshoot);
        // (and the passing margin at its widest, the whole move across: see the spread in the flight below)
        const widest = o.planSpread * (high - low);
        let nearCount = 0;
        for (let i = 0; i < count; i++) {
          const ob = seen[i];
          const drift = ob.vLateral * o.planTime;
          const reach = ob.widestReach + widest;
          if (ob.lateral + Math.max(0, drift) + reach > low && ob.lateral + Math.min(0, drift) - reach < high) {
            near[nearCount++] = ob;
          }
        }
        // A move across to a line is also tried late: holding the line it is on for holdTime first, then flicking (a
        // swerve at the last moment round the car ahead is the swim; an early lane change is a commute)
        // (a late flick it has committed to keeps its moment: it may go now, or when it planned to, not later. And a
        // car already moving across doesn't stop mid-move to hold where it happens to be)
        const holding = split || Math.abs(y - carLat) < o.gapStep || Math.abs(carLatVel) > o.holdLateral;
        let holds = o.holds;
        if (holding || this.clock < this.holdLockUntil) holds = NO_HOLD;
        else if (holdLeft > 0) holds = this._pending ??= [0, 0];
        if (holds === this._pending) holds[1] = holdLeft;
        const pedals = o.coastPedal ? [...o.pedals, COAST] : o.pedals;
        for (const hold of holds) for (const pedal of pedals) {
          // Fly the plan: speed eases toward the pedal's, position slides across at the flick rate. The brake key is all
          // or nothing, and the frames it is down leave the front tires little to turn with: the harder the plan brakes,
          // the slower it can move across. (The lift, off both pedals, slows it by the drag and the tires' rolling alone.)
          const coast = pedal === COAST;
          const accel = coast ? 0 : pedal;
          const braking = accel < 0 ? Math.min(1, -accel / (this.model.brakeGrip * GRAVITY)) : 0;
          const sideways = o.lateralAccel * (1 - o.brakeSteerLoss * braking);
          let travelled = 0, speed = u, lat = carLat, latVel = carLatVel, hitAt = Infinity, touchAt = Infinity;
          let brakeAcross = 0; // m it moves across with the brake key down
          let heldUntil = Infinity; // when it first comes alongside a car on the line it held (a held plan)
          for (let i = 0; i < nearCount; i++) {
            air[i] = Infinity;
            passedAt[i] = Infinity;
            aimed[i] = near[i].alarm;
          }
          for (let step = 1; step * o.planStep <= o.planTime && touchAt === Infinity; step++) {
            const t = step * o.planStep;
            // A punch (or a brake) into the gap, then holding that speed through it
            const pedalOn = t <= o.pedalTime;
            if (pedalOn) speed = clamp(speed + (coast ? coastAccel(speed, this.model) : accel) * o.planStep, 0, o.cruiseSpeed);
            // ...but no faster than the drifted corner ahead allows: the executor brakes for it whatever the pedal
            // (decide), on the brake key, which leaves less grip to move across with
            const cornerLimit = Math.sqrt((this.cornerV ?? o.cornerSpeed) ** 2 + 2 * o.braking * Math.max(0, this.cornerAhead - (this.brakeShort ?? 8) - travelled));
            const cornerBraking = speed > cornerLimit;
            if (cornerBraking) speed = Math.max(cornerLimit, speed - cornerBrake * o.planStep);
            travelled += speed * o.planStep;
            // (a car only moves across as it rolls: at a crawl it can't step sideways round the car in front)
            let goal = split && travelled > clear[line] + clearSpeed[line] * t ? then : y;
            if (t <= hold) goal = carLat;
            const across = cornerBraking ? Math.min(sideways, brakingSideways) : sideways;
            const swing = o.lateralSwing * across / o.lateralAccel;
            latVel = slideAcross(lat, latVel, goal, o.planStep, across, Math.min(lateralSpeed, speed * o.crawlAcross), swing,
              o.settleTime);
            lat += latVel * o.planStep;
            // (its own brake pedal: the braking for a drifted corner comes whatever it plans, lining up on its entry)
            if (pedalOn && accel < 0) brakeAcross += Math.abs(latVel) * o.planStep;
            // Its own footprint now: turned the way it is moving across, or as it was turned at the start (and swinging
            // on for yawCarry) while that settles, whichever is more
            const settling = egoYawPeak * Math.exp(-Math.max(0, t - o.yawCarry) / o.yawSettle);
            const yaw = Math.max(o.yawLead * Math.atan(Math.abs(latVel) / Math.max(1, speed)), settling);
            const ownAlong = footprintAlong(o, yaw), ownAcross = footprintAcross(o, yaw);
            const aiming = o.flinchCost > 0 && t <= o.flinchHorizon && step % 2 === 0;
            for (let i = 0; i < nearCount; i++) {
              const ob = near[i];
              const ahead = ob.along + ob.vAlong * t - travelled;
              const across = ob.lateral + ob.vLateral * t - lat;
              const length = ob.inside ? ob.length : ob.extentAlong + ownAlong + o.followMargin;
              const reach = ob.inside ? ob.reach : ob.across + ownAcross + o.passMargin;
              const gapAlong = Math.abs(ahead) - length;
              // (the further it has moved across, the less sure it is where on the keys it really is: the margin widens by
              // a share of the move so far. A split of the pair it is lined up on keeps the swimmer's margin; a swing
              // across a lane or two to a gap in the next row gets the room its error takes)
              const spread = o.planSpread * Math.abs(lat - carLat);
              const gapAcross = Math.abs(across) - reach - spread;
              if (gapAlong < 0 && gapAcross < 0) {
                // (inside the margins; flown on until it would really touch: a squeeze, or a hit)
                if (hitAt === Infinity) hitAt = t;
                // (a car already inside the margins touches only by getting closer than it is: its reach is the gap
                // there is now, less a hair. Read as 0.1 m of real air, every plan beside a car stopped 0.15 m away
                // touched at once, and the AI stood there for 88 s: fresh-s4-30 on 9f70d21)
                const real = ob.inside ? gapAcross + o.squeezeMargin : Math.abs(across) - ob.across - ownAcross;
                const touchAlong = Math.abs(ahead) - (ob.inside ? ob.length : ob.extentAlong + ownAlong);
                if (touchAlong < 0 && real < o.squeezeMargin) {
                  touchAt = t;
                  break;
                }
              }
              if (hold > 0 && gapAlong < 0 && Math.abs(ob.lateral + ob.vLateral * t - carLat) < reach) {
                heldUntil = Math.min(heldUntil, t);
              }
              // Aimed at it: kept going as it is, it would hit the car within the time a driver notices; long enough
              // and the driver flinches, floors it or brakes and swerves, and the gap it was threading moves
              // (over the plan's first flinchHorizon only, every other step: it replans long before the rest is flown)
              if (aiming && ahead > -length && aimed[i] < o.flinchTime) {
                const toHit = timeToHit(ahead, across, speed - ob.vAlong, latVel - ob.vLateral,
                  ob.extentAlong + ownAlong + FLINCH_MARGIN, ob.across + ownAcross + FLINCH_MARGIN, o.flinchNotice);
                aimed[i] = toHit < o.flinchNotice ? aimed[i] + 2 * o.planStep : 0;
              }
              // A close call, as the swim mode scores it: the air beside the car while alongside it, then passing it
              if (gapAlong + o.followMargin < 0) {
                air[i] = Math.min(air[i], gapAcross + spread + o.passMargin);
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
          if (touchAt === Infinity) {
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
            if (trapped) hitAt = touchAt = o.planTime;
            score += o.openWeight * open + o.speedWeight * speed;
          }
          score -= (Math.abs(y - carLat) + Math.abs(then - y)) * o.moveCost;
          // (braking while it moves across is a move set up late: brake straight, then flick; ease off through a weave)
          score -= brakeAcross * o.brakeMoveCost;
          for (let i = 0; i < nearCount; i++) if (aimed[i] >= o.flinchTime) score -= o.flinchCost;
          if (this.lineUp) score -= Math.abs(y - this.entryLine) * o.lineUpCost;
          // (a split coming up: it heads for the gap while the road is open, so it is on its line by the time it
          // reaches the pair, rather than a lane off with too far to go across to thread it)
          if (splitLine !== null) score -= Math.abs(y - splitLine) * o.splitLineUp;
          score += this.closeCallScore(nearCount);
          // A late flick: the move starts within lateWindow of reaching the car on the line it held, and still clears it
          if (hold > 0 && heldUntil - hold < o.lateWindow) score += o.lateBonus;
          if (Math.max(y, then) > oncoming) score -= oncomingCost;
          // Keeping to the line already chosen wins ties: changing its mind takes a clearly better gap
          if (Math.abs(y - this.targetOffset) < o.gapStep * 0.5) score += commit;
          // ...and a move under way isn't turned back within reverseLock of starting it (a dither, not a swim)
          const way = Math.abs(y - carLat) > o.gapStep * 0.5 ? Math.sign(y - carLat) : 0;
          if (way !== 0 && way === -this.moveWay && this.clock - this.moveStart < o.reverseLock) score -= o.reverseCost;
          // Holding a speed (the hand-over count): a plan that slows below it is worth less the more it loses
          const slowest = Math.min(u, speed);
          if (this.keepSpeed > 0) score -= o.keepSpeedWeight * Math.max(0, this.keepSpeed - slowest);
          // Unsafe plans rank by how late they meet trouble, then by how slow they are by then, then by how little they
          // move across (when trouble is a moment away every move meets it then, and a swerve to the far side of the
          // street would steer it into the car alongside)
          // (a split's gap opening is the safe one, one closing the crash: research swimming-craft.md §3)
          if (split) score += o.openingWeight * clamp(opening[line], -2, 2);
          // (a squeeze scores as a clear plan would, less squeezeCost; only a touch ranks by when it comes)
          if (hitAt !== Infinity && touchAt === Infinity) score -= o.squeezeCost;
          if (touchAt !== Infinity) score = -o.hitCost * (o.planTime - touchAt) - speed - Math.abs(y - carLat) * o.moveCost;
          const safe = hitAt === Infinity;
          const tier = safe ? 2 : touchAt === Infinity ? 1 : 0;
          // (ranked as the best is: any safe plan before every unsafe one, then by score)
          const rank = score + tier * SAFE_RANK;
          if (keep > 0 && Math.abs(y - this.targetOffset) < o.gapStep * 0.5 && rank > onTarget.rank) {
            Object.assign(onTarget, { rank, score, safe, tier, y, accel: coast ? coastAccel(u, this.model) : accel, coast, slowest, open, hold, pair: split ? pairs[line] : null });
          }
          if (keep > 0 && (short.length < keep || rank > short[short.length - 1].rank)) {
            const entry = short.length < keep ? (shortPool[short.length] ??= {}) : short.pop();
            Object.assign(entry, { rank, score, safe, tier, y, accel: coast ? coastAccel(u, this.model) : accel, coast, slowest, open, hold, pair: split ? pairs[line] : null });
            let at = short.length;
            while (at > 0 && short[at - 1].rank < rank) at--;
            short.splice(at, 0, entry);
          }
          if (!best || tier > best.tier || (tier === best.tier && score > best.score)) {
            best = this._best ??= {};
            best.score = score;
            best.safe = safe;
            best.tier = tier;
            best.y = y;
            best.accel = coast ? coastAccel(u, this.model) : accel;
            best.coast = coast;
            best.slowest = slowest;
            best.open = open;
            best.hold = hold;
            best.pair = split ? pairs[line] : null;
          }
        }
      }
    }
    // Fly the shortlist again on the car's own keys and physics, against traffic that may not hold its speed: the
    // first that clears every car is the one; none clearing, the one that meets trouble latest. (With no plan clear on
    // the sketch, the best unsafe ones are flown: the sketch's "hits latest" was a line straight behind a 6 m/s car,
    // braking, which rear-ended it at 16 m/s)
    if (short.length && driver && o.verifyPlans > 0 && !this.cornering && count > 0) {
      let pick = null, latest = -1;
      // (the line it is on goes first when the sketch has nothing clear, last otherwise: at 80 mph the car's sideways
      // speed takes half a second to turn round, and the sketch, judging the move it was making unsafe a replan later,
      // braked it straight into the car it was moving round)
      const flown = this._flown ??= [];
      flown.length = 0;
      const extra = onTarget.rank > -Infinity && !short.some((c) => c.y === onTarget.y && c.accel === onTarget.accel && c.hold === onTarget.hold);
      if (extra && short[0].tier < 2) flown.push(onTarget);
      flown.push(...short);
      if (extra && short[0].tier === 2) flown.push(onTarget);
      for (const candidate of flown) {
        const touch = this.flyPlan(car, driver, dt, candidate, carLat, count);
        if (touch === Infinity) {
          pick = candidate;
          break;
        }
        if (touch > latest) {
          latest = touch;
          pick = candidate;
        }
      }
      Object.assign(best, pick);
    }
    // (a split it was on and has given up, its pair still ahead, is locked out for splitLockout)
    const was = this.splitPair;
    if (was && was !== best.pair && (best.pair?.right !== was.right || best.pair?.left !== was.left)) {
      const ahead = (v) => (v.x - car.position.x) * s.ux + (v.z - car.position.z) * s.uz > 0;
      if (ahead(was.right) && ahead(was.left)) lockouts.push({ right: was.right, left: was.left, until: this.clock + o.splitLockout });
    }
    this.splitPair = best.pair ? { right: best.pair.right, left: best.pair.left } : null;
    this.targetOffset = best.y;
    // (the way it is moving across, and since when: a new move starts the reverse lock)
    const way = Math.abs(best.y - carLat) > o.gapStep * 0.5 ? Math.sign(best.y - carLat) : 0;
    if (way !== 0 && way !== this.moveWay) {
      this.moveWay = way;
      this.moveStart = this.clock;
    }
    // (the moment a late flick goes, kept across replans: re-choosing the same flick doesn't put it off. Once it has
    // gone, no new hold for holdLockout: the move it flicked into is flown, not stopped where it has got to)
    if (this.flickAt !== undefined && best.hold === 0) this.holdLockUntil = this.clock + o.holdLockout;
    this.flickAt = best.hold > 0 ? this.clock + best.hold : undefined;
    // The executor flies the same speed profile: the chosen pedal for pedalTime from this speed, then hold
    const plan = this._plan ??= {};
    plan.start = u;
    plan.accel = best.accel;
    plan.coast = best.coast; // off both pedals for pedalTime (a lift)
    plan.safe = best.safe;
    plan.slowest = best.slowest; // the lowest speed the plan flies at
    plan.open = best.open; // m of clear road ahead in its lane where it ends
    plan.hold = best.hold; // s it holds the line it is on before it moves (a late flick)
    plan.holdLine = carLat;
    return plan;
  }

  // A plan flown on the car's own keys (planGap's shortlist): a copy of this autopilot set on the plan, pressing keys
  // through a copy of its hands into a copy of the keyboard driver, the car's physics stepped as the swim car steps them,
  // for verifyTime; every verifyEvery ticks its box against the box each car of the last plan's `count` may be in by
  // then (sped up by trafficGas, braked by trafficBrake, drifted across). Returns s to the first touch, Infinity if none.
  flyPlan(car, driver, dt, candidate, carLat, count) {
    const o = this.options;
    const s = this.seg(this.segment);
    const lx = s.uz, lz = -s.ux;
    const sim = this._flier ??= Object.create(DriftAutopilot.prototype);
    Object.assign(sim, this);
    sim.options = this._flierOptions ??= { ...o, replanInterval: Infinity, road: null, verifyPlans: 0 };
    sim.hands = (this._flierHands ??= new Hands(o.hands)).copyFrom(this.hands);
    sim.want = Object.assign(this._flierWant ??= {}, this.want);
    sim.keys = Object.assign(this._flierKeys ??= {}, this.keys);
    sim.cornerDriver = null;
    sim.cornerChoice = null;
    const plan = sim.plan = this._flierPlan ??= {};
    Object.assign(plan, { start: Math.max(0, car.speed), accel: candidate.accel, coast: candidate.coast, safe: true, slowest: candidate.slowest, open: candidate.open, hold: candidate.hold, holdLine: carLat });
    sim.targetOffset = candidate.y;
    sim.sincePlan = 0;
    sim.flickAt = candidate.hold > 0 ? this.clock + candidate.hold : undefined;
    const simCar = restoreCar(this._flierBase = snapshotCar(car, this._flierBase), this._flierCar ??= snapshotCar(car));
    const simDriver = this._flierDriver = copyDriver(driver, this._flierDriver);
    const telemetry = this._flierTelemetry ??= {};
    const x0 = car.position.x, z0 = car.position.z;
    const seen = this._seen;
    const ticks = Math.round(o.verifyTime / dt);
    for (let n = 1; n <= ticks; n++) {
      const keys = sim.update(simCar, dt, NO_TRAFFIC, simDriver);
      const input = simDriver.update(simCar, keys, dt);
      for (let i = 0; i < 2; i++) stepDriftCar(simCar, input, dt / 2, this.model, telemetry);
      if (n % o.verifyEvery) continue;
      const t = n * dt;
      const along = (simCar.position.x - x0) * s.ux + (simCar.position.z - z0) * s.uz;
      const lat = (simCar.position.x - s.a.x) * lx + (simCar.position.z - s.a.z) * lz;
      const yaw = Math.abs(wrap(simCar.heading - Math.atan2(s.ux, s.uz)));
      const ownAlong = footprintAlong(o, yaw), ownAcross = footprintAcross(o, yaw);
      for (let i = 0; i < count; i++) {
        const ob = seen[i];
        // (where along it may be by then: its own way, braking to a stop at the most or speeding up)
        const speed = Math.abs(ob.vAlong);
        const way = speed > 0.5 ? Math.sign(ob.vAlong) : ob.sameWay ? 1 : -1;
        const least = speed <= o.trafficBrake * t ? speed * speed / (2 * o.trafficBrake) : speed * t - 0.5 * o.trafficBrake * t * t;
        const most = speed * t + 0.5 * o.trafficGas * t * t;
        const lo = ob.along + way * (way > 0 ? least : most), hi = ob.along + way * (way > 0 ? most : least);
        const gapAlong = Math.max(lo - along, along - hi, 0) - ob.extentAlong - ownAlong;
        if (gapAlong > o.verifyMargin) continue;
        const gapAcross = Math.abs(ob.lateral + ob.vLateral * t - lat) - ob.across - ownAcross - o.trafficDrift * t;
        if (gapAcross < o.verifyMargin) return t;
      }
    }
    return Infinity;
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
    const reach = speed * seconds + (speed * speed - (this.cornerV ?? o.cornerSpeed) ** 2) / (2 * o.braking);
    let distance = this.seg(this.segment).length - this.alongSegment(car);
    for (let i = this.segment; i < this.path.length - 2 && distance < reach; i++) {
      const s = this.seg(i), next = this.seg(i + 1);
      if (Math.abs(wrap(Math.atan2(next.ux, next.uz) - Math.atan2(s.ux, s.uz))) > o.sharpTurn) return false;
      distance += next.length;
    }
    return true;
  }

  // The quickest it moves across the street at a speed: a share of the speed (a flick), up to maxLateralSpeed
  lateralSpeed(speed) {
    const o = this.options;
    return clamp(Math.max(5, speed) * o.flickRate, 3, o.maxLateralSpeed);
  }

  /**
   * Stopped behind something (a bus at its stop, a car pulled up in its lane), the line beside it the car could pull
   * round on: the nearer side of the nearest car ahead in its line with room for the car within the street, and nothing
   * else on that line for wayRoundReach. Returns { line (m across, + left, as targetOffset), tail (m ahead of the car to
   * the tail of what it is behind) }, or null: nothing in the way, or no way round (a queue across the street). From the
   * cars its last plan saw.
   */
  wayRound(car) {
    const o = this.options;
    const seen = this._seen, count = this._seenCount ?? 0;
    if (!seen || this.path.length < 2) return null;
    const s = this.seg(this.segment);
    const carLat = (car.position.x - s.a.x) * s.uz - (car.position.z - s.a.z) * s.ux;
    const band = this.corridor();
    const clearance = o.carHalfWidth + o.passMargin + o.splitRoom;
    let blocker = null;
    for (let i = 0; i < count; i++) {
      const ob = seen[i];
      if (ob.along <= 0 || ob.along > o.wayRoundReach) continue;
      if (Math.abs(ob.lateral - carLat) > ob.across + clearance) continue;
      if (!blocker || ob.along < blocker.along) blocker = ob;
    }
    if (!blocker) return null;
    let best = null;
    for (const side of [1, -1]) {
      const line = blocker.lateral + side * (blocker.across + clearance);
      if (line > band.left || line < band.right) continue;
      let free = true;
      for (let i = 0; i < count && free; i++) {
        const ob = seen[i];
        if (ob.along < -ob.length || ob.along > o.wayRoundReach) continue;
        if (Math.abs(ob.lateral - line) < ob.across + clearance - TIME_EPSILON) free = false;
      }
      if (free && (best === null || Math.abs(line - carLat) < Math.abs(best - carLat))) best = line;
    }
    if (best === null) return null;
    // (and the point on that line level with its tail, which the nose has to clear: as far ahead of the car's middle)
    const round = this._round ??= {};
    round.line = best;
    round.tail = blocker.along - blocker.extentAlong;
    return round;
  }

  // Drive round onto `line` (wayRound) at a crawl for the next pullTime, whatever its plans say, aiming first at `past`
  // ({ x, z }: the point on that line level with the tail of what it was behind), then down the line (the show's
  // unstick, once it has backed out at an angle)
  pullRound(line, past) {
    this.pull = { line, past: { x: past.x, z: past.z }, until: this.clock + this.options.pullTime };
  }

  // Metres along the current segment the car has come
  alongSegment(car) {
    const s = this.seg(this.segment);
    return (car.position.x - s.a.x) * s.ux + (car.position.z - s.a.z) * s.uz;
  }

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

  // One frame of driving: decides the wheel and pedals it wants, and returns the keys its hands press this frame for
  // the car's KeyboardDriver (`driver`, whose wheel and pedal it reads). Call once per frame, before driver.update.
  update(car, dt, obstacles = [], driver) {
    return this.hands.press(this.drive(car, dt, obstacles, driver), dt);
  }

  // The keys it wants this frame, before its hands press them (the show presses them itself, after its own say: see
  // swim-show.js fly)
  drive(car, dt, obstacles, driver) {
    this.decide(car, dt, obstacles, driver);
    return this.press(car, dt, driver);
  }

  // The keys that move the driver's wheel and pedal toward what it wants, as its hands can press them: each key it
  // changes stays that way a moment (Hands). So it picks the steering key (left, right or neither) whose hold for that
  // moment lands the wheel nearest the wanted lock, W by where the pedal goes in that moment held or lifted, and the
  // brake as taps and holds whose share of the time is the braking it wants. (Gas with the lock wound past the
  // driver's commitLock is a power-over; swimming, decide keeps the wheel short of it, so W stays held through a flick.)
  press(car, dt, driver) {
    const want = this.want;
    const keys = this.keys;
    const p = driver.params;
    const hands = this.hands;
    const best = steeringKey(driver, want.steer, car.speed, dt, hands);
    keys.left = best > 0 ? 1 : 0;
    keys.right = best < 0 ? 1 : 0;

    // The traction control passes on only part of the pedal (a quarter of it off the line): it presses for the throttle
    // it wants after that, reading last frame's share as a driver feels the car hold back
    const passed = driver.throttle > MIN_PEDAL ? clamp(driver.input.throttle / driver.throttle, MIN_PASSED, 1) : 1;
    const pedal = Math.min(1, want.throttle / passed);
    // W the same way as the brake: held while the pedal it has pressed lags the pedal it wants by gasTap's worth, let go
    // once it leads by as much. A light pedal is taps of W (a tap winds the pedal to a third in 80 ms), a full one W
    // held. (Pressing W only when a tap lands the pedal nearer, a light pedal never got a tap, and a car meant to creep
    // up to a queue coasted to a stop and backed out.)
    if (pedal > 0) {
      this.gasDebt = clamp(this.gasDebt + (pedal - driver.throttle) * dt, -2 * GAS_TAP, 2 * GAS_TAP);
      if (this.gasDebt > GAS_TAP || pedal >= 1) this.gassing = 1;
      else if (this.gasDebt < -GAS_TAP) this.gassing = 0;
    } else {
      this.gasDebt = 0;
      this.gassing = 0;
    }
    keys.forward = this.gassing;

    // The brake key is all or nothing: held for its share of the time, as taps and holds of at least brakeTap's worth
    // of braking (the debt between the brake it wanted and the brake it pressed swings past ±brakeTap before the key
    // changes). Never at a stop, where S reverses.
    if (want.brake > 0 && car.speed > CRAWL_BRAKE) {
      this.brakeDebt = clamp(this.brakeDebt + (want.brake - hands.keys.backward) * dt, -2 * BRAKE_TAP, 2 * BRAKE_TAP);
      if (this.brakeDebt > BRAKE_TAP || want.brake >= 1) this.braking = 1;
      else if (this.brakeDebt < -BRAKE_TAP) this.braking = 0;
    } else {
      this.brakeDebt = 0;
      this.braking = 0;
    }
    keys.backward = this.braking;
    if (want.reverse > 0) {
      keys.backward = 1;
      keys.forward = 0;
    }
    if (keys.backward) keys.forward = 0;
    keys.handbrake = want.handbrake > 0.5 ? 1 : 0;
    // (at a crawl the brake key reverses instead, and the tires roll on for ever: a car creeping up to a queue is
    // stopped as a player stops it, taps of S, whose push backwards slows it, then Space to hold it)
    if (want.brake > 0 && want.reverse === 0 && car.speed > 0 && car.speed <= CRAWL_BRAKE) {
      keys.forward = 0;
      keys.backward = car.speed > CRAWL_HOLD ? 1 : 0;
      keys.handbrake = car.speed > CRAWL_HOLD ? 0 : 1;
    }
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
    // It lines up on the outside of the turn, entryMargin in from the street's edge: the widest arc the streets allow
    if (sharp && !this.cornering) this.shapeCorner(turn);
    this.lineUp = sharp && toCorner < Math.max(o.lineUpDistance, Math.abs(u) * o.lineUpTime);
    this.cornerAhead = sharp ? toCorner : Infinity; // m to the drifted corner ahead, which caps the plans' speed
    this.sincePlan = (this.sincePlan ?? Infinity) + dt;
    this.clock += dt;
    if (this.sincePlan >= o.replanInterval || !this.plan) {
      this.plan = this.planGap(car, obstacles, driver, dt);
      this.sincePlan = 0;
    }
    const plan = this.plan;
    const lx = s.uz, lz = -s.ux;
    const carLat = (car.position.x - s.a.x) * lx + (car.position.z - s.a.z) * lz;
    // Pulling round something it was stopped behind (pullRound): at a crawl onto the line beside it, whatever the plans
    // say (from a standstill a nose's length behind, no plan can get across in time, so they all stop)
    // (until it is on that line and straight: turned across, the planner's own footprint is too wide to pass)
    const pull = this.pull;
    const straight = Math.abs(wrap(car.heading - Math.atan2(s.ux, s.uz))) < o.pullStraight;
    if (pull && (this.clock > pull.until || (Math.abs(carLat - pull.line) < o.pullDone && straight))) this.pull = null;
    // (a late flick holds the line it was on until the plan says go)
    let goal = this.sincePlan < (plan.hold ?? 0) ? plan.holdLine : this.targetOffset;
    if (this.pull) goal = this.pull.line;
    const reach = o.lookahead + o.lookaheadTime * Math.abs(u);
    // Swimming, the wheel flies the move as the plan did: it aims down the street along the car's own line, turned
    // across by the sideways speed the move wants where the car is (acrossSpeed). (Aiming at the gap itself asked for
    // sideways speed in proportion to the gap and never for less in time: on the keys the wheel winds on and off over
    // tenths of a second, so a move of two lanes overshot by a lane.) In a drifted corner it aims at the line itself.
    const moveSpeed = Math.min(this.lateralSpeed(u), Math.max(0, u) * o.crawlAcross);
    // (read where its sideways speed has it a moment from now: the wheel takes that long to swing the car)
    const coming = carLat + lateralVelocity(car, s.ux, s.uz) * o.steerLead;
    const across = this.cornering ? 0 : acrossSpeed(goal - coming, o.lateralAccel, moveSpeed, o.settleTime);
    // (in a drifted corner it aims at the new street's line, wherever across the old one it turned in from)
    this.offset = this.cornering ? 0 : carLat;

    // Speed: the plan's pedal, flown as planned (its acceleration fed straight to the pedals, so the car keeps to the
    // timing the gaps were picked with), capped by what the next corner allows
    const planned = clamp(plan.start + plan.accel * Math.min(this.sincePlan, o.pedalTime), 0, o.cruiseSpeed);
    let target = planned;
    let feedForward = this.sincePlan < o.pedalTime && planned > 0 && planned < o.cruiseSpeed ? plan.accel : 0;
    // (a lift is off both pedals, unless a corner or pointing the wrong way asks for the brake)
    let coasting = Boolean(plan.coast) && this.sincePlan < o.pedalTime;
    // (behind a red light's queue: the speed that reaches its tail as it moves off, on no more than the plan's pedal)
    const creep = this.creepSpeed(car);
    this.creeping = creep < Infinity;
    // ...and with no plan clear of the queue (every line ends in it), the creep, not a stop short of it: the plans brake
    // for the queue's tail as if it were a wall, and it stood 20 m short of a red light's queue on 8th Ave, angled, not
    // reading as queued, and backed out of it (fresh-s1-30 and fresh-s3-30 on 8db6e9b)
    if (creep < target || (this.creeping && !plan.safe)) {
      target = creep;
      feedForward = Math.min(0, feedForward);
    }
    if (this.pull) {
      target = o.pullSpeed;
      feedForward = 0;
      coasting = false;
    }
    // Drift entry, as a player does it on the keys: brake hard and straight, then turn in where the corner's arc
    // starts (shapeCorner: the widest arc the two streets allow, and the speed the slide holds round it), the lock
    // going on as long before that as the wheel takes to wind on at this speed, still braking; wound on, the handbrake
    // flick. The braking ends where the lock goes on. (A power-over entry, gas and lock until the tail steps out, takes
    // this car 1.1-1.3 s at 30-50 mph: tried with the handbrake as the fallback after 0.3 s, it over-rotated to 58° and
    // 11 m/s; turned in earlier for it, it ran 20-33 m wide. On a handbrake entry the hands' slide is 45°, 14 m/s.)
    const kp = driver.params;
    const windUp = o.kickSteer * (kp.steerTime + kp.steerTimePerSpeed * Math.abs(u));
    const cornerSpeed = this.cornerV ?? o.cornerSpeed;
    const turnIn = this.turnInAt ?? Math.max(10, cornerSpeed * cornerSpeed / o.turnGrip);
    const entry = turnIn + Math.abs(u) * windUp;
    this.brakeShort = turnIn + cornerSpeed * windUp;
    if (sharp) {
      const cornerLimit = Math.sqrt(cornerSpeed ** 2 + 2 * o.braking * Math.max(0, toCorner - this.brakeShort));
      if (cornerLimit < target) {
        target = cornerLimit;
        coasting = false;
        // Braking for the corner: at least the planned rate, more if it is late (the rate that still gets there)
        const late = (u * u - cornerSpeed ** 2) / (2 * Math.max(2, toCorner - this.brakeShort + 2));
        feedForward = u > cornerLimit ? -Math.max(o.braking, late) : 0;
      }
    }
    if (sharp && toCorner < entry && this.driftedCorner !== this.segment && u > 8) {
      this.driftedCorner = this.segment;
      this.cornerTurn = Math.sign(turn);
      this.cornerExit = Math.atan2(next.ux, next.uz);
      this.turningIn = true;
      this.cornering = true;
      // (a new corner's slide starts with no choice carried over from the last, on the arc the speed it has now takes:
      // slowed by traffic on the way in, a tighter one)
      if (this.cornerDriver) this.cornerDriver.choice = null;
      if (this.cornerFit && o.road) this.sizeCornerPath(Math.min(this.cornerV, Math.max(1, u)));
      // (the look-ahead flicks it itself: no scripted wind-on and kick)
      if (this.cornerPath && o.road && driver && (o.cornerDrive?.fromTurnIn ?? true)) this.turningIn = false;
    }
    // (wound on into the turn: still turned the other way from lining up, the wheel hasn't got there)
    if (this.turningIn && driver.steer * this.cornerTurn >= o.kickSteer) {
      this.turningIn = false;
      this.kick = o.kickTime;
    }
    const kicking = this.kick > 0 || this.turningIn;
    this.kick = Math.max(0, this.kick - dt);

    // Steering: aim the velocity (not the nose) at a point down the route, which holds a drift on its line
    const aim = this.pointAhead(car, reach);
    const street = Math.atan2(aim.x - car.position.x, aim.z - car.position.z);
    const moveAngle = Math.atan2(across, Math.max(1, Math.abs(u)));
    const slip = Math.abs(u) > 2 ? Math.atan2(car.vx * Math.cos(car.heading) - car.vz * Math.sin(car.heading), Math.abs(u)) : 0;
    const travel = car.heading + slip;
    const error = wrap(street + moveAngle - travel);
    // (swimming, the wheel also leans against the car's own turning, so a flick is caught as it arrives, not after)
    // and against the nose swinging out past the way the car is going (slip), which a flick back across builds faster
    // than the travel turns
    const swimmingSlip = Math.abs(u) > o.slideSpeed ? slip : 0;
    const wheel = error * o.steerGain - (this.cornering ? 0 : o.yawDamping * car.angularVel - o.slipCatch * swimmingSlip);
    // Pointing the wrong way (more off the street than the quickest move across points it): slow to a speed the front
    // tires can turn at, about 1 g of grip over the radius it takes to swing back. A move across itself never slows it.
    const widest = Math.atan2(moveSpeed, Math.max(1, Math.abs(u)));
    const wrongWay = Math.max(0, Math.abs(wrap(street - travel)) - widest);
    if (!this.cornering && wrongWay > o.offLine) {
      const radius = (o.lookahead + o.lookaheadTime * Math.abs(u)) / (2 * Math.sin(Math.min(wrongWay, Math.PI / 2)));
      const turnLimit = Math.max(8, Math.sqrt(9.5 * radius));
      if (turnLimit < target) {
        target = turnLimit;
        coasting = false;
        feedForward = Math.min(0, feedForward);
      }
    }
    // (swimming, no more lock than the tires turn into grip: past it a flick back across swings the tail out, and the
    // keyboard driver then reads the held key as a save and unwinds the wheel, so the move is never caught. And short of
    // the lock at which gas and lock commit a power-over, so W stays held through a flick)
    const most = this.cornering ? 1 : Math.min(o.swimLock, (kp.commitLock ?? 1) - COMMIT_CLEARANCE);
    input.steer = kicking ? this.cornerTurn : clamp(wheel / driverLock(u, this.model), -most, most);
    // (pulling round, the nose aims past the tail of what it was behind, then down the line round a few metres on: at a
    // crawl its velocity says little)
    if (this.pull && !this.cornering) {
      const past = this.pull.past;
      const pastAhead = (past.x - car.position.x) * s.ux + (past.z - car.position.z) * s.uz;
      const pullAim = pastAhead > o.carHalfLength ? past : this.pointAhead(car, o.pullAim, this.pull.line);
      const bearing = Math.atan2(pullAim.x - car.position.x, pullAim.z - car.position.z);
      input.steer = clamp(wrap(bearing - car.heading) * o.steerGain / driverLock(u, this.model), -most, most);
    }
    input.handbrake = this.kick > 0 ? 1 : 0;
    const slipAbs = Math.abs(slip);
    // How fast the drift angle is growing, as a driver feels the tail swing (smoothed over a few frames)
    const slipRate = this.lastSlip === undefined ? 0 : (slipAbs - this.lastSlip) / Math.max(dt, 1e-3);
    this.slipRate = (this.slipRate ?? 0) + (slipRate - (this.slipRate ?? 0)) * Math.min(1, dt * o.slipRateFilter);
    this.lastSlip = slipAbs;
    // The turn still to go into the corner: from the way it's travelling round to the new street's direction
    const into = this.cornerTurn || Math.sign(turn) || 1;
    const toGo = Math.max(0, wrap((this.cornerExit ?? street) - travel) * into);
    let angleWanted = 0;
    if (this.cornering && !kicking) {
      // In the slide it works the angle with the keys: the lock into the turn swings the tail further out, the
      // counter-steer catches it (drift-physics.js). It wants driftAngle while there is turn to go, less as the
      // car comes round onto the new street, and reads the angle a moment ahead from how fast it's swinging, so it
      // catches the tail before it overshoots rather than after.
      // (the turn to go read a moment ahead from how fast the car is swinging round, so the slide comes back in before
      // the car points down the new street, not after: it over-rotated past it onto the sidewalk)
      const toGoAhead = Math.max(0, toGo - into * car.angularVel * o.exitLead);
      angleWanted = o.driftAngle * Math.min(1, toGoAhead / o.exitTurn);
      const ahead = slipAbs + this.slipRate * o.slipLead;
      input.steer = into * clamp((angleWanted - ahead) * o.angleGain, -o.counterLock, 1);
      // (coming out, the counter-steer is let go before the slide ends: held as the gas comes back on, the keyboard
      // driver reads it as a manji, a slide the other way)
      if (toGo < o.exitTurn && ahead < o.releaseAngle && input.steer * into < 0) input.steer = 0;
      // A corner fitted to the road is driven round its path by the look-ahead (drift-corner.js CornerDriver): the
      // wheel, W and the handbrake that keep the car on it, its body on the road and the slide alive
      if (this.cornerPath && o.road && driver) {
        this.cornerDriver ??= new CornerDriver({ stepDriftCar, steeringKey, Hands }, o.road, o.cornerDrive);
        this.cornerChoice = this.cornerDriver.update(car, dt, driver, this.hands, this.cornerPath, cornerSpeed, obstacles);
        input.steer = this.cornerChoice.wheel;
        input.handbrake = this.cornerChoice.handbrake;
        input.brake = this.cornerChoice.brake;
      }
    }

    // The corner is done once the car is travelling along the new street and the slide has all but ended
    if (this.cornering && !kicking && slipAbs < o.exitSlip && toGo < o.exitAlign) {
      this.cornering = false;
    }
    if (!this.cornering || kicking) this.cornerChoice = null;
    if (this.turningIn) {
      // Winding the lock on: still braking for the corner (trail braking), off the gas
      input.throttle = 0;
      input.brake = u > cornerSpeed ? clamp((u - cornerSpeed) * o.speedGain / (this.model.brakeGrip * GRAVITY), 0, 1) : 0;
    } else if (kicking) {
      // The flick: off the gas (W down with the handbrake spins the rears up for its release and over-rotates the car)
      input.throttle = 0;
      input.brake = 0;
    } else if (this.cornerChoice) {
      input.brake = this.cornerChoice.brake;
      input.throttle = this.cornerChoice.forward;
    } else if (this.cornering) {
      // Hold the slide on the gas (the keyboard driver works the throttle for the angle while W is held), and lift
      // when the tail swings well past the angle it wants (the rears bite and stop the swing) or the slide picks up
      // speed: a faster slide is a wider one
      input.brake = 0;
      const ahead = slipAbs + this.slipRate * o.slipLead;
      const ground = Math.hypot(car.speed, car.vx, car.vz);
      const driftSpeed = cornerSpeed + o.slideSpeedMargin;
      input.throttle = ahead > angleWanted + o.liftAngle ? 0 : clamp((driftSpeed - ground) * o.driftThrottleGain, 0, 1);
    } else if (coasting) {
      input.throttle = 0;
      input.brake = 0;
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
        // Easing off while the car is still sliding after a corner, so the tail comes back in line; and off the gas
        // altogether once a flick swings the tail out past swimSlip, as a player lifts: held into the slide, the keyboard
        // driver would let the rears spin, they'd lose their grip and the move across would never be caught
        const swimmingSlipAbs = Math.abs(swimmingSlip);
        const sliding = swimmingSlipAbs > o.swimSlip ? 0 : clamp(1 - (swimmingSlipAbs - o.tractionSlip) / (12 * RAD), 0.05, 1);
        // (a plan flooring it is W held: the traction control and xDrive put down what the tires take)
        const flooring = feedForward >= o.pedals[o.pedals.length - 1];
        input.throttle = (flooring ? 1 : Math.min(1, force / fullDriveForce(car, p))) * sliding;
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

/**
 * The steering key (+1 left, -1 right, 0 neither) that lands a keyboard driver's wheel nearest `want`: next frame, or
 * with `hands` (Hands), at the end of the least time a key it changes to stays that way, among the keys the hands can
 * reach now; and changing keys has to gain changeCost over keeping the one it holds.
 */
function steeringKey(driver, want, speed, dt, hands = null) {
  const frames = hands ? Math.max(1, Math.ceil(hands.o.minHold / dt - TIME_EPSILON)) : 1;
  const holding = hands ? hands.steering : 0;
  let best = holding, bestError = Infinity;
  for (const key of [0, 1, -1]) {
    if (hands && !hands.canSteer(key)) continue;
    let steer = driver.steer;
    for (let i = 0; i < frames; i++) steer = nextSteer(steer, key, Math.abs(speed), dt, driver.params);
    const error = Math.abs(steer - want) + (hands && key !== holding ? hands.o.changeCost : 0);
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

export { AUTOPILOT, DriftAutopilot, HANDS, Hands, driverLock, steeringKey, travelHeading };
