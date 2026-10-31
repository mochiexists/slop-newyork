import { ScoreKick } from './swim-camera-kick.js';

// What the cameras do for the swimming car (cameras.js keeps the hooks): speed you can feel in the follow views, the
// chase camera falling back on a launch, the driver's seat view, and the punch of a close call or split. All of it
// keys off fields only a drift-physics car has (entity.longAccel, entity.povEye), so every other mode is untouched.

const DEFAULT_NEAR = 0.35; // cameras.js's near plane
const SEAT_NEAR = 0.05; // inside a cabin (entity.povEye): the wheel and hands are ~0.4 m from the eye
const SEAT_BODY_FOLLOW = 0.5; // share of the chassis' pitch & roll the seated view turns with
// Speed you can feel, for a car with drift physics (entity.longAccel): the follow views widen with speed and kick wider
// as it pulls (a wider field of view reads as faster; motion blur reads as slower), the chase camera falls back as
// the car launches, and the camera shivers with wheelspin and at speed
const SPEED_FOV = { perSpeed: 12, speed: 40, perAccel: 7, accel: 9, rate: 4 }; // ° at `speed` m/s, ° at `accel` m/s²
const LAUNCH_LAG = { perAccel: 0.4, rate: 3 }; // m the chase camera falls back per m/s² of acceleration
const SHAKE = { amount: 0.02, speed: 40, seatShare: 0.3 }; // m at full wheelspin or `speed` m/s; a seat shakes less
const CHASE_LOOK_AHEAD = 5.2; // m ahead of the car the chase camera looks (cameras.js's chase)

class SwimCamera {
  constructor() {
    this.seatRoll = 0; // see seatView()
    this.speedFov = 0; // ° added to the preset's field of view (SPEED_FOV)
    this.launchLag = 0; // m the chase camera has fallen back (LAUNCH_LAG)
    this.scoreKick = new ScoreKick(); // a close call's or split's punch: scoreKick.trigger(split)
  }

  // The follow cameras' extra pull-back this frame (LAUNCH_LAG), eased; 0 for anything without drift physics
  fallBack(entity, dt) {
    const pulling = Number.isFinite(entity.longAccel) ? Math.max(0, entity.longAccel) : 0;
    this.launchLag += (LAUNCH_LAG.perAccel * pulling - this.launchLag) * (1 - Math.exp(-dt * LAUNCH_LAG.rate));
    return this.launchLag;
  }

  // A drifting car steers the chase camera by its own camera yaw (entity.cameraYaw, swung toward the direction of the
  // slide) instead of its heading: the chase framing cameras.js has just set, turned to that yaw. Its height and the
  // `horizDist` it sits back are cameras.js's; CHASE_LOOK_AHEAD is the point ahead of the car it looks at there.
  swingChase(cameras, entity, desiredPos, desiredLook, horizDist) {
    if (entity.cameraYaw === undefined || entity.cameraYaw === null) return;
    const chaseYaw = entity.cameraYaw + cameras.orbitYawOffset;
    desiredPos.x = entity.position.x - Math.sin(chaseYaw) * horizDist;
    desiredPos.z = entity.position.z - Math.cos(chaseYaw) * horizDist;
    desiredLook.x = entity.position.x + Math.sin(entity.cameraYaw) * CHASE_LOOK_AHEAD;
    desiredLook.z = entity.position.z + Math.cos(entity.cameraYaw) * CHASE_LOOK_AHEAD;
  }

  // Once the camera has eased to its framing, before it is placed: the near plane for a seat, then SPEED_FOV and SHAKE.
  // Returns whether the view is from a seat (cameras.js then rolls it by seatRoll once it looks at its target).
  frame(cameras, entity, dt, elapsed) {
    // A seat inside the vehicle has a dashboard and hands within half a metre of the eye
    const seated = cameras.activePresetId === 'pov' && Boolean(entity.povEye);
    const near = seated ? SEAT_NEAR : DEFAULT_NEAR;
    if (cameras.camera.near !== near) {
      cameras.camera.near = near;
      cameras.camera.updateProjectionMatrix();
    }
    this.feelSpeed(cameras, entity, dt, elapsed, seated);
    return seated;
  }

  // SPEED_FOV and SHAKE for a drift-physics car in a follow view; everything else keeps its preset's field of view
  feelSpeed(cameras, entity, dt, elapsed, seated) {
    const preset = cameras.getActivePreset();
    const following = preset.category === 'follow' && Number.isFinite(entity.longAccel);
    let wider = 0;
    if (following) {
      const clamp01 = (x) => Math.max(0, Math.min(1, x));
      wider = SPEED_FOV.perSpeed * clamp01(Math.abs(entity.speed) / SPEED_FOV.speed)
        + SPEED_FOV.perAccel * clamp01(entity.longAccel / SPEED_FOV.accel);
    }
    this.speedFov += (wider - this.speedFov) * (1 - Math.exp(-dt * SPEED_FOV.rate));
    // (and the punch of a close call or split, on top: swim-camera-kick.js)
    const kick = this.scoreKick.update(dt);
    const fov = preset.fov + this.speedFov + (following ? kick.fov : 0);
    if (Math.abs(cameras.camera.fov - fov) > 0.02) {
      cameras.camera.fov = fov;
      cameras.camera.updateProjectionMatrix();
    }
    if (!following) return;
    const spin = entity.drift?.wheelspin ?? 0;
    const fast = Math.min(1, (Math.abs(entity.speed) / SHAKE.speed) ** 2);
    const shake = (SHAKE.amount * Math.min(1, spin + fast) + kick.shake) * (seated ? SHAKE.seatShare : 1);
    if (shake > 0.0005) {
      // (a few incommensurate sines: a rough, unrepeating shiver, no allocation)
      cameras.currentPos.x += shake * (Math.sin(elapsed * 37.1) + Math.sin(elapsed * 23.3)) * 0.5;
      cameras.currentPos.y += shake * (Math.sin(elapsed * 41.7) + Math.sin(elapsed * 29.9)) * 0.5;
    }
  }

  // First person from a seat: entity.povEye is the eye in the vehicle's chassis frame (+z forward), entity.povPitch
  // tips the view down. The eye rides the chassis' heave, pitch and roll (Euler XYZ: roll applied first); the view
  // takes only part of the pitch and roll, so the cabin moves a little around the driver as it does in a real car.
  seatView(cameras, entity, desiredPos, desiredLook) {
    const eye = entity.povEye;
    const chassis = entity.chassisPivot;
    const pitch = chassis ? chassis.rotation.x : 0;
    const roll = chassis ? chassis.rotation.z : 0;
    const lift = chassis ? chassis.position.y : 0;
    const x = eye.x * Math.cos(roll) - eye.y * Math.sin(roll);
    const rolledY = eye.x * Math.sin(roll) + eye.y * Math.cos(roll);
    const y = rolledY * Math.cos(pitch) - eye.z * Math.sin(pitch);
    const z = rolledY * Math.sin(pitch) + eye.z * Math.cos(pitch);
    const sin = Math.sin(entity.heading), cos = Math.cos(entity.heading);
    desiredPos.set(
      entity.position.x + x * cos + z * sin,
      entity.position.y + lift + y,
      entity.position.z - x * sin + z * cos
    );

    // povYaw: where the driver is looking (the swim show watching the cop); povGlance: a look out of the window (the bird)
    const yaw = entity.heading + cameras.orbitYawOffset + (entity.povYaw ?? 0) + (entity.povGlance ?? 0);
    const down = (entity.povPitch ?? 0) + pitch * SEAT_BODY_FOLLOW + (cameras.orbitPitchOffset - 0.09);
    desiredLook.set(
      desiredPos.x + Math.sin(yaw) * Math.cos(down) * 40.0,
      desiredPos.y - Math.sin(down) * 40.0,
      desiredPos.z + Math.cos(yaw) * Math.cos(down) * 40.0
    );
    this.seatRoll = roll * SEAT_BODY_FOLLOW;
  }
}

export { SwimCamera };
