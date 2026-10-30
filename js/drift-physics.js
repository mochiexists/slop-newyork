// Rear-wheel-drive drift model for the swimming M5: a planar bicycle model with load transfer, a Pacejka-style tire
// curve that falls away past its peak slip angle, a friction circle on the driven rear axle (power oversteer), a
// handbrake that locks the rear wheels, and a counter-steer assist so a keyboard can hold a slide.
//
// The state matches the player car in controllers.js: `speed` is the velocity along the heading, `vx`/`vz` the
// sideways part in world space, `angularVel` the yaw rate (+ turns left) and `heading` 0 faces +z. The car's left is
// (cos h, -sin h) in world space, so a positive lateral velocity slides to the left.

const GRAVITY = 9.81;
const RAD = Math.PI / 180;

// BMW M5 (G90) in M xDrive 2WD mode, tuned for a playable slide rather than a lap time.
const M5_DRIFT = {
  mass: 1950,
  yawInertia: 3900, // kg·m²
  cgToFront: 1.42, // m: the 3.0 m wheelbase with a little more weight on the nose
  cgToRear: 1.58,
  cgHeight: 0.5,
  // Peak lateral friction coefficients. A grippier rear keeps plain cornering stable; the power, the brakes (load
  // transfer) and the handbrake are what step the tail out.
  frontGrip: 1.14,
  rearGrip: 1.24,
  tractionGrip: 1.5, // longitudinal friction of the rear tires: the friction circle is an ellipse
  launchGrip: 1.65, // traction when straight and not sliding: 0-100 km/h in about 3.4 s; steering or a slide drops it
  // back to tractionGrip
  slideGrip: 0.86, // share of peak force left far past the peak (the curve keeps sliding cars sliding)
  peakSlip: 8 * RAD, // slip angle of the peak lateral force
  power: 1150000, // W at the wheels: a cartoon-tuned, de-limited M5 rather than the showroom 535 kW
  launchForce: 3.4, // × weight: more than the rear tires hold, so full throttle from low speed spins them
  topSpeed: 98, // m/s: 220 mph
  reverseSpeed: 9,
  dragArea: 0.46, // ½ ρ Cd A
  rolling: 0.012, // × weight
  brakeGrip: 1.05, // braking deceleration in g, shared by the axles by load
  handbrakeGrip: 0.85, // locked rear wheels: sliding friction on the rear axle
  maxSteer: 0.62, // rad of front-wheel lock at parking speeds
  highSpeedSteer: 0.12, // rad left of the driver's own lock at full speed (the assist can add more)
  steerRate: 3.2, // rad/s the wheels turn toward the target
  counterSteer: 0.9, // assist: front wheels follow the slide by this share of the body slip angle
  slideFrom: 6 * RAD, // body slip where the drift steering starts taking over from the grip steering,
  slideBlend: 10 * RAD, // all of it this much further on
  slideSteer: 10 * RAD, // front slip the driver's full lock asks for in a slide (the tire's peak is at 8°)
  slipLimit: 55 * RAD, // body slip beyond which the assist yaws the car back, so a slide doesn't become a spin
  stability: 22, // 1/s² of yaw correction per radian past the limit
  minSlipSpeed: 2.5, // m/s floor of the slip-angle denominator, which keeps a crawl stable
  // Engine and gearbox: the G80 M3 Competition's S58 (650 Nm flat from 2,750 to 5,500 rpm, 375 kW at 6,250 rpm, a
  // 7,200 rpm limiter) on a stage-2 tune to 850 Nm, through the ZF 8HP76 eight-speed and a 3.154 final drive to
  // 275/35 R19 rears. `power` and `launchForce` above still cap the drive (the cop car is detuned with them).
  peakTorque: 850, // Nm
  torqueCurve: [[1000, 0.45], [1800, 0.7], [2750, 1], [5500, 1], [6250, 0.88], [7200, 0.74]], // rpm, share of peak
  idleRpm: 800,
  stallRpm: 3200, // the torque converter lets the engine rev to this at full throttle before the wheels catch up
  redline: 7200,
  limiterCut: 0.04, // s of fuel cut each time the revs hit the limiter: the bounce
  upshiftRpm: 6900, // automatic: upshift when the road speed revs the engine past this in the gear,
  slideUpshiftRpm: 5400, // or past this while the spinning rears bounce off the limiter (a drift picking up speed)
  downshiftRpm: 2400, // downshift when the next gear down would turn below this off the throttle,
  kickdownRpm: 5000, // or below this at full throttle
  drivelineEfficiency: 0.9,
  gears: [5.0, 3.2, 2.143, 1.72, 1.313, 1.0, 0.823, 0.64],
  finalDrive: 3.154,
  wheelRadius: 0.34, // m
  // Rotating driveline behind the rear tires, so wheelspin builds and dies away over time rather than in one step
  wheelInertia: 2.6, // kg·m²: both rear wheels and tires
  engineInertia: 0.2, // kg·m²: crank, flywheel and torque converter, felt through the gearing squared
  peakSlipRatio: 0.07, // longitudinal slip (wheel surface over road speed) of the peak drive force: performance tires
  frontDrive: 0, // M xDrive's share of the drive to the front axle (0: 2WD mode)
  fullSpin: 4 // m/s past the peak slip the tire surface outruns the road at full wheelspin (swim-engine.js hears 4 too)
};

const RPM_PER_RAD_S = 60 / (2 * Math.PI);

function gearRatio(gear, params) {
  return params.gears[Math.max(1, gear) - 1] * params.finalDrive;
}

// Engine revs for a wheel surface speed in a gear
function rpmAt(surfaceSpeed, gear, params) {
  return Math.abs(surfaceSpeed) / params.wheelRadius * RPM_PER_RAD_S * gearRatio(gear, params);
}

function engineTorque(rpm, params) {
  const curve = params.torqueCurve;
  if (rpm <= curve[0][0]) return curve[0][1] * params.peakTorque;
  for (let i = 1; i < curve.length; i++) {
    const [rpm1, share1] = curve[i];
    if (rpm <= rpm1) {
      const [rpm0, share0] = curve[i - 1];
      return (share0 + (share1 - share0) * (rpm - rpm0) / (rpm1 - rpm0)) * params.peakTorque;
    }
  }
  return curve[curve.length - 1][1] * params.peakTorque;
}

// The gear the automatic would hold at a steady speed
function cruiseGear(speed, params) {
  const gear = params.gears.findIndex((_, i) => rpmAt(speed, i + 1, params) < params.upshiftRpm);
  return gear < 0 ? params.gears.length : gear + 1;
}

// The rear tires' rotating inertia as a mass at the contact patch: in first the engine spins 16× faster than the
// wheels and weighs ~450 kg there, in top gear ~70 kg.
function spinMass(gear, params) {
  return (params.wheelInertia + params.engineInertia * gearRatio(gear, params) ** 2) / params.wheelRadius ** 2;
}

// Drive force at the wheels for an engine speed: the torque curve through the gear, capped by `power` and `launchForce`
function wheelForce(rpm, gear, speed, throttle, params) {
  if (speed >= params.topSpeed) return 0;
  const force = engineTorque(rpm, params) * gearRatio(gear, params) * params.drivelineEfficiency / params.wheelRadius;
  const weight = params.mass * GRAVITY;
  return throttle * Math.min(force, params.launchForce * weight, params.power / Math.max(1, Math.abs(speed)));
}

/** Full-throttle drive force with the tires gripping, in the car's gear (or the automatic's for its speed). */
function fullDriveForce(car, params = M5_DRIFT) {
  const gear = car.gear >= 1 ? car.gear : cruiseGear(car.speed, params);
  const rpm = Math.max(rpmAt(car.speed, gear, params), params.stallRpm);
  return wheelForce(Math.min(rpm, params.redline), gear, car.speed, 1, params);
}

// The automatic: up at the shift point (earlier while the rears spin at the limiter and the car is gaining speed),
// down when the gear below has room for the revs, sooner the harder the throttle is pressed
function autoShift(car, u, throttle, params) {
  const road = rpmAt(u, car.gear, params);
  const last = params.gears.length;
  const bouncing = car.limiterTime > 0;
  if (car.gear < last && (road > params.upshiftRpm || (bouncing && road > params.slideUpshiftRpm))) {
    car.gear++;
  } else if (car.gear > 1) {
    const below = rpmAt(u, car.gear - 1, params);
    if (below < params.downshiftRpm + (params.kickdownRpm - params.downshiftRpm) * throttle) car.gear--;
  }
}

/** Manual mode: one gear up. Returns whether it shifted. */
function shiftUp(car, params = M5_DRIFT) {
  if (!(car.gear >= 1) || car.gear >= params.gears.length) return false;
  car.gear++;
  return true;
}

/** Manual mode: one gear down, refused when the road speed would take the engine past the limiter. */
function shiftDown(car, params = M5_DRIFT) {
  if (!(car.gear > 1) || rpmAt(car.speed, car.gear - 1, params) > params.redline) return false;
  car.gear--;
  return true;
}

/** Switches between the automatic (default) and manual shifting. Returns true in manual. */
function toggleManual(car) {
  car.manual = !car.manual;
  return car.manual;
}

// Normalised lateral force for a slip angle: rises linearly, peaks at `peakSlip`, then settles at `slideGrip`.
function tireCurve(slip, params) {
  const x = Math.abs(slip) / params.peakSlip;
  const rising = x <= 1 ? x * (2 - x) : 1;
  const falling = x <= 1 ? 1 : params.slideGrip + (1 - params.slideGrip) * Math.exp(-(x - 1) * 1.6);
  return Math.sign(slip) * Math.min(rising, falling);
}

function driveForce(speed, throttle, params) {
  if (!throttle) return 0;
  const weight = params.mass * GRAVITY;
  if (throttle < 0) {
    // Reverse: a gentle constant push up to the reverse limit
    return speed > -params.reverseSpeed ? throttle * weight * 0.45 : 0;
  }
  if (speed >= params.topSpeed) return 0;
  return throttle * Math.min(params.launchForce * weight, params.power / Math.max(1, Math.abs(speed)));
}

/**
 * Advances the car by one short step (call it at 120 Hz or more).
 * input: throttle 0..1, brake 0..1, reverse 0..1, steer -1..1 (+ left), handbrake 0..1, burnout 0..1 (line lock:
 * front brakes hold while the throttle spins the rears), assist 0..1 (counter-steer and slide limit; default 1, the
 * autopilot turns it off for donuts).
 * Returns the step's telemetry (the same object each call): body slip angle, rear slide speed, wheelspin and loads.
 */
function stepDriftCar(car, input, dt, params = M5_DRIFT, out = stepDriftCar.telemetry) {
  const assistLevel = input.assist ?? 1;
  const burnout = input.burnout > 0 ? 1 : 0;
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  let u = car.speed;
  let v = car.vx * cos - car.vz * sin;
  let r = car.angularVel;
  const a = params.cgToFront, b = params.cgToRear, wheelbase = a + b;
  const weight = params.mass * GRAVITY;

  // Load transfer from last step's longitudinal acceleration (braking loads the nose, throttle the tail).
  const transfer = params.mass * (car.longAccel || 0) * params.cgHeight / wheelbase;
  const loadFront = Math.max(weight * 0.15, weight * b / wheelbase - transfer);
  const loadRear = Math.max(weight * 0.15, weight * a / wheelbase + transfer);

  // Steering: the driver's lock shrinks with speed; the assist steers into the slide on top of it. Once the car is
  // sliding, the front wheels point where the front axle is going (a drifter's counter-steer, which also damps the
  // yaw) and the driver's lock turns them past that by up to the tire's peak slip: into the turn holds the angle,
  // letting go lets the rear catch up and straighten.
  const speedAbs = Math.abs(u);
  const driverLock = params.highSpeedSteer + (params.maxSteer - params.highSpeedSteer) / (1 + (speedAbs / 14) ** 2);
  const bodySlip = speedAbs > 1 ? Math.atan2(v, speedAbs) : 0;
  const grip = input.steer * driverLock + (u > 3 ? params.counterSteer * bodySlip * assistLevel : 0);
  const slide = u > 3 ? Math.max(0, Math.min(1, (Math.abs(bodySlip) - params.slideFrom) / params.slideBlend)) * assistLevel : 0;
  const frontPath = Math.atan2(v + a * r, Math.max(speedAbs, params.minSlipSpeed));
  const drifting = frontPath + input.steer * params.slideSteer;
  const target = Math.max(-params.maxSteer, Math.min(params.maxSteer, grip + (drifting - grip) * slide));
  const steerStep = params.steerRate * dt;
  car.steerAngle += Math.max(-steerStep, Math.min(steerStep, target - car.steerAngle));
  const delta = car.steerAngle;

  // Slip angles at each axle; reversing turns the tire frame around.
  const direction = u >= 0 ? 1 : -1;
  const denominator = Math.max(params.minSlipSpeed, speedAbs);
  const slipFront = Math.atan2(v + a * r, denominator) - delta * direction;
  const slipRear = Math.atan2(v - b * r, denominator);

  // Engine and gearbox. The rear wheels' surface speed (the road speed plus any wheelspin) turns the engine, so spinning
  // rears rev it into the limiter, which cuts the fuel for a moment and lets the revs fall back: the bounce.
  const reversing = input.reverse > 0 && u < 0.5;
  const throttle = reversing ? -input.reverse : input.throttle;
  let wheelSlip = car.wheelSlip || 0;
  let engineForce = 0;
  car.limiterTime = Math.max(0, (car.limiterTime || 0) - dt);
  if (reversing) {
    car.gear = -1;
    engineForce = driveForce(u, throttle, params);
    car.rpm = params.idleRpm + (params.stallRpm - params.idleRpm) * input.reverse * 0.5;
  } else {
    if (!(car.gear >= 1)) car.gear = cruiseGear(u, params);
    if (!car.manual) autoShift(car, u, Math.max(0, throttle), params);
    const turning = rpmAt(Math.max(0, u + wheelSlip), car.gear, params);
    // (the torque converter lets the engine run up to its stall speed with the wheels slower, from half throttle)
    const converter = params.idleRpm + (params.stallRpm - params.idleRpm) * Math.min(1, Math.max(0, throttle) * 2);
    const rpm = Math.max(turning, converter);
    if (rpm >= params.redline) car.limiterTime = params.limiterCut;
    if (throttle > 0 && car.limiterTime === 0) engineForce = wheelForce(rpm, car.gear, u, throttle, params);
    car.rpm = Math.min(rpm, params.redline + 200);
  }
  let rearLong = engineForce * (1 - params.frontDrive);
  let frontLong = engineForce * params.frontDrive;
  const brakeForce = input.brake * params.brakeGrip;
  if (brakeForce > 0 && speedAbs > 0.05) {
    frontLong -= direction * brakeForce * loadFront;
    rearLong -= direction * brakeForce * loadRear;
  }
  const handbrake = Math.max(0, Math.min(1, input.handbrake || 0));

  // Front tires: plain lateral curve within their own friction circle.
  const frontMax = params.frontGrip * loadFront;
  frontLong = Math.max(-frontMax, Math.min(frontMax, frontLong));
  const frontLatMax = Math.sqrt(Math.max(0, frontMax * frontMax - frontLong * frontLong));
  let frontLat = -frontLatMax * tireCurve(slipFront, params);

  // Rear tires. `car.wheelSlip` is how much faster the tire surface turns than the road goes (negative under the
  // brakes). Drive and cornering share one friction ellipse through the combined slip: the wheelspin against the
  // sideways slide sets the direction of the tire's force. Spinning rears push along the car's heading and hold little
  // sideways, so the tail swings out; the more they spin the more the push, which is how the throttle holds a drift's
  // angle and, by carrying speed, its radius.
  const rearMax = params.rearGrip * loadRear;
  const straight = Math.max(0, Math.min(1, 1 - Math.abs(bodySlip) / (8 * RAD) - Math.abs(input.steer)));
  const tractionMax = (params.tractionGrip + (params.launchGrip - params.tractionGrip) * straight) * loadRear;
  const lateralShare = (long) => Math.sqrt(Math.max(0, 1 - (long / tractionMax) ** 2));
  let wheelspin = 0;
  let rearLat;
  if (handbrake > 0.05 && speedAbs > 0.5) {
    const slideMax = params.handbrakeGrip * loadRear;
    const vRear = v - b * r;
    const slide = Math.hypot(u, vRear) || 1;
    const lockedLong = -slideMax * u / slide;
    const lockedLat = -slideMax * vRear / slide;
    const freeLong = Math.max(-tractionMax, Math.min(tractionMax, rearLong));
    const freeLat = -rearMax * lateralShare(freeLong) * tireCurve(slipRear, params);
    rearLong = freeLong * (1 - handbrake) + lockedLong * handbrake;
    rearLat = freeLat * (1 - handbrake) + lockedLat * handbrake;
    wheelSlip = 0;
  } else {
    const slipSpeed = Math.max(params.minSlipSpeed, speedAbs);
    const lateral = slipRear / params.peakSlip;
    const combined = (slip) => {
      const longitudinal = slip / (slipSpeed * params.peakSlipRatio);
      const total = Math.hypot(longitudinal, lateral);
      if (total < 1e-9) return [0, 0];
      const share = tireCurve(total * params.peakSlip, params) / total;
      return [tractionMax * share * longitudinal, -rearMax * share * lateral];
    };
    // The wheels spin up or down by the drive the tires don't pass on, through the driveline's inertia; stepped
    // implicitly against the tire's stiffness, which would make a plain step ring at low speed
    const [force] = combined(wheelSlip);
    const stiffness = Math.max(0, (combined(wheelSlip + 0.01)[0] - force) / 0.01);
    wheelSlip += (rearLong - force) * dt / (spinMass(car.gear, params) + stiffness * dt);
    [rearLong, rearLat] = combined(wheelSlip);
    wheelspin = Math.max(0, Math.min(1, (wheelSlip - slipSpeed * params.peakSlipRatio) / params.fullSpin));
  }
  car.wheelSlip = wheelSlip;

  // A stationary tire carries no cornering force, however far the wheels are turned.
  const rolling = Math.min(1, Math.hypot(u, v) / 0.8);
  frontLat *= rolling;
  rearLat *= rolling;

  // Resistances in the direction of travel
  const drag = params.dragArea * u * speedAbs + Math.sign(u) * Math.min(speedAbs * 20, params.rolling * weight);

  const cosD = Math.cos(delta), sinD = Math.sin(delta);
  const forceX = rearLong + frontLong * cosD - frontLat * sinD - drag;
  const forceY = rearLat + frontLat * cosD + frontLong * sinD;
  const torque = a * (frontLat * cosD + frontLong * sinD) - b * rearLat;
  // Past the slip limit, rotation that would widen the slide is pulled back (the handbrake overrides it for spins).
  const excess = Math.max(0, Math.abs(bodySlip) - params.slipLimit);
  const widening = r * bodySlip < 0 ? 1 : 0;
  const stabilise = -Math.sign(r) * excess * params.stability * widening * (1 - handbrake) * assistLevel;

  const longAccel = forceX / params.mass;
  // Body-frame equations of motion (semi-implicit): the r·v and r·u terms turn the velocity with the car.
  u += (longAccel + v * r) * dt;
  v += (forceY / params.mass - u * r) * dt;
  r += (torque / params.yawInertia + stabilise) * dt;

  // A stopped car must not creep from rounding: brakes and rolling resistance hold it still.
  const holding = !throttle && (input.brake > 0 || handbrake > 0);
  if (holding && Math.abs(u) < 0.3) u = 0;
  // Line lock: the front brakes hold the car where it stands while the rear tires spin
  if (burnout && Math.abs(u) < 2) {
    u = 0;
    wheelspin = 1;
  }
  // At a crawl the tire model loses meaning; settle toward rolling without slip so the car can't spin in place.
  // Spinning rear tires (a donut pivots with little forward speed) keep their rotation.
  const crawl = Math.hypot(u, v);
  if (crawl < 1.5 && !wheelspin) {
    const settle = 1 - Math.exp(-dt * 6 * (1 - crawl / 1.5));
    v -= v * settle;
    r += (u * Math.tan(delta) / wheelbase - r) * settle;
  }

  car.longAccel = car.longAccel === undefined ? longAccel : car.longAccel + (longAccel - car.longAccel) * Math.min(1, dt * 8);
  car.heading += r * dt;
  const nextSin = Math.sin(car.heading), nextCos = Math.cos(car.heading);
  car.speed = u;
  car.vx = nextCos * v;
  car.vz = -nextSin * v;
  car.angularVel = r;
  car.position.x += (nextSin * u + nextCos * v) * dt;
  car.position.z += (nextCos * u - nextSin * v) * dt;

  out.slipAngle = speedAbs > 2 ? Math.atan2(v, Math.abs(u)) : 0;
  out.rearSlide = Math.abs(v - b * r) + wheelspin * Math.max(4, speedAbs * 0.5) + handbrake * speedAbs * 0.6
    + burnout * 16;
  out.wheelspin = wheelspin;
  out.rpm = car.rpm;
  out.gear = car.gear;
  out.limiter = car.limiterTime > 0;
  out.steer = delta;
  out.loadFront = loadFront;
  out.loadRear = loadRear;
  out.lateralAccel = forceY / params.mass;
  return out;
}
stepDriftCar.telemetry = {
  slipAngle: 0, rearSlide: 0, wheelspin: 0, rpm: 0, gear: 1, limiter: false, steer: 0, loadFront: 0, loadRear: 0,
  lateralAccel: 0
};

// The player's hands and feet on the drift model. Keys are on/off, so a tap of A would slam the wheel to full lock and
// W would floor the throttle in one frame. Racing games filter keyboard input the way a driver's hands move: the wheel
// winds on while A or D is held, so a tap only nudges it and a long hold reaches full lock (slower the faster the car
// goes), it self-centres when the key is let go, and the opposite key swings it back across centre quickly, as
// catching a slide needs; the pedal is pressed rather than switched. On top, a traction control in the spirit of BMW's M Dynamic Mode: on a plain throttle
// it gives the engine only as much torque as the rear tires can put down while they also corner, and it lets the rears
// spin once the driver commits (gas and lock held, the handbrake, or a slide already under way); in a slide it works
// the throttle for the drift angle the keys ask for.
const KEYBOARD_DRIVER = {
  steerTime: 0.75, // s of holding A or D from centre to full lock at a standstill (a 0.1 s tap: 13% of the lock)
  steerTimePerSpeed: 0.02, // s more per m/s: 0.95 s at 10 m/s, 1.35 s at 30 m/s
  centreTime: 0.35, // s the wheel takes to self-centre from full lock when the keys are let go
  counterSteerRate: 3, // the opposite key turns the wheel back this many times faster than it winds on
  throttleTime: 0.25, // s to floor the pedal
  liftTime: 0.08, // s to lift off it
  tractionShare: 0.9, // share of the rear tires' traction the traction control gives the engine going straight
  cornerShare: 0.6, // ... and at full lock, keeping the rest of the friction circle for cornering
  commitDelay: 0.4, // s of gas and lock held before the traction control lets the rears spin: a power-over
  commitTime: 0.25, // s over which it lets go (and takes over again)
  slideSlip: 10 * RAD, // body slip that counts as a slide under way: the throttle may hold it
  // In a slide with W held the driver works the throttle for an angle, as a drifter does: more angle wanted, more
  // wheelspin. Steering into the slide asks for the full angle, letting go of the keys for a shallower one, and
  // steering out of it for none (the throttle comes back under the traction control and the car straightens).
  driftAngle: 30 * RAD,
  looseAngle: 18 * RAD,
  angleRange: 15 * RAD, // angle error over which the throttle goes from half to full (or to the minimum)
  angleLead: 0.3, // s ahead the driver reads the angle from how fast it's changing (lifts before the tail overshoots)
  minDriftThrottle: 0.15,
  burnoutSpeed: 3 // m/s below which gas and brake together is a burnout
};

function approach(value, target, step) {
  return value + Math.max(-step, Math.min(step, target - value));
}

class KeyboardDriver {
  constructor(params = KEYBOARD_DRIVER, model = M5_DRIFT) {
    this.params = params;
    this.model = model; // the drift model's car parameters
    this.input = { throttle: 0, brake: 0, reverse: 0, steer: 0, handbrake: 0, burnout: 0, assist: 1 };
    this.reset();
  }

  reset() {
    this.steer = 0;
    this.throttle = 0;
    this.lockHeld = 0; // s the gas and one steering key have been held together
    this.lockDirection = 0;
    this.commit = 0; // 0 traction control on .. 1 the rears may spin
    this.slip = 0; // last frame's drift angle (magnitude), and how fast it changes
    this.slipRate = 0;
    for (const key of Object.keys(this.input)) this.input[key] = 0;
    this.input.assist = 1;
  }

  /**
   * One frame of keys (forward, backward, left, right, up = handbrake; 0..1 each) to the drift model's input.
   * telemetry is the car's last step (slipAngle). Returns the same input object each call.
   */
  update(car, telemetry, keys, dt) {
    const p = this.params;
    const input = this.input;
    const forward = Number(keys.forward) || 0;
    const backward = Number(keys.backward) || 0;
    const steerKeys = (Number(keys.left) || 0) - (Number(keys.right) || 0);
    const handbrake = Number(keys.up) || 0;
    const speed = Math.abs(car.speed);

    // Pedals: S brakes, then reverses from a stop; W brakes a car rolling backwards; both at a stop is a burnout
    const rollingBack = car.speed < -0.5;
    const burnout = forward > 0 && backward > 0 && speed < p.burnoutSpeed;
    input.burnout = burnout ? 1 : 0;
    input.brake = burnout ? 0 : rollingBack ? forward : car.speed > 0.5 ? backward : 0;
    input.reverse = !burnout && car.speed <= 0.5 ? backward : 0;
    input.handbrake = handbrake;
    const pedal = rollingBack ? 0 : forward;
    this.throttle = approach(this.throttle, pedal, dt / (pedal > this.throttle ? p.throttleTime : p.liftTime));

    // Steering: wind on toward the held key's lock, swing back fast against the current lock, self-centre on release
    const windOn = dt / (p.steerTime + p.steerTimePerSpeed * speed);
    if (steerKeys === 0) {
      this.steer = approach(this.steer, 0, dt / p.centreTime);
    } else if (steerKeys * this.steer < 0) {
      this.steer = approach(this.steer, steerKeys, windOn * p.counterSteerRate);
    } else {
      this.steer = approach(this.steer, steerKeys, windOn);
    }
    input.steer = this.steer;

    // Traction control: the drive force the rears can take beside the cornering they're doing, from the same load
    // transfer the model uses
    const m = this.model;
    const weight = m.mass * GRAVITY;
    const wheelbase = m.cgToFront + m.cgToRear;
    const loadRear = Math.max(weight * 0.15, (weight * m.cgToFront + m.mass * (car.longAccel || 0) * m.cgHeight) / wheelbase);
    const turning = Math.abs(this.steer);
    const share = p.tractionShare + (p.cornerShare - p.tractionShare) * turning;
    const grip = m.launchGrip + (m.tractionGrip - m.launchGrip) * Math.min(1, turning * 4);
    const full = fullDriveForce(car, m);
    const controlled = full > 0 ? Math.min(1, share * grip * loadRear / full) : 1;

    // The driver commits by holding gas and lock (a power-over), pulling the handbrake, or already being sideways
    const sliding = Math.abs(telemetry.slipAngle || 0) > p.slideSlip;
    const lockDirection = Math.sign(steerKeys);
    this.lockHeld = forward > 0 && lockDirection !== 0 && lockDirection === this.lockDirection ? this.lockHeld + dt : 0;
    this.lockDirection = forward > 0 ? lockDirection : 0;
    if (handbrake > 0 || sliding) this.commit = 1;
    else this.commit = approach(this.commit, this.lockHeld > p.commitDelay ? 1 : 0, dt / p.commitTime);
    input.throttle = this.throttle * Math.min(1, controlled + (1 - controlled) * this.commit);

    // In a slide, the throttle for the angle: the tail is out to the side opposite the turn (a left drift slides right)
    const slip = telemetry.slipAngle || 0;
    this.slipRate += ((Math.abs(slip) - this.slip) / dt - this.slipRate) * Math.min(1, dt * 20);
    this.slip = Math.abs(slip);
    if (sliding && !handbrake) {
      let target = p.looseAngle;
      if (lockDirection === -Math.sign(slip)) target = p.driftAngle;
      else if (lockDirection === Math.sign(slip)) target = 0;
      const ahead = this.slip + this.slipRate * p.angleLead;
      const hold = 0.5 + 0.5 * (target - ahead) / p.angleRange;
      input.throttle = this.throttle * Math.max(p.minDriftThrottle, Math.min(1, hold));
    }
    return input;
  }
}

export {
  M5_DRIFT, KEYBOARD_DRIVER, tireCurve, engineTorque, fullDriveForce, stepDriftCar, shiftUp, shiftDown, toggleManual,
  KeyboardDriver
};
