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
  tractionGrip: 1.3, // longitudinal friction of the rear tires: the friction circle is an ellipse
  slideGrip: 0.86, // share of peak force left far past the peak (the curve keeps sliding cars sliding)
  peakSlip: 8 * RAD, // slip angle of the peak lateral force
  power: 455000, // W at the wheels
  launchForce: 2.15, // × weight: more than the rear tires hold, so full throttle from low speed spins them
  topSpeed: 85, // m/s: the 305 km/h limiter
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
  minSlipSpeed: 2.5 // m/s floor of the slip-angle denominator, which keeps a crawl stable
};

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
 * input: throttle 0..1, brake 0..1, reverse 0..1, steer -1..1 (+ left), handbrake 0..1.
 * Returns the step's telemetry (the same object each call): body slip angle, rear slide speed, wheelspin and loads.
 */
function stepDriftCar(car, input, dt, params = M5_DRIFT, out = stepDriftCar.telemetry) {
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
  const assist = u > 3 ? params.counterSteer * bodySlip : 0;
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
  // wheels; a spinning (or locked) tire keeps only its sliding grip.
  const rearMax = params.rearGrip * loadRear;
  const tractionMax = params.tractionGrip * loadRear;
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
  } else {
    if (Math.abs(rearLong) > tractionMax) {
      wheelspin = Math.min(1, (Math.abs(rearLong) - tractionMax) / tractionMax + 0.3);
      rearLong = Math.sign(rearLong) * tractionMax * params.slideGrip;
    }
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
  const stabilise = -Math.sign(r) * excess * params.stability * widening * (1 - handbrake);

  const longAccel = forceX / params.mass;
  // Body-frame equations of motion (semi-implicit): the r·v and r·u terms turn the velocity with the car.
  u += (longAccel + v * r) * dt;
  v += (forceY / params.mass - u * r) * dt;
  r += (torque / params.yawInertia + stabilise) * dt;

  // A stopped car must not creep from rounding: brakes and rolling resistance hold it still.
  const holding = !throttle && (input.brake > 0 || handbrake > 0);
  if (holding && Math.abs(u) < 0.3) u = 0;
  // At a crawl the tire model loses meaning; settle toward rolling without slip so the car can't spin in place.
  if (Math.abs(u) < 1.5) {
    const settle = 1 - Math.exp(-dt * 6 * (1 - Math.abs(u) / 1.5));
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
  out.rearSlide = Math.abs(v - b * r) + wheelspin * Math.max(4, speedAbs * 0.5) + handbrake * speedAbs * 0.6;
  out.wheelspin = wheelspin;
  out.steer = delta;
  out.loadFront = loadFront;
  out.loadRear = loadRear;
  out.lateralAccel = forceY / params.mass;
  return out;
}
stepDriftCar.telemetry = { slipAngle: 0, rearSlide: 0, wheelspin: 0, steer: 0, loadFront: 0, loadRear: 0, lateralAccel: 0 };

export { M5_DRIFT, tireCurve, stepDriftCar };
