import * as THREE from 'three/webgpu';
import { attribute, float, texture, vec3 } from 'three/tsl';
import { avenueX, streetZ } from './city-config.js';
import { BODY_SPECS } from './cars.js';
import { PoliceCruiser, SwimShow, SHOW_SPOT, SHOW_SIGNAL_TIME } from './swim-show.js';

// Swimming: the BMW M5 weaving through traffic and drifting through Times Square to Careless Whisper. This module owns
// everything about the mode except the car itself (controllers.js) and its physics (drift-physics.js): the
// soundtrack, the drift score, tire smoke, skid marks, the tire screech, the two clip start points and the clip's
// route on the map.

const RAD = Math.PI / 180;

// George Michael's official video, streamed by YouTube's own player when swimming begins; nothing is stored here.
// Label uploads often refuse embedding (player error 150, seen from localhost on 2026-10-29), so a lyric upload that
// embeds is the fallback. Driving, it plays from the top; the show starts it where the BMW donut short (REFERENCE_CLIPS)
// picks it up, the chorus at 2:39: `chorus` is that point on each upload, found by matching the short's audio against
// theirs on 2026-10-30 (a clear match, unbroken for the short's 21 s).
const CARELESS_WHISPER = {
  videoIds: ['izGwDsrQ1eQ', 'JqIHlDVqUTw'],
  start: 0,
  chorus: [159.25, 159.45],
  title: 'Careless Whisper',
  artist: 'George Michael'
};

// Where the two reference clips start. Heading 0 faces south (+z), PI north.
const SWIM_STARTS = {
  squeeze: {
    name: 'Times Square swim',
    sub: 'Squeeze Benz clip · 7th Ave & W 47th St',
    x: avenueX('7') + 3.6,
    z: streetZ(47),
    heading: 0
  },
  donuts: {
    name: 'NYPD donuts',
    sub: 'BMW short · 11th Ave & W 42nd St',
    x: avenueX('11'),
    z: streetZ(42),
    heading: Math.PI
  }
};

// The Manhattan part of the Squeeze Benz drive, read off the clip: down 7th Ave through Times Square, west on 42nd,
// up 8th Ave past Smith's at 44th St, west on 57th toward the West Side Highway (the clip then leaves the island).
const SQUEEZE_ROUTE = [
  [avenueX('7'), streetZ(47)],
  [avenueX('7'), streetZ(42)],
  [avenueX('8'), streetZ(42)],
  [avenueX('8'), streetZ(57)],
  [avenueX('11'), streetZ(57)]
].map(([x, z]) => ({ x, z }));

const DRIFT_SLIP = 12 * RAD; // body slip that counts as a drift
const DRIFT_MIN_SPEED = 2.5; // m/s over the ground (a donut's tail swings round at about this)
const DRIFT_GRACE = 0.7; // s a drift may straighten before it is banked
const SKID_SLIDE = 3.2; // m/s of rear tire slide before rubber is laid
const SMOKE_SLIDE = 5; // m/s of rear tire slide before smoke
const CRASH_SPEED_CHANGE = 5; // m/s of velocity change in one frame
const CLOSE_GAP = 1; // m of air at most between the cars for a pass to count as a close call
const CLOSE_SPEED = 8; // m/s at least the swimmer passes the other car by
const CLOSE_CHAIN_TIME = 3; // s between close calls that keeps a chain going
const CLOSE_CHAIN_MAX = 5;
// A split: close calls on both sides within this many seconds, the swimmer through the gap between two cars. It scores
// SPLIT_BONUS times as much.
const SPLIT_WINDOW = 0.8;
const SPLIT_BONUS = 2;
const CLOSE_RANGE = 14; // m around the car that traffic is checked for close calls
const SWIM_HALF_WIDTH = 0.97; // m: the swim car's half width and half length
const SWIM_HALF_LENGTH = 2.52;
const SMOKE_COUNT = 220;
const SKID_COUNT = 2400;

function createPuffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Camera-facing puffs from the rear tires: they swell, rise and thin out.
class TireSmoke {
  constructor(scene) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(SMOKE_COUNT), 1);
    geometry.setAttribute('smokeAlpha', this.alpha);
    const material = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 1, metalness: 0 });
    const puff = texture(createPuffTexture());
    material.colorNode = vec3(0.74, 0.75, 0.77);
    material.opacityNode = puff.a.mul(attribute('smokeAlpha', 'float'));
    this.mesh = new THREE.InstancedMesh(geometry, material, SMOKE_COUNT);
    this.mesh.name = 'SwimTireSmoke';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 990;
    this.particles = Array.from({ length: SMOKE_COUNT }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 1, life: 1, size: 1 }));
    this.next = 0;
    this.live = 0;
    this._matrix = new THREE.Matrix4();
    this._position = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < SMOKE_COUNT; i++) this.mesh.setMatrixAt(i, hidden);
    scene.add(this.mesh);
  }

  // (x, y, z) the tire, (vx, vz) the car's velocity, (fx, fz) its forward direction, side ±1 the tire's side
  emit(x, y, z, vx, vz, strength, fx, fz, side) {
    const p = this.particles[this.next];
    this.next = (this.next + 1) % SMOKE_COUNT;
    p.x = x + (Math.random() - 0.5) * 0.3;
    p.y = y + 0.25;
    p.z = z + (Math.random() - 0.5) * 0.3;
    // A spinning tire throws its smoke back and out to its side; a little of the car's velocity carries on with it
    const throwBack = 2 + Math.random() * 3.5;
    const throwOut = side * (0.6 + Math.random() * 1.6);
    p.vx = vx * 0.12 - fx * throwBack + fz * throwOut + (Math.random() - 0.5) * 0.8;
    p.vy = 0.5 + Math.random() * 0.6;
    p.vz = vz * 0.12 - fz * throwBack - fx * throwOut + (Math.random() - 0.5) * 0.8;
    p.age = 0;
    p.life = 1.2 + strength * 1.4 + Math.random() * 0.6;
    p.size = 0.5 + strength * 0.5;
    this.live = SMOKE_COUNT;
  }

  update(dt, camera) {
    if (!this.live) return;
    let alive = 0;
    for (let i = 0; i < SMOKE_COUNT; i++) {
      const p = this.particles[i];
      if (p.age >= p.life) {
        if (this.alpha.array[i] !== 0) {
          this.alpha.array[i] = 0;
          this.mesh.setMatrixAt(i, this._matrix.makeScale(0, 0, 0));
        }
        continue;
      }
      alive++;
      p.age += dt;
      const drag = Math.exp(-dt * 1.4);
      p.vx *= drag;
      p.vz *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const t = Math.min(1, p.age / p.life);
      const size = p.size * (1 + t * 2.6);
      // Fade in over the first moments so a puff doesn't pop, then thin out as it spreads. Puffs reaching the camera
      // fade away, or a burnout fills the screen with white.
      const toCamera = Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z);
      const nearFade = Math.min(1, Math.max(0, (toCamera - size * 0.5 - 1) / 4));
      this.alpha.array[i] = 0.2 * Math.min(1, p.age / 0.18) * (1 - t) ** 1.6 * nearFade;
      this._position.set(p.x, p.y, p.z);
      this._scale.set(size, size, size);
      this.mesh.setMatrixAt(i, this._matrix.compose(this._position, camera.quaternion, this._scale));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.live = alive;
  }
}

// Rubber laid by the rear tires: a ring of thin dark strips flat on the road.
class SkidMarks {
  constructor(scene) {
    const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI * 0.5);
    const material = new THREE.MeshStandardNodeMaterial({
      color: 0x0b0b0c,
      roughness: 0.95,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4
    });
    material.opacityNode = float(0.62);
    this.mesh = new THREE.InstancedMesh(geometry, material, SKID_COUNT);
    this.mesh.name = 'SwimSkidMarks';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = false;
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < SKID_COUNT; i++) this.mesh.setMatrixAt(i, hidden);
    this.next = 0;
    this.dirty = false;
    this._matrix = new THREE.Matrix4();
    this._rotation = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._position = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    scene.add(this.mesh);
  }

  add(x0, z0, x1, z1, y) {
    const dx = x1 - x0, dz = z1 - z0;
    const length = Math.hypot(dx, dz);
    if (length < 0.05) return;
    this._position.set((x0 + x1) * 0.5, y + 0.022, (z0 + z1) * 0.5);
    this._rotation.setFromAxisAngle(this._up, Math.atan2(dx, dz));
    this._scale.set(0.26, 1, length + 0.04);
    this.mesh.setMatrixAt(this.next, this._matrix.compose(this._position, this._rotation, this._scale));
    this.next = (this.next + 1) % SKID_COUNT;
    this.dirty = true;
  }

  update() {
    if (!this.dirty) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.dirty = false;
  }
}

// Tire squeal: filtered noise mixed into the city's audio graph, louder the harder the rear tires slide.
class TireScreech {
  constructor(audioSystem) {
    this.audio = audioSystem;
    this.voice = null;
  }

  build(context) {
    const length = context.sampleRate * 2;
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1350;
    band.Q.value = 3.2;
    const gain = context.createGain();
    gain.gain.value = 0;
    source.connect(band).connect(gain).connect(this.audio.mix);
    source.start();
    this.voice = { context, source, band, gain };
  }

  // A close call's rush of air: the same noise, swept down through a band filter in half a second
  whoosh(strength) {
    const context = this.audio.context;
    if (!this.voice || this.voice.context !== context || !this.audio.enabled) return;
    const now = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = this.voice.source.buffer;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.4;
    band.frequency.setValueAtTime(2600, now);
    band.frequency.exponentialRampToValueAtTime(380, now + 0.5);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.5 * strength + 0.05, now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    source.connect(band).connect(gain).connect(this.audio.mix);
    source.onended = () => gain.disconnect();
    source.start(now, Math.random(), 0.6);
  }

  update(slide, speed, active) {
    const context = this.audio.context;
    if (!context || !this.audio.mix || context.state === 'closed') return;
    if (!this.voice || this.voice.context !== context) this.build(context);
    const level = active && this.audio.enabled ? Math.min(1, Math.max(0, (slide - SKID_SLIDE) / 14)) : 0;
    const now = context.currentTime;
    this.voice.gain.gain.setTargetAtTime(level * 0.32, now, 0.05);
    this.voice.band.frequency.setTargetAtTime(1100 + Math.min(900, speed * 22) + level * 300, now, 0.08);
  }
}

// The soundtrack, through YouTube's IFrame Player API. The API script and player load on the first swim; if the
// browser blocks playback the card offers a play button.
class SwimRadio {
  constructor(card) {
    this.card = card;
    this.player = null;
    this.ready = false;
    this.wanted = false;
    this.muted = false;
    this.loading = null;
    this.blockedTimer = 0;
    card?.querySelector('[data-swim-radio="play"]')?.addEventListener('click', () => this.play());
    card?.querySelector('[data-swim-radio="pause"]')?.addEventListener('click', () => this.pause());
  }

  load() {
    if (this.loading) return this.loading;
    this.loading = new Promise((resolve, reject) => {
      if (globalThis.YT?.Player) {
        resolve(globalThis.YT);
        return;
      }
      const previous = globalThis.onYouTubeIframeAPIReady;
      globalThis.onYouTubeIframeAPIReady = () => {
        if (typeof previous === 'function') previous();
        resolve(globalThis.YT);
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => reject(new Error('YouTube player unavailable'));
      document.head.appendChild(script);
    }).then((YT) => new Promise((resolve) => {
      this.source = 0;
      this.player = new YT.Player('swim-radio-player', {
        width: 240,
        height: 135,
        videoId: CARELESS_WHISPER.videoIds[0],
        playerVars: { start: CARELESS_WHISPER.start, playsinline: 1, rel: 0, modestbranding: 1, controls: 0 },
        events: {
          onReady: () => {
            this.ready = true;
            this.applyMute();
            // The show's drift may have begun while the player loaded: start on the chorus all the same
            if (this.cued) this.cueChorus();
            else if (this.wanted) this.player.playVideo();
            resolve();
          },
          onStateChange: (event) => this.onState(event.data),
          onError: () => this.tryNextSource()
        }
      });
    })).catch(() => this.setStatus('offline'));
    return this.loading;
  }

  // The upload refused to play here (embedding disabled, region, removed): move on to the next one
  tryNextSource() {
    this.source++;
    if (this.source >= CARELESS_WHISPER.videoIds.length) {
      this.setStatus('offline');
      return;
    }
    const startSeconds = this.cued ? CARELESS_WHISPER.chorus[this.source] : CARELESS_WHISPER.start;
    const options = { videoId: CARELESS_WHISPER.videoIds[this.source], startSeconds };
    if (this.wanted) this.player.loadVideoById(options);
    else this.player.cueVideoById(options);
  }

  onState(state) {
    // 1 playing, 2 paused, 0 ended (loop the track while swimming)
    if (state === 1) {
      // On the chorus now: from here on the track plays on (and loops from the top) like any other drive
      this.cued = false;
      this.setStatus('playing');
    }
    else if (state === 2) this.setStatus('paused');
    else if (state === 0 && this.wanted) {
      this.player.seekTo(CARELESS_WHISPER.start, true);
      this.player.playVideo();
    }
  }

  setStatus(status) {
    if (this.card) this.card.dataset.status = status;
  }

  play() {
    this.card?.removeAttribute('hidden');
    // Restoring a saved swim on page load has no click behind it: wait for one rather than start the music unasked
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
      this.setStatus('blocked');
      return;
    }
    this.wanted = true;
    if (this.ready) this.player.playVideo();
    else this.load();
    // Autoplay can be refused (no user gesture reached the frame): show the play button instead of silence
    clearTimeout(this.blockedTimer);
    this.blockedTimer = setTimeout(() => {
      if (this.wanted && this.card?.dataset.status !== 'playing' && this.card?.dataset.status !== 'offline') this.setStatus('blocked');
    }, 2500);
  }

  // The show holds the song back, cued on the chorus, until the car swings into its drift (play() then starts it
  // right there)
  cue() {
    this.card?.removeAttribute('hidden');
    this.wanted = false;
    this.cued = true;
    if (this.ready) this.cueChorus();
    else this.load();
    this.setStatus('paused');
  }

  // Loads the chorus, playing it at once if the drift has already begun
  cueChorus() {
    const source = this.source ?? 0;
    const options = { videoId: CARELESS_WHISPER.videoIds[source], startSeconds: CARELESS_WHISPER.chorus[source] };
    if (this.wanted) this.player.loadVideoById(options);
    else this.player.cueVideoById(options);
  }

  pause() {
    this.cued = false;
    this.wanted = false;
    if (this.ready) this.player.pauseVideo();
    this.setStatus('paused');
  }

  stop() {
    this.pause();
    this.card?.setAttribute('hidden', '');
  }

  setMuted(muted) {
    this.muted = muted;
    this.applyMute();
  }

  applyMute() {
    if (!this.ready) return;
    if (this.muted) this.player.mute();
    else this.player.unMute();
  }
}

// Close calls, the fun of swimming: a car passed at speed with less than CLOSE_GAP of air between them. Each one scores,
// more the closer and the faster, and a run of them chains a multiplier, the way a swimmer threads a block. Pure: fed
// the car and the traffic each frame, it returns the points of a close call completed in that frame.
class CloseCalls {
  constructor() {
    this.alongside = new Map(); // vehicle → closest gap while alongside
    this.side = new Map(); // vehicle → the side it was passed on (+1 left, -1 right)
    this.chain = 0;
    this.sinceLast = Infinity;
    this.clock = 0;
    this.lastSide = 0; // the side and time of the last close call, to spot a split
    this.lastAt = -Infinity;
    this.split = false; // the close call update() just scored was a split
  }

  update(dt, car, ...groups) {
    this.sinceLast += dt;
    this.clock += dt;
    this.split = false;
    if (this.sinceLast > CLOSE_CHAIN_TIME) this.chain = 0;
    const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
    let points = 0;
    for (const vehicles of groups) {
      for (const v of vehicles) {
        const dx = v.x - car.position.x, dz = v.z - car.position.z;
        if (!v.edge || Math.abs(dx) > CLOSE_RANGE || Math.abs(dz) > CLOSE_RANGE) {
          this.alongside.delete(v);
          this.side.delete(v);
          continue;
        }
        // In the swim car's frame: metres ahead, to the left, and the other car's extent along and across it
        const ahead = dx * sin + dz * cos;
        const left = dx * cos - dz * sin;
        const rel = (v.yaw ?? 0) - car.heading;
        const relSin = Math.abs(Math.sin(rel)), relCos = Math.abs(Math.cos(rel));
        const half = v.half ?? 2.3, halfWidth = v.halfWidth ?? 0.95;
        const reachAlong = SWIM_HALF_LENGTH + half * relCos + halfWidth * relSin;
        const gap = Math.abs(left) - SWIM_HALF_WIDTH - half * relSin - halfWidth * relCos;
        if (Math.abs(ahead) < reachAlong) {
          const closest = this.alongside.get(v);
          this.alongside.set(v, closest === undefined ? gap : Math.min(closest, gap));
          this.side.set(v, Math.sign(left) || 1);
          continue;
        }
        const closest = this.alongside.get(v);
        if (closest === undefined) continue;
        const side = this.side.get(v);
        this.alongside.delete(v);
        this.side.delete(v);
        // Out the back, untouched, close, and passed rather than drifted past
        const passing = car.speed - (v.speed || 0) * Math.cos(rel);
        if (ahead < 0 && closest > 0 && closest < CLOSE_GAP && passing > CLOSE_SPEED) {
          this.chain = Math.min(CLOSE_CHAIN_MAX, this.chain + 1);
          this.sinceLast = 0;
          const closeness = 1 - closest / CLOSE_GAP;
          const split = side === -this.lastSide && this.clock - this.lastAt < SPLIT_WINDOW;
          if (split) this.split = true;
          this.lastSide = side;
          this.lastAt = this.clock;
          points += Math.round((100 + 400 * closeness) * Math.min(2, car.speed / 25) * this.chain * (split ? SPLIT_BONUS : 1));
        }
      }
    }
    return points;
  }
}

// Drift scoring: points for angle × speed while sliding, banked when the car straightens up, lost in a crash.
class DriftScore {
  constructor(elements) {
    this.el = elements;
    this.points = 0;
    this.total = 0;
    this.best = 0;
    this.time = 0;
    this.grace = 0;
    this.active = false;
    this.flashTimer = 0;
    this.render();
  }

  update(dt, slip, speed) {
    const sliding = Math.abs(slip) > DRIFT_SLIP && Math.abs(speed) > DRIFT_MIN_SPEED;
    if (sliding) {
      this.active = true;
      this.grace = DRIFT_GRACE;
      this.time += dt;
      const angle = Math.min(70, Math.abs(slip) / RAD);
      const chain = 1 + Math.min(4, Math.floor(this.time / 2.5)); // longer drifts multiply
      this.points += angle * Math.abs(speed) * dt * 0.35 * chain;
    } else if (this.active) {
      this.grace -= dt;
      if (this.grace <= 0) this.bank();
    }
    if (this.flashTimer > 0) this.flashTimer -= dt;
  }

  bank() {
    if (this.points >= 1) {
      this.total += Math.round(this.points);
      this.best = Math.max(this.best, Math.round(this.points));
      this.flash(`+${Math.round(this.points).toLocaleString('en-US')} SWIM`, 'banked');
    }
    this.reset();
  }

  // Points scored outright (a close call), with their own flash
  award(points, text) {
    this.total += points;
    this.best = Math.max(this.best, points);
    this.flash(text, 'banked');
  }

  wipeout() {
    if (!this.active || this.points < 50) return;
    this.flash('WIPEOUT', 'lost');
    this.reset();
  }

  reset() {
    this.points = 0;
    this.time = 0;
    this.active = false;
  }

  flash(text, kind) {
    if (!this.el.flash) return;
    this.el.flash.textContent = text;
    this.el.flash.dataset.kind = kind;
    this.el.flash.classList.remove('show');
    void this.el.flash.offsetWidth; // restart the animation
    this.el.flash.classList.add('show');
  }

  render(slip = 0) {
    const { angle, points, total, best, chain } = this.el;
    if (angle) angle.textContent = `${Math.round(Math.abs(slip) / RAD)}°`;
    if (points) points.textContent = this.active ? Math.round(this.points).toLocaleString('en-US') : '—';
    if (total) total.textContent = this.total.toLocaleString('en-US');
    if (best) best.textContent = this.best.toLocaleString('en-US');
    if (chain) chain.textContent = this.active ? `×${1 + Math.min(4, Math.floor(this.time / 2.5))}` : '';
  }
}

// What the HUD says as the AI show moves on
const SHOW_CAPTIONS = {
  burnout: ['BREAKING · SWIMMING IN TIMES SQUARE', 'show'],
  escape: ['NYPD IN PURSUIT', 'lost'],
  swim: ['LOST THEM · SWIMMING', 'banked'],
  countdown: ['YOUR CAR IN…', 'show']
};

class SwimDirector {
  // onShowCamera(preset id): the show's camera cuts (main.js owns the cameras)
  constructor({ scene, controllerManager, audioSystem, trafficSystem, onShowCamera }) {
    this.controllers = controllerManager;
    this.traffic = trafficSystem;
    this.car = controllerManager.entities.swim;
    this.cruiser = new PoliceCruiser(scene, audioSystem);
    this.pilotChip = document.getElementById('swim-pilot');
    this.show = new SwimShow({
      controllerManager,
      trafficSystem,
      cruiser: this.cruiser,
      onPhase: (phase) => this.onShowPhase(phase),
      onCamera: onShowCamera
    });
    this.countdown = document.getElementById('swim-countdown');
    this.shownCount = 0;
    this.clock = 0;
    this.smoke = new TireSmoke(scene);
    this.skids = new SkidMarks(scene);
    this.screech = new TireScreech(audioSystem);
    this.closeCalls = new CloseCalls();
    this.radio = new SwimRadio(document.getElementById('swim-radio'));
    this.score = new DriftScore({
      angle: document.getElementById('swim-angle'),
      points: document.getElementById('swim-points'),
      total: document.getElementById('swim-total'),
      best: document.getElementById('swim-best'),
      chain: document.getElementById('swim-chain'),
      flash: document.getElementById('swim-flash')
    });
    this.active = false;
    this.hudTimer = 0;
    this.smokeBudget = 0;
    // Last contact point of each rear tire, while it is laying rubber
    this.lastContact = [null, null];
    this.lastVX = 0;
    this.lastVZ = 0;
  }

  // The swim mode was entered (true) or left (false)
  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    document.body.classList.toggle('swimming', active);
    if (active) this.radio.play();
    else {
      this.show.stop();
      this.cruiser.hide();
      this.score.bank();
      this.radio.stop();
      this.lastContact[0] = this.lastContact[1] = null;
    }
  }

  // The car is already at SHOW_SPOT (main.js teleports it): run the show from there, the song held for the drift
  startShow() {
    this.radio.cue();
    this.show.start();
  }

  stopShow() {
    this.show.stop();
  }

  // An NYPD cruiser watching from across the street at a clip start
  parkCruiserNear(x, z, heading) {
    const fx = Math.sin(heading), fz = Math.cos(heading);
    this.cruiser.park(x + fx * 18 - fz * 8, z + fz * 18 + fx * 8, heading + Math.PI * 0.75);
  }

  onShowPhase(phase) {
    const caption = SHOW_CAPTIONS[phase];
    if (this.pilotChip) {
      this.pilotChip.hidden = phase === 'off';
      // The chip carries the headline, so a banked drift's flash can't wipe it
      const text = this.pilotChip.querySelector('.swim-pilot-text');
      if (text && caption) text.textContent = `${caption[0]} · any driving key takes the wheel`;
    }
    // The sax comes in as the car swings into its drift round the cop
    if (phase === 'donuts') this.radio.play();
    // Leaving the donuts launches the car: bank them first, and don't take the launch for a crash
    if (phase === 'escape') {
      this.score.bank();
      this.skipImpact = true;
    }
    if (caption) this.score.flash(...caption);
    else if (phase === 'off') this.score.flash('GO · YOUR CAR', 'banked');
  }

  setMuted(muted) {
    this.radio.setMuted(muted);
  }

  // The hand-over's big 3, 2, 1 in the middle of the screen
  renderCount(count) {
    if (count === this.shownCount || !this.countdown) return;
    this.shownCount = count;
    this.countdown.hidden = count === 0;
    if (!count) return;
    this.countdown.textContent = String(count);
    this.countdown.classList.remove('tick');
    void this.countdown.offsetWidth; // restart the animation
    this.countdown.classList.add('tick');
  }

  rearContacts() {
    const c = this.car;
    const spec = BODY_SPECS.m5;
    const sin = Math.sin(c.heading), cos = Math.cos(c.heading);
    const back = -spec.wheelZ;
    return [-1, 1].map((side) => {
      // The car's local x (across) and z (forward, wheels at -wheelZ) turned into the world by its heading
      const lx = side * spec.wheelX;
      return { x: c.position.x + cos * lx + sin * back, z: c.position.z - sin * lx + cos * back };
    });
  }

  update(dt, camera) {
    const c = this.car;
    const drift = c.drift;
    const slide = this.active ? drift.rearSlide : 0;

    const worldVX = Math.sin(c.heading) * c.speed + c.vx;
    const worldVZ = Math.cos(c.heading) * c.speed + c.vz;
    // No brake stops 5 m/s in one frame: that was a car, a wall or a lamppost
    const impact = Math.hypot(worldVX - this.lastVX, worldVZ - this.lastVZ);
    this.lastVX = worldVX;
    this.lastVZ = worldVZ;

    if (this.active) {
      if (impact > CRASH_SPEED_CHANGE && !this.skipImpact) this.score.wipeout();
      this.skipImpact = false;
      // Scored on the speed over the ground: a donut is all sideways
      this.score.update(dt, drift.slipAngle, Math.hypot(worldVX, worldVZ));
      const close = this.closeCalls.update(dt, c, this.traffic.cars, this.traffic.buses);
      if (close) {
        const chain = this.closeCalls.chain > 1 ? ` ×${this.closeCalls.chain}` : '';
        const label = this.closeCalls.split ? 'SPLIT' : 'CLOSE CALL';
        this.score.award(close, `${label}${chain} +${close.toLocaleString('en-US')}`);
        this.screech.whoosh(Math.min(1, Math.abs(c.speed) / 35));
      }
      const contacts = this.rearContacts();
      const laying = slide > SKID_SLIDE && c.position.y < 0.5;
      for (let i = 0; i < 2; i++) {
        const p = contacts[i];
        const last = this.lastContact[i];
        if (laying && last) this.skids.add(last.x, last.z, p.x, p.z, c.position.y);
        this.lastContact[i] = laying ? p : null;
      }
      if (slide > SMOKE_SLIDE) {
        const strength = Math.min(1, (slide - SMOKE_SLIDE) / 15);
        this.smokeBudget += dt * (18 + strength * 55);
        const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
        while (this.smokeBudget >= 1) {
          this.smokeBudget -= 1;
          const wheel = Math.random() < 0.5 ? 0 : 1;
          const p = contacts[wheel];
          this.smoke.emit(p.x, c.position.y, p.z, worldVX, worldVZ, strength, fx, fz, wheel ? 1 : -1);
        }
      } else {
        this.smokeBudget = 0;
      }
      this.hudTimer -= dt;
      if (this.hudTimer <= 0) {
        this.hudTimer = 0.1;
        this.score.render(drift.slipAngle);
      }
    }
    this.screech.update(slide, Math.abs(c.speed), this.active);
    this.smoke.update(dt, camera);
    this.skids.update();

    this.clock += dt;
    if (this.show.running) {
      this.show.gatherObstacles(c, this.traffic.cars, this.traffic.buses);
      // The cruiser's own AI weaves through the same traffic; the car's AI weaves round the cruiser too
      if (this.cruiser.state !== 'hidden') this.show.obstacles.push({ x: this.cruiser.car.position.x, z: this.cruiser.car.position.z });
    }
    this.renderCount(this.show.count);
    this.cruiser.update(dt, this.clock, camera.position, this.show.obstacles, c);
    if (this.active) this.cruiser.collide(c);
  }
}

export { CARELESS_WHISPER, SWIM_STARTS, SQUEEZE_ROUTE, SHOW_SPOT, SHOW_SIGNAL_TIME, CloseCalls, SwimDirector };
