// A flight recorder for the swimming car: every frame of the driving (the keys fed to the keyboard driver, the car's
// state before the frame's physics, the camera) kept in memory and sent in chunks to the local dev server, so a
// physics change can be replayed against the player's real driving (replay-session.cjs in the drift-physics scratch,
// fujira/scratch/2026-11-01/drift-physics/tools, with the dev server that takes the POSTs).
//
// controllers.js calls frame() once per swim frame before the keyboard driver runs; installSessionRecorder() (main.js's
// one call) flushes every FLUSH_SECONDS and as the page hides or closes, and downloads the session on L (a file, for a
// server without the endpoint). A failed POST does nothing: the game never waits on, or complains about, the recorder.
//
// Each frame is an array in FIELDS order. A frame's state is the state the frame started from, so frame i's keys and
// dt applied to frame i's state should give frame i + 1's (collisions with buildings and traffic aside). The keyboard
// driver's memory (its wheel, pedal, commit ...) is snapshot every KEYFRAME_EVERY frames and at each segment start,
// so a replay can start from any keyframe. A segment starts at the first frame, after a gap (another mode, a pause) and
// after a teleport.

const FIELDS = [
  't', 'dt', 'forward', 'backward', 'left', 'right', 'handbrake', 'ai',
  'x', 'z', 'heading', 'speed', 'vx', 'vz', 'angularVel', 'steerAngle', 'longAccel', 'gear', 'rpm', 'wheelSlip',
  'limiterTime', 'manual', 'slipAngle', 'wheelspin', 'camera'
];
const FLUSH_SECONDS = 5; // (short enough that what's left when the page closes fits one keepalive request)
const KEYFRAME_EVERY = 30; // frames between snapshots of the keyboard driver
const CHUNK_FRAMES = 300; // frames per POST as the page closes: ~45 KB of JSON
const MAX_FRAMES = 60 * 60 * 30; // frames kept in memory for download(): the last half hour at 60 fps
const GAP_SECONDS = 0.5; // a pause longer than this between swim frames starts a new segment
const TELEPORT_SLACK = 5; // m a frame may move beyond its speed before it reads as a teleport
const ENDPOINT = '/session-log';
const KEEPALIVE_BYTES = 60000; // the browser lets 64 KB of keepalive requests be in flight at once

// Rounds to a fixed number of decimals, keeping the JSON small
function round(value, decimals) {
  const scale = 10 ** decimals;
  return Math.round((Number(value) || 0) * scale) / scale;
}

// The keyboard driver's own memory: its numbers and flags, not its params, model or input objects
function snapshotDriver(driver) {
  const out = {};
  if (!driver) return out;
  for (const [key, value] of Object.entries(driver)) {
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

// The session's name: the local time it started, 2026-11-01T14-05-09-123
function sessionStamp(date = new Date()) {
  const two = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const time = `${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}`;
  return `${day}T${time}-${String(date.getMilliseconds()).padStart(3, '0')}`;
}

class SessionRecorder {
  constructor({ now = () => performance.now() / 1000, post = null, camera = () => '' } = {}) {
    this.now = now;
    this.camera = camera; // () => the active camera preset's id
    this.post = post ?? ((body, keepalive) => fetch(ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: keepalive && body.length < KEEPALIVE_BYTES
    }));
    this.session = sessionStamp();
    this.startedAt = now();
    this.chunk = 0;
    this.pending = []; // frames not sent yet
    this.pendingDrivers = []; // [index in pending, driver snapshot]
    this.all = []; // every frame (capped), for download()
    this.allDrivers = [];
    this.dropped = 0; // frames that fell off the front of `all`
    this.frameCount = 0;
    this.lastT = -Infinity;
    this.lastX = 0;
    this.lastZ = 0;
    this.lastSpeed = 0;
  }

  /** One swim frame, before the keyboard driver and the physics run on it. */
  frame(car, keys, dt, driver, ai = false) {
    const t = this.now() - this.startedAt;
    const moved = Math.hypot(car.position.x - this.lastX, car.position.z - this.lastZ);
    const reach = (Math.abs(this.lastSpeed) + 10) * Math.max(dt, t - this.lastT) + TELEPORT_SLACK;
    const segmentStart = t - this.lastT > GAP_SECONDS || moved > reach;
    const tel = car.drift || {};
    const row = [
      round(t, 3), round(dt, 4), round(keys.forward, 2), round(keys.backward, 2), round(keys.left, 2), round(keys.right, 2),
      round(keys.handbrake, 2), ai ? 1 : 0,
      round(car.position.x, 3), round(car.position.z, 3), round(car.heading, 5), round(car.speed, 4), round(car.vx, 4),
      round(car.vz, 4), round(car.angularVel, 5), round(car.steerAngle, 5), round(car.longAccel, 4), car.gear ?? 0,
      round(car.rpm, 0), round(car.wheelSlip, 4), round(car.limiterTime, 4), car.manual ? 1 : 0,
      round(tel.slipAngle, 4), round(tel.wheelspin, 3), this.camera() || ''
    ];
    if (segmentStart || this.frameCount % KEYFRAME_EVERY === 0) {
      const snapshot = snapshotDriver(driver);
      if (segmentStart) snapshot.segmentStart = true;
      this.pendingDrivers.push([this.pending.length, snapshot]);
      this.allDrivers.push([this.dropped + this.all.length, snapshot]);
    }
    this.pending.push(row);
    this.all.push(row);
    if (this.all.length > MAX_FRAMES) {
      const cut = this.all.length - MAX_FRAMES;
      this.all.splice(0, cut);
      this.dropped += cut;
      while (this.allDrivers.length && this.allDrivers[0][0] < this.dropped) this.allDrivers.shift();
    }
    this.frameCount++;
    this.lastT = t;
    this.lastX = car.position.x;
    this.lastZ = car.position.z;
    this.lastSpeed = Math.hypot(car.speed, car.vx, car.vz);
  }

  // The JSON body of a chunk of frames
  body(frames, drivers, chunk) {
    return JSON.stringify({ session: this.session, chunk, fields: FIELDS, drivers, frames });
  }

  /**
   * Sends the frames since the last flush in one POST; nothing to send, or a failed POST, does nothing. As the page
   * closes (closing) only keepalive requests get out, and the browser lets 64 KB of them be in flight: the frames go in
   * pieces of CHUNK_FRAMES, the first of which fits.
   */
  flush(closing = false) {
    const size = closing ? CHUNK_FRAMES : Math.max(1, this.pending.length);
    for (let start = 0; start < this.pending.length; start += size) {
      const end = start + size;
      const drivers = this.pendingDrivers.filter(([index]) => index >= start && index < end)
        .map(([index, snapshot]) => [index - start, snapshot]);
      const body = this.body(this.pending.slice(start, end), drivers, this.chunk++);
      try {
        Promise.resolve(this.post(body, closing)).catch(() => {});
      } catch {
        // no server, no network: the recorder stays quiet
      }
    }
    this.pending = [];
    this.pendingDrivers = [];
  }

  /** The whole session in memory as one chunk (what download() saves). */
  snapshot() {
    const drivers = this.allDrivers.map(([index, snap]) => [index - this.dropped, snap]);
    return this.body(this.all, drivers, 'all');
  }

  /** Saves the session in memory as a file through the browser (works without the dev server's endpoint). */
  download() {
    const blob = new Blob([this.snapshot()], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `swim-session-${this.session}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
}

/**
 * Puts a recorder on the swimming car (main.js's one call): controllers.js feeds it each swim frame, it flushes every
 * FLUSH_SECONDS and as the page hides or closes, and L saves the session (onSaved, e.g. a HUD flash). The POSTs only go
 * out when the game is served from this machine (the dev server's /session-log).
 */
function installSessionRecorder({ controllerManager, cameraSystem, onSaved = () => {}, isTypingInField = () => false }) {
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
  const recorder = new SessionRecorder({ camera: () => cameraSystem.activePresetId, post: local ? undefined : () => {} });
  controllerManager.swimRecorder = recorder;
  setInterval(() => recorder.flush(), FLUSH_SECONDS * 1000);
  window.addEventListener('pagehide', () => recorder.flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) recorder.flush(true);
  });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyL' || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTypingInField(e)) return;
    recorder.flush();
    recorder.download();
    onSaved();
  });
  return recorder;
}

export { SessionRecorder, installSessionRecorder, FIELDS, FLUSH_SECONDS, KEYFRAME_EVERY, MAX_FRAMES, snapshotDriver, sessionStamp };
