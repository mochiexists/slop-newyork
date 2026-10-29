// The swimming car's engine as numbers: an 8-speed automatic, engine speed from the road (plus torque-converter
// slip, wheelspin and the rev limiter), turbo boost and the moments the sound reacts to (shifts, a throttle stab at
// a standstill, lifting off). No Web Audio here, so node tests can drive it; swim-engine-audio.js plays it.
//
// Tuned BMW M3 Competition (G80): S58 3.0 twin-turbo straight-six, 8-speed M Steptronic, 285/30 ZR20 rears.

const TWO_PI = Math.PI * 2;

const M3_ENGINE = {
  idle: 750, // rpm
  limiter: 7200, // rpm: fuel cut
  limiterCut: 0.035, // s the fuel stays off at the limiter
  limiterFall: 9000, // rpm/s the engine loses while the fuel is cut
  ratios: [5.0, 3.2, 2.143, 1.72, 1.313, 1.0, 0.823, 0.64],
  reverseRatio: 3.456,
  finalDrive: 3.154,
  tireRadius: 0.3395, // m
  // Upshift points from a light cruise (throttle 0) to flat out (throttle 1), and the matching downshift points
  upshiftLight: 2600,
  upshiftFull: 6900,
  downshiftLight: 1250,
  downshiftFull: 3400, // kickdown
  shiftCut: 0.09, // s of torque cut while an upshift goes through (M Steptronic's quickest setting)
  gearDwell: 0.4, // s before another shift is allowed
  revMatch: 0.15, // s of throttle blip that brings the revs up to a lower gear
  spinSlip: 4, // m/s the rear tires' surface outruns the road at full wheelspin once rolling...
  spinShare: 0.22, // ...or this share of road speed, whichever is more
  burnoutSlip: 18, // m/s of tire surface in a standing burnout (first gear's limiter is 16.2 m/s)...
  launchSlipFade: 15, // ...fading out by this road speed (m/s)
  launchShift: 0.65, // share of the upshift point the road speed alone must reach before a spinning car shifts up
  holdSlip: 0.26, // rad of body slip (15°) beyond which the gearbox holds its gear
  stall: 3200, // rpm the torque converter lets a full-throttle engine reach before the car moves
  launchFade: 9, // m/s by which the converter has locked up
  decoupleSpeed: 1.2, // m/s below which an idling engine is no longer held by the wheels
  blipRPM: 4300, // rpm a throttle stab at a standstill flares to before the converter takes the load
  blipTime: 0.22, // s the flare lasts
  spoolUp: 0.45, // s: turbo lag
  spoolDown: 0.18,
  boostRPM: 2200, // rpm where the turbos start making boost; full by boostRPM + boostRange
  boostRange: 1800
};

// rpm per m/s of road speed in a gear (index 0 = first, -1 = reverse)
function rpmPerSpeed(gear, params = M3_ENGINE) {
  const ratio = gear < 0 ? params.reverseRatio : params.ratios[gear];
  return ratio * params.finalDrive / params.tireRadius * 60 / TWO_PI;
}

function createEngineState(params = M3_ENGINE) {
  return {
    rpm: params.idle,
    gear: 0,
    throttle: 0,
    boost: 0,
    time: 0,
    dwellUntil: 0,
    shiftUntil: 0,
    matchUntil: 0,
    cutUntil: 0,
    blipUntil: 0,
    peakThrottle: 0, // the most throttle since it was last released, for lift-off events
    cut: false, // fuel is cut at the limiter this step
    shifting: false, // an upshift's torque cut is under way
    limiting: false, // the engine is bouncing off the limiter
    load: 0, // 0..1 how hard the engine is working (throttle, less any cut)
    // One-step events: an upshift/downshift went through, the throttle was stabbed at a standstill, or released
    upshift: false,
    downshift: false,
    blip: false,
    lift: 0, // 0..1 strength of a lift-off (crackle) this step
    blowoff: 0 // 0..1 boost dumped by the blow-off valve this step
  };
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const approach = (value, target, dt, tau) => value + (target - value) * (1 - Math.exp(-dt / tau));

/**
 * Advances the engine by dt seconds (any frame rate; 30 Hz or more keeps the limiter's bounce).
 * input: speed m/s (negative = reversing), throttle 0..1, and from the drift telemetry wheelspin 0..1 and the
 * body slipAngle (rad).
 */
function stepEngine(state, input, dt, params = M3_ENGINE) {
  if (!(dt > 0)) return state;
  dt = Math.min(dt, 0.1);
  const speed = Number.isFinite(input.speed) ? input.speed : 0;
  const pedal = clamp(Number.isFinite(input.throttle) ? input.throttle : 0, 0, 1);
  const wheelspin = clamp(Number.isFinite(input.wheelspin) ? input.wheelspin : 0, 0, 1);
  const speedAbs = Math.abs(speed);
  const previousThrottle = state.throttle;
  state.time += dt;
  const now = state.time;
  state.upshift = state.downshift = state.blip = false;
  state.lift = state.blowoff = 0;

  state.throttle = approach(state.throttle, pedal, dt, pedal > state.throttle ? 0.035 : 0.06);
  const throttle = state.throttle;

  // The driven wheels turn faster than the road when they spin: the drift model's wheelspin (0..1) becomes a slip
  // speed, large at a standstill (a burnout reaches the limiter in first) and a share of road speed once rolling.
  const slipSpeed = wheelspin * throttle * Math.max(params.spinSlip, params.spinShare * speedAbs,
    params.burnoutSlip * (1 - speedAbs / params.launchSlipFade));
  const wheelSpeed = speedAbs + slipSpeed;
  // Sideways, the driver holds the gear and lets the revs bounce off the limiter rather than shifting up.
  const holding = Math.abs(Number(input.slipAngle) || 0) > params.holdSlip;

  if (speed < -0.3) {
    state.gear = -1;
  } else if (speedAbs < 0.5) {
    state.gear = 0;
  } else if (state.gear < 0) {
    state.gear = 0;
  } else if (now >= state.dwellUntil) {
    const top = params.ratios.length - 1;
    const upAt = params.upshiftLight + (params.upshiftFull - params.upshiftLight) * throttle;
    const downAt = params.downshiftLight + (params.downshiftFull - params.downshiftLight) * throttle * throttle;
    const engineRPM = wheelSpeed * rpmPerSpeed(state.gear, params);
    const roadRPM = speedAbs * rpmPerSpeed(state.gear, params);
    // A spinning launch doesn't shift up until the road speed has caught up a little (the revs flare in first).
    if (state.gear < top && engineRPM > upAt && roadRPM > upAt * params.launchShift && !holding) {
      state.gear++;
      state.upshift = true;
      state.shiftUntil = now + params.shiftCut * (0.4 + 0.6 * throttle);
      state.dwellUntil = now + params.gearDwell;
    } else if (state.gear > 0 && engineRPM < downAt
      && wheelSpeed * rpmPerSpeed(state.gear - 1, params) < params.upshiftFull - 400) {
      state.gear--;
      state.downshift = true;
      state.dwellUntil = now + params.gearDwell;
      state.matchUntil = now + params.revMatch;
    }
  }
  // After a jump in speed (a reset or a teleport) no gear could be this high: pick the one that fits at once.
  while (state.gear >= 0 && state.gear < params.ratios.length - 1 && speedAbs * rpmPerSpeed(state.gear, params) > params.limiter) {
    state.gear++;
  }
  state.shifting = now < state.shiftUntil;

  // A stab of the throttle while standing still flares the revs before the converter loads the engine.
  if (speedAbs < 0.5 && pedal > 0.5 && previousThrottle < 0.15 && now >= state.blipUntil) {
    state.blip = true;
    state.blipUntil = now + params.blipTime;
  }

  // Where the engine wants to be: held by the (possibly spinning) wheels in gear, with torque-converter slip at launch.
  const wheelRPM = wheelSpeed * rpmPerSpeed(state.gear, params);
  const coupled = wheelSpeed > params.decoupleSpeed;
  const converter = throttle * (params.stall - params.idle) * clamp(1 - speedAbs / params.launchFade, 0, 1);
  let target = Math.max(params.idle + converter, coupled ? wheelRPM : params.idle);
  if (now < state.blipUntil) target = Math.max(target, params.blipRPM * (0.6 + 0.4 * throttle));
  // Asking for more than the limiter keeps it bouncing; the limiter itself is below.
  if (throttle > 0.05) target = Math.min(target, params.limiter + 400);

  // Engine inertia: fast on the throttle and while the wheels pull it, slower when it falls freely.
  let tau;
  if (state.upshift || state.shifting) tau = 0.035; // the next gear pulls the revs down at once
  else if (now < state.matchUntil) tau = 0.035; // the gearbox blips to match the lower gear
  else if (target > state.rpm) tau = slipSpeed > 2 ? 0.05 : throttle > 0.1 ? 0.07 : 0.12;
  else tau = coupled ? 0.06 : 0.2;

  // The limiter: at the cut, the fuel stays off for a moment and the revs fall, then they climb back (the bounce).
  if (state.rpm >= params.limiter && now >= state.cutUntil && throttle > 0.05) state.cutUntil = now + params.limiterCut;
  state.cut = now < state.cutUntil;
  if (state.cut) state.rpm -= params.limiterFall * dt;
  else state.rpm = approach(state.rpm, target, dt, tau);
  state.rpm = clamp(state.rpm, params.idle * 0.9, params.limiter + 60);
  state.limiting = state.cut || (now - state.cutUntil < 0.15 && throttle > 0.5);

  state.load = throttle * (state.cut ? 0.1 : 1) * (state.shifting ? 0.25 : 1);

  // Turbo boost builds with revs and throttle, after a lag; lifting with boost up dumps it through the blow-off valve.
  const boostTarget = throttle * clamp((state.rpm - params.boostRPM) / params.boostRange, 0, 1);
  const boostBefore = state.boost;
  state.boost = approach(state.boost, boostTarget, dt, boostTarget > state.boost ? params.spoolUp : params.spoolDown);
  state.peakThrottle = Math.max(state.peakThrottle, pedal);
  if (pedal < 0.15 && state.peakThrottle > 0.6) {
    state.peakThrottle = 0;
    if (boostBefore > 0.35) state.blowoff = clamp(boostBefore, 0, 1);
    if (state.rpm > 3000) state.lift = clamp((state.rpm - 3000) / 3500, 0.2, 1);
  } else if (pedal < 0.15) {
    state.peakThrottle = 0;
  }
  return state;
}

export { M3_ENGINE, rpmPerSpeed, createEngineState, stepEngine };
