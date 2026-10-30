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
  tractionGrip: 1.75, // longitudinal friction of the rear tires: the friction circle is an ellipse
  launchGrip: 1.87, // traction when straight and not sliding: 0-100 km/h in 2.8 s, a tuned M5's launch; steering or
  // a slide drops it back to tractionGrip
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
  slipLimit: 34 * RAD, // body slip beyond which the assist yaws the car back, so a slide doesn't become a spin
  stability: 22, // 1/s² of yaw correction per radian past the limit
  minSlipSpeed: 2.5, // m/s floor of the slip-angle denominator, which keeps a crawl stable
  // Rotating driveline behind the rear tires, so wheelspin builds and dies away over time rather than in one step.
  // G80 M3 Competition numbers: ZF 8HP76 ratios, 3.154 final drive, 275/35 R19 rears.
  wheelRadius: 0.34, // m
  wheelInertia: 2.6, // kg·m²: both rear wheels and tires
  engineInertia: 0.2, // kg·m²: crank, flywheel and torque converter, felt through the gearing squared
  gears: [5.0, 3.2, 2.143, 1.72, 1.313, 1.0, 0.823, 0.64],
  finalDrive: 3.154,
  shiftRpm: 7000,
  fullSpin: 4 // m/s the tire surface outruns the road at full wheelspin (swim-engine.js hears the same 4 m/s)
};

// The rear tires' rotating inertia as a mass at the contact patch, in the gear the speed would have the car in: in
// first the engine spins 16× faster than the wheels and weighs ~450 kg there, in top gear ~70 kg.
function spinMass(speed, params) {
  const wheelRpm = Math.abs(speed) / params.wheelRadius * 60 / (2 * Math.PI);
  const axle = params.finalDrive;
  const ratio = params.gears.find((gear) => wheelRpm * gear * axle < params.shiftRpm) ?? params.gears[params.gears.length - 1];
  return (params.wheelInertia + params.engineInertia * (ratio * axle) ** 2) / params.wheelRadius ** 2;
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

  // Steering: the driver's lock shrinks with speed; the assist steers into the slide on top of it.
  const speedAbs = Math.abs(u);
  const driverLock = params.highSpeedSteer + (params.maxSteer - params.highSpeedSteer) / (1 + (speedAbs / 14) ** 2);
  const bodySlip = speedAbs > 1 ? Math.atan2(v, speedAbs) : 0;
  const assist = u > 3 ? params.counterSteer * bodySlip * assistLevel : 0;
  const target = Math.max(-params.maxSteer, Math.min(params.maxSteer, input.steer * driverLock + assist));
  const steerStep = params.steerRate * dt;
  car.steerAngle += Math.max(-steerStep, Math.min(steerStep, target - car.steerAngle));
  const delta = car.steerAngle;

  // Slip angles at each axle; reversing turns the tire frame around.
  const direction = u >= 0 ? 1 : -1;
  const denominator = Math.max(params.minSlipSpeed, speedAbs);
  const slipFront = Math.atan2(v + a * r, denominator) - delta * direction;
  const slipRear = Math.atan2(v - b * r, denominator);

  // Longitudinal forces. The brake pedal works on both axles by load; the handbrake locks the rear.
  const reversing = input.reverse > 0 && u < 0.5;
  const throttle = reversing ? -input.reverse : input.throttle;
  let rearLong = driveForce(u, throttle, params);
  let frontLong = 0;
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

  // Rear tires: drive and lateral force share a friction ellipse. Asking for more traction than it holds spins the
  // wheels; a spinning (or locked) tire keeps only its sliding grip. `car.wheelSlip` is how fast the tire surface
  // outruns the road: the drive force beyond the sliding grip spins the driveline up through its inertia, and once the
  // drive drops below the sliding grip the road pulls the wheels back to rolling speed.
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
    car.wheelSlip = 0;
  } else {
    // (the brakes push against the spin: drive in reverse spins the wheels backwards)
    const spinDirection = throttle < 0 ? -1 : 1;
    const drive = rearLong * spinDirection;
    const sliding = tractionMax * params.slideGrip;
    let wheelSlip = car.wheelSlip || 0;
    if (wheelSlip > 0 || drive > tractionMax) {
      wheelSlip = Math.max(0, wheelSlip + (drive - sliding) / spinMass(u, params) * dt);
    }
    if (wheelSlip > 0) {
      wheelspin = Math.min(1, wheelSlip / params.fullSpin);
      rearLong = spinDirection * sliding;
    } else {
      rearLong = Math.max(-tractionMax, Math.min(tractionMax, rearLong));
    }
    car.wheelSlip = wheelSlip;
    rearLat = -rearMax * lateralShare(rearLong) * tireCurve(slipRear, params) * (1 - 0.4 * wheelspin);
  }

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
    car.wheelSlip = Math.max(car.wheelSlip || 0, params.fullSpin);
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
  out.steer = delta;
  out.loadFront = loadFront;
  out.loadRear = loadRear;
  out.lateralAccel = forceY / params.mass;
  return out;
}
stepDriftCar.telemetry = { slipAngle: 0, rearSlide: 0, wheelspin: 0, steer: 0, loadFront: 0, loadRear: 0, lateralAccel: 0 };

export { M5_DRIFT, tireCurve, stepDriftCar };
