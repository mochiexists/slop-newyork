// A flight recorder for the swimming car: every frame of the driving (the keys fed to the keyboard driver, the car's
// state before the frame's physics, the camera) kept in memory and sent in chunks to the local dev server, so a
// physics change can be replayed against the player's real driving (replay-session.cjs in the drift-physics scratch,
// fujira/scratch/2026-11-01/drift-physics/tools, with the dev server that takes the POSTs).
//
// swim-car.js calls frame() once per swim step before the keyboard driver runs; installSessionRecorder() (main.js's
// one call) flushes every FLUSH_SECONDS and as the page hides or closes, and downloads the session on L (a file, for a
// server without the endpoint). A failed POST does nothing: the game never waits on, or complains about, the recorder.
//
// Each frame is an array in FIELDS order. A frame's state is the state the frame started from, so frame i's keys and
// dt applied to frame i's state should give frame i + 1's (collisions with buildings and traffic aside). The keyboard
// driver's memory (its wheel, pedal, commit ...) is snapshot every KEYFRAME_EVERY frames and at each segment start,
// so a replay can start from any keyframe. A segment starts at the first frame, after a gap (another mode, a pause) and
// after a teleport.
//
// With the swim clock (swim-clock.js) a "frame" here is a tick of it: dt is the tick, `tick` its number and `player`
// the keys the player held for it (bits W 1, S 2, A 4, D 8, Space 16; the AI's are in forward ... handbrake). Each run
// the clock starts (entering swim mode, the AI show, a teleport) is noted in `runs` as [frame index, start]: the tick
// it starts on, its traffic seed and spot, the city's clock, the car's whole state (and its keyboard driver's) and the
// cop's. Keys pressed between ticks that change the car outside the physics (T, Z, X, I, P) are `events` [frame index,
// name]: they took effect before that frame. A run's start, its events and the player's keys tick by tick are all a
// replay needs (tools/swim-replay); `build` says which code recorded it (the git commit if the page's server shows
// .git, and a hash of the modules' text).

const FIELDS = [
  't', 'dt', 'forward', 'backward', 'left', 'right', 'handbrake', 'ai',
  'x', 'z', 'heading', 'speed', 'vx', 'vz', 'angularVel', 'steerAngle', 'longAccel', 'gear', 'rpm', 'wheelSlip',
  'limiterTime', 'manual', 'slipAngle', 'wheelspin', 'camera', 'tick', 'player'
];
const FLUSH_SECONDS = 5; // (short enough that what's left when the page closes fits one keepalive request)
const KEYFRAME_EVERY = 30; // frames between snapshots of the keyboard driver
const CHUNK_FRAMES = 300; // frames per POST as the page closes: ~45 KB of JSON
const MAX_FRAMES = 60 * 60 * 30; // frames kept in memory for download(): the last quarter hour of 120 Hz ticks
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

// The car's whole state, as a replay puts it back: its numbers and flags, where it is, its drift telemetry and the
// chassis' springs (which live on the body's pivot). Unrounded: a replay starts from exactly this.
function snapshotCar(car) {
  const out = {};
  for (const [key, value] of Object.entries(car)) {
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  out.position = { x: car.position.x, y: car.position.y ?? 0, z: car.position.z };
  out.drift = {};
  for (const [key, value] of Object.entries(car.drift ?? {})) {
    if (typeof value === 'number' || typeof value === 'boolean') out.drift[key] = value;
  }
  const pivot = car.chassisPivot;
  if (pivot) out.chassis = { pitch: pivot.rotation.x, roll: pivot.rotation.z, heave: pivot.position.y };
  return out;
}

// A short hash of a text (FNV-1a, 32 bits, hex)
function hashText(text, hash = 0x811c9dc5) {
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash;
}

// Which code is running: the git commit when the server shows the checkout's .git (the dev server serves the repo),
// and always a hash of the text of the page's own modules (js/*.js as loaded). `fetchText(url)` → text or null.
async function buildId(urls, fetchText) {
  const build = { commit: null, modules: 0, hash: null };
  try {
    const head = (await fetchText('.git/HEAD'))?.trim();
    if (head?.startsWith('ref: ')) build.commit = (await fetchText(`.git/${head.slice(5)}`))?.trim() || null;
    else if (/^[0-9a-f]{40}$/.test(head ?? '')) build.commit = head;
    if (build.commit && !/^[0-9a-f]{40}$/.test(build.commit)) build.commit = null;
  } catch {
    // no .git on this server
  }
  let hash = 0x811c9dc5;
  for (const url of [...urls].sort()) {
    const text = await fetchText(url);
    if (text === null) continue;
    hash = hashText(`${url}\n${text}`, hash);
    build.modules++;
  }
  build.hash = hash.toString(16).padStart(8, '0');
  return build;
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
    // The runs' starts and the events, [index of the frame they come before, note], not sent yet and all of them
    this.pendingNotes = { runs: [], events: [] };
    this.allNotes = { runs: [], events: [] };
    this.build = null; // { commit, modules, hash } once known (installSessionRecorder)
    this.frameCount = 0;
    this.lastT = -Infinity;
    this.lastX = 0;
    this.lastZ = 0;
    this.lastSpeed = 0;
  }

  // A note that comes before the next frame. `seq` orders notes before the same frame: an event pressed before a run
  // starts is already in the run's snapshot, one after it is not.
  note(kind, value) {
    value.seq = this.notes = (this.notes ?? 0) + 1;
    this.pendingNotes[kind].push([this.pending.length, value]);
    this.allNotes[kind].push([this.dropped + this.all.length, value]);
  }

  /**
   * A run starts (swim-clock.js): `run` { tick, seed, x, z, reason, elapsed }, then the car, its keyboard driver, the
   * cop and the AI show (its phase, and the gearbox it hands a player back) as they are before its first tick.
   */
  run(run, car, driver, cruiser = null, show = null) {
    const { tick, seed, x, z, reason, elapsed } = run;
    // (a cop parked after a chase may still be creeping: its motion is what a collision with it reads)
    const c = cruiser?.car;
    const cop = cruiser ? { state: cruiser.state, retired: Boolean(cruiser.retired), x: c.position.x, z: c.position.z,
      heading: c.heading, speed: c.speed ?? 0, vx: c.vx ?? 0, vz: c.vz ?? 0, angularVel: c.angularVel ?? 0 } : null;
    const ai = show ? { phase: show.phase, playerManual: Boolean(show.playerManual) } : null;
    this.note('runs', { tick, seed, x, z, reason, elapsed, car: snapshotCar(car), driver: snapshotDriver(driver), cruiser: cop, show: ai });
  }

  /** A key that changed the car outside the physics (T, Z, X, I, P), before the next tick: { name, tick } */
  event(name, tick) {
    this.note('events', { name, tick });
  }

  /**
   * One swim frame (a tick of the swim clock), before the keyboard driver and the physics run on it: the keys it is
   * given (after any AI), whether the AI drove, the player's own keys as bits and the tick's number.
   */
  frame(car, keys, dt, driver, ai = false, player = 0, tick = null) {
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
      round(tel.slipAngle, 4), round(tel.wheelspin, 3), this.camera() || '', tick ?? -1, player
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
      for (const notes of Object.values(this.allNotes)) while (notes.length && notes[0][0] < this.dropped) notes.shift();
    }
    this.frameCount++;
    this.lastT = t;
    this.lastX = car.position.x;
    this.lastZ = car.position.z;
    this.lastSpeed = Math.hypot(car.speed, car.vx, car.vz);
  }

  // The JSON body of a chunk of frames
  body(frames, drivers, chunk, notes = { runs: [], events: [] }) {
    return JSON.stringify({ session: this.session, chunk, build: this.build, fields: FIELDS, drivers, ...notes, frames });
  }

  // The pending notes with an index in [start, end), indexed within that piece
  notesIn(start, end, last) {
    const out = {};
    for (const [kind, notes] of Object.entries(this.pendingNotes)) {
      out[kind] = notes.filter(([index]) => index >= start && (index < end || (last && index === end)))
        .map(([index, value]) => [index - start, value]);
    }
    return out;
  }

  /**
   * Sends the frames since the last flush in one POST; nothing to send, or a failed POST, does nothing. As the page
   * closes (closing) only keepalive requests get out, and the browser lets 64 KB of them be in flight: the frames go in
   * pieces of CHUNK_FRAMES, the first of which fits.
   */
  flush(closing = false) {
    const size = closing ? CHUNK_FRAMES : Math.max(1, this.pending.length);
    for (let start = 0; start < this.pending.length; start += size) {
      const end = Math.min(start + size, this.pending.length);
      const drivers = this.pendingDrivers.filter(([index]) => index >= start && index < end)
        .map(([index, snapshot]) => [index - start, snapshot]);
      // (a note just after the last frame, a run that starts at the next tick, goes with the last piece)
      const notes = this.notesIn(start, end, end === this.pending.length);
      const body = this.body(this.pending.slice(start, end), drivers, this.chunk++, notes);
      try {
        Promise.resolve(this.post(body, closing)).catch(() => {});
      } catch {
        // no server, no network: the recorder stays quiet
      }
    }
    // Notes made since the last frame wait for the frame they come before: a run noted with nothing recorded yet
    for (const kind of Object.keys(this.pendingNotes)) {
      this.pendingNotes[kind] = this.pending.length ? [] : this.pendingNotes[kind];
    }
    this.pending = [];
    this.pendingDrivers = [];
  }

  /** The whole session in memory as one chunk (what download() saves). */
  snapshot() {
    const drivers = this.allDrivers.map(([index, snap]) => [index - this.dropped, snap]);
    const notes = {};
    for (const [kind, list] of Object.entries(this.allNotes)) notes[kind] = list.map(([index, value]) => [index - this.dropped, value]);
    return this.body(this.all, drivers, 'all', notes);
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
  const local = ['127.0.0.1', 'localhost'].includes(globalThis.location?.hostname);
  const recorder = new SessionRecorder({ camera: () => cameraSystem.activePresetId, post: local ? undefined : () => {} });
  controllerManager.swimRecorder = recorder;
  // Which code this is: the page's own modules (as loaded) and the commit, if the server shows .git
  const fetchText = (url) => fetch(url, { cache: 'force-cache' }).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  const modules = (globalThis.performance?.getEntriesByType?.('resource') ?? [])
    .map((entry) => entry.name).filter((url) => url.startsWith(globalThis.location?.origin ?? '-') && /\/js\/[^/]+\.js$/.test(url));
  buildId(new Set(modules), fetchText).then((build) => {
    recorder.build = build;
  }).catch(() => {});
  setInterval(() => recorder.flush(), FLUSH_SECONDS * 1000);
  window.addEventListener('pagehide', () => recorder.flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) recorder.flush(true);
  });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyL' || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTypingInField(e)) return;
    recorder.flush();
    try {
      recorder.download();
      onSaved();
    } catch {
      // no Blob or object URLs here: the session still went to the dev server
    }
  });
  return recorder;
}

export {
  SessionRecorder, installSessionRecorder, FIELDS, FLUSH_SECONDS, KEYFRAME_EVERY, MAX_FRAMES, buildId, hashText, snapshotCar,
  snapshotDriver, sessionStamp
};
