import * as THREE from 'three/webgpu';
import { Fn, If, float, mix, uniform } from 'three/tsl';
import { TELEPORT_LOCATIONS } from './city-config.js';
import { M5_DRIFT, KeyboardDriver, stepDriftCar } from './drift-physics.js';
import { createContactShadowMaterial } from './tsl-materials.js';
import {
  buildCarGeometry,
  buildSteerableWheelGeo,
  carTipZ,
  createCarWheelMaterial,
  createLoftedCarMaterial
} from './cars.js';
import { createVehicleHeadlight, placeVehicleHeadlight } from './vehicle-lights.js';
import { M5_BODY } from './m5-body.js';

// The player's car in swimming mode: the M5 on the drift model (drift-physics.js). controllers.js registers the
// entity as `entities.swim` and calls updateSwim() for the 'swim' mode; everything else about the car lives here, so
// the upstream controllers keep only those hooks.

const M5_PAINT = 0x1b4fa8; // BMW Marina Bay Blue metallic
const SWIM_STEPS_PER_SECOND = 240; // the drift model wants short steps: slip angles change fast in a slide
// Half-width & half-length of the car's collision box (controllers.js CAR_BOXES): bigger than the taxi's
const SWIM_BOX = [0.97, 2.52];

// The NY plate, as controllers.js draws the taxi's (createNYLicensePlateTexture), with the swimming car's own text
function createSwimPlateTexture(number, footer) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffb81c';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#0d2244';
  ctx.fillRect(6, 6, 244, 24);
  ctx.fillStyle = '#ffb81c';
  ctx.font = '800 15px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('NEW YORK', 128, 23);
  ctx.fillStyle = '#0d2244';
  ctx.font = '900 48px JetBrains Mono, monospace';
  ctx.fillText(number, 128, 82);
  ctx.font = '700 13px Inter, Arial, sans-serif';
  ctx.fillText(footer, 128, 114);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

// The window glass blends, so the driver (m5-cockpit.js) can be seen from outside: its opacity is the
// `material.userData.glassOpacity` uniform (1 = the painted glass every other car has). Only the glass blends; the
// mesh's body loft comes before its glasshouse in the index, so whatever is seen through the glass is already drawn
// when the glass goes over it. (cars.js hands out the window mask and glass as `material.userData.windowGlass`.)
function makeGlassSeeThrough(mat) {
  const { isWindow, evalWindowGlass } = mat.userData.windowGlass;
  const glassOpacity = uniform(1);
  mat.userData.glassOpacity = glassOpacity;
  mat.transparent = true;
  mat.opacityNode = Fn(() => {
    const o = float(1.0).toVar();
    If(isWindow.greaterThan(0.5), () => {
      o.assign(mix(float(1.0), glassOpacity, evalWindowGlass().glass));
    });
    return o;
  })();
}

// =========================================================================
// SWIMMING (BMW M5 SUPER SALOON WITH DRIFT PHYSICS, see drift-physics.js)
// =========================================================================
function createSwimEntity(scene) {
  const root = new THREE.Group();
  root.name = 'PlayerSwimmingM5';

  const chassisPivot = new THREE.Group();
  root.add(chassisPivot);

  const spec = M5_BODY;
  const paint = createLoftedCarMaterial(spec, M5_PAINT);
  // the glass lets the driver (m5-cockpit.js) be seen from outside
  if (!paint.userData.glassOpacity) makeGlassSeeThrough(paint);
  const body = new THREE.Mesh(buildCarGeometry(spec, false), paint);
  chassisPivot.add(body);

  const plateMat = new THREE.MeshStandardNodeMaterial({ map: createSwimPlateTexture('SWIM', 'EMPIRE STATE'), roughness: 0.28 });
  for (const front of [true, false]) {
    const y = spec.plates[front ? 0 : 1];
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.008), plateMat);
    plate.position.set(0, y, carTipZ(spec, y, front) + (front ? 0.003 : -0.003));
    plate.rotation.x = Math.atan((carTipZ(spec, y + 0.07, front) - carTipZ(spec, y - 0.07, front)) / 0.14);
    chassisPivot.add(plate);
  }

  // Quad tailpipes under the rear bumper, two either side
  const pipeMat = new THREE.MeshStandardNodeMaterial({ color: 0x2b2e33, metalness: 0.92, roughness: 0.28, side: THREE.DoubleSide });
  const pipeGeo = new THREE.CylinderGeometry(0.047, 0.05, 0.16, 16, 1, true).rotateX(Math.PI * 0.5);
  const pipeY = 0.3;
  const pipeZ = carTipZ(spec, pipeY, false) + 0.03;
  for (const x of [-0.56, -0.43, 0.43, 0.56]) {
    const pipe = new THREE.Mesh(pipeGeo, pipeMat);
    pipe.position.set(x, pipeY, pipeZ);
    chassisPivot.add(pipe);
  }

  const leftWheelGeo = buildSteerableWheelGeo(spec, -1);
  const rightWheelGeo = buildSteerableWheelGeo(spec, 1);
  const wheelMat = createCarWheelMaterial({ wheelRadius: spec.wheelRadius });
  const wheels = [];
  for (const [side, z, isFront] of [[-1, spec.wheelZ, true], [1, spec.wheelZ, true], [-1, -spec.wheelZ, false], [1, -spec.wheelZ, false]]) {
    const steerPivot = new THREE.Group();
    steerPivot.position.set(side * spec.wheelX, spec.wheelRadius, z);
    const tire = new THREE.Mesh(side < 0 ? leftWheelGeo : rightWheelGeo, wheelMat);
    steerPivot.add(tire);
    root.add(steerPivot);
    wheels.push({ steerPivot, tire, isFront });
  }

  const shadowGeo = new THREE.PlaneGeometry(2.3, 5.45);
  shadowGeo.rotateX(-Math.PI * 0.5);
  const shadow = new THREE.Mesh(shadowGeo, createContactShadowMaterial());
  shadow.position.y = 0.02;
  shadow.renderOrder = 998;
  root.add(shadow);

  const headLights = [];
  for (const side of [-1, 1]) {
    const spot = createVehicleHeadlight();
    placeVehicleHeadlight(spot, spec, side);
    chassisPivot.add(spot, spot.target);
    headLights.push(spot);
  }

  scene.add(root);

  // Parked on 7th Ave just north of Times Square, facing south down the avenue: the opening of the Squeeze clip
  const start = TELEPORT_LOCATIONS.timessq;
  return {
    type: 'car',
    mode: 'swim',
    label: 'BMW M3 Competition · Swimming',
    paint: M5_PAINT,
    mesh: root,
    chassisPivot,
    carState: paint.userData.carState,
    headLights,
    wheels,
    position: new THREE.Vector3(start.x, 0, start.z - 40),
    prevX: start.x,
    prevZ: start.z - 40,
    heading: start.heading,
    cameraYaw: start.heading,
    speed: 0,
    vx: 0,
    vz: 0,
    angularVel: 0,
    longAccel: 0,
    pitchVel: 0,
    rollVel: 0,
    heaveY: 0,
    heaveVel: 0,
    lastCollisionSpark: null,
    steerAngle: 0,
    wheelSpin: 0,
    gear: 1, // the gearbox (drift-physics.js): 1-8, -1 reversing; manual holds it until the driver shifts
    rpm: 800,
    manual: false,
    drift: {
      slipAngle: 0, rearSlide: 0, wheelspin: 0, rpm: 800, gear: 1, limiter: false, steer: 0, loadFront: 0, loadRear: 0,
      lateralAccel: 0
    },
    cameraTargetOffset: new THREE.Vector3(0, 0.92, 0),
    chaseDistance: 7.6,
    chaseHeight: 2.05
  };
}

// A teleport puts the car down at rest (controllers.js resets what every car shares; this, the drift model's state)
function resetSwimCar(controllers, ent) {
  ent.longAccel = 0;
  ent.cameraYaw = ent.heading;
  ent.drift.slipAngle = ent.drift.rearSlide = ent.drift.wheelspin = 0;
  ent.wheelSlip = 0;
  ent.gear = 0; // the automatic picks the gear for the speed again
  controllers.swimDriver?.reset();
}

// Swimming: the M5 on the drift model. W throttle, S brakes then reverses, A/D steer, Space/E handbrake; W and S
// together at a stop is a burnout. The keyboard driver turns the on/off keys into a driver's hands and feet (see
// the keyboard driver in drift-physics.js), so a tap of A is a grip turn and a slide takes a deliberate input.
// `controllers` is the ThirdPersonControllerManager: its keys, collisions and ground, and the hooks other modules set
// on it (swimPilot, swimRecorder; swimDriver is made here).
function updateSwim(controllers, dt) {
  if (dt <= 0) return;
  const c = controllers.entities.swim;
  const driver = controllers.swimDriver ??= new KeyboardDriver();
  const keys = controllers._swimKeys ??= { forward: 0, backward: 0, left: 0, right: 0, handbrake: 0 };
  keys.forward = controllers.keys.forward;
  keys.backward = controllers.keys.backward;
  keys.left = controllers.keys.left;
  keys.right = controllers.keys.right;
  keys.handbrake = controllers.keys.up;
  // The AI driver (the swim show) drives through the same keys: it sees the player's and presses its own in their place
  controllers.swimPilot?.(c, dt, keys, driver);
  // The flight recorder (session-recorder.js, set by main.js) notes the frame's keys and the state they act on
  controllers.swimRecorder?.frame(c, keys, dt, driver, Boolean(controllers.swimPilot));
  const input = driver.update(c, keys, dt);

  const prevX = c.position.x;
  const prevZ = c.position.z;
  c.prevX = prevX;
  c.prevZ = prevZ;
  const steps = Math.ceil(dt * SWIM_STEPS_PER_SECOND);
  const step = dt / steps;
  for (let i = 0; i < steps; i++) {
    const telemetry = stepDriftCar(c, input, step, M5_DRIFT, c.drift);
    controllers.resolveHorizontalCollision(c.position, 1.35, c);

    // Squat under power, dive under braking, lean out of the corner; collisions kick the same springs (the squat is
    // played up: the nose lifting off the line is half of what makes a launch look violent)
    const targetPitch = -Math.max(-1, Math.min(1, c.longAccel / 9)) * 0.055;
    const targetRoll = Math.max(-0.07, Math.min(0.07, telemetry.lateralAccel * 0.009));
    c.pitchVel += ((targetPitch - c.chassisPivot.rotation.x) * 68 - c.pitchVel * 11.2) * step;
    c.rollVel += ((targetRoll - c.chassisPivot.rotation.z) * 68 - c.rollVel * 11.2) * step;
    c.chassisPivot.rotation.x = Math.max(-0.22, Math.min(0.22, c.chassisPivot.rotation.x + c.pitchVel * step));
    c.chassisPivot.rotation.z = Math.max(-0.26, Math.min(0.26, c.chassisPivot.rotation.z + c.rollVel * step));
    c.heaveVel += (-c.heaveY * 85 - c.heaveVel * 12) * step;
    c.heaveY = Math.max(-0.08, Math.min(0.14, c.heaveY + c.heaveVel * step));
  }
  c.position.y = controllers.getGroundHeight(c.position.x, c.position.z, 'swim');
  c.chassisPivot.position.y = c.heaveY;

  if (c.carState) {
    c.carState.value.x = input.brake > 0 || input.handbrake > 0 ? 1 : 0;
    c.carState.value.w = c.speed < -0.2 ? 1 : 0;
  }

  // The chase camera swings out with the slide, so a drift is seen from the side rather than from straight behind
  // (the AI show sets its own angles for the burnout and donuts)
  const cameraTarget = c.cameraYawOverride ?? c.heading + c.drift.slipAngle * 0.6;
  const turn = Math.atan2(Math.sin(cameraTarget - c.cameraYaw), Math.cos(cameraTarget - c.cameraYaw));
  c.cameraYaw += turn * (1 - Math.exp(-dt * 5));

  // Front wheels roll with the ground; the driven rears spin up with wheelspin and stop under the handbrake
  const forwardDist = (c.position.x - prevX) * Math.sin(c.heading) + (c.position.z - prevZ) * Math.cos(c.heading);
  const roll = forwardDist / M5_BODY.wheelRadius;
  c.wheelSpin = (c.wheelSpin + Math.sign(roll) * Math.min(Math.abs(roll), 0.48)) % (Math.PI * 2);
  const rearRoll = input.handbrake > 0.05 ? 0 : roll + c.drift.wheelspin * dt * 40;
  c.rearWheelSpin = ((c.rearWheelSpin || 0) + Math.sign(rearRoll) * Math.min(Math.abs(rearRoll), 0.48)) % (Math.PI * 2);
  for (const w of c.wheels) {
    w.tire.rotation.x = w.isFront ? c.wheelSpin : c.rearWheelSpin;
    if (w.isFront) w.steerPivot.rotation.y = c.steerAngle;
  }
}

export { M5_PAINT, SWIM_BOX, createSwimEntity, resetSwimCar, updateSwim };
