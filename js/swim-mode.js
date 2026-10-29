import * as THREE from 'three/webgpu';
import { attribute, float, texture, vec3 } from 'three/tsl';
import { avenueX, streetZ } from './city-config.js';
import { BODY_SPECS } from './cars.js';

// Swimming: the BMW M5 weaving through traffic and drifting through Times Square to Careless Whisper. This module owns
// everything about the mode except the car itself (controllers.js) and its physics (drift-physics.js): the
// soundtrack, the drift score, tire smoke, skid marks, the tire screech, the two clip start points and the clip's
// route on the map.

const RAD = Math.PI / 180;

// George Michael's official video, streamed by YouTube's own player when swimming begins; nothing is stored here.
// Label uploads often refuse embedding (player error 150, seen from localhost on 2026-10-29), so a lyric upload that
// embeds is the fallback. The sax riff opens the track, so it plays from the top.
const CARELESS_WHISPER = {
  videoIds: ['izGwDsrQ1eQ', 'JqIHlDVqUTw'],
  start: 0,
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
const DRIFT_MIN_SPEED = 6; // m/s
const DRIFT_GRACE = 0.7; // s a drift may straighten before it is banked
const SKID_SLIDE = 3.2; // m/s of rear tire slide before rubber is laid
const SMOKE_SLIDE = 5; // m/s of rear tire slide before smoke
const CRASH_SPEED_CHANGE = 5; // m/s of velocity change in one frame
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

  emit(x, y, z, vx, vz, strength) {
    const p = this.particles[this.next];
    this.next = (this.next + 1) % SMOKE_COUNT;
    p.x = x + (Math.random() - 0.5) * 0.3;
    p.y = y + 0.25;
    p.z = z + (Math.random() - 0.5) * 0.3;
    // Smoke is left behind by the tire: a fraction of the car's velocity, plus a little scatter
    p.vx = vx * 0.12 + (Math.random() - 0.5) * 1.2;
    p.vy = 0.5 + Math.random() * 0.6;
    p.vz = vz * 0.12 + (Math.random() - 0.5) * 1.2;
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
      // Fade in over the first moments so a puff doesn't pop, then thin out as it spreads
      this.alpha.array[i] = 0.2 * Math.min(1, p.age / 0.18) * (1 - t) ** 1.6;
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
            if (this.wanted) this.player.playVideo();
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
    const options = { videoId: CARELESS_WHISPER.videoIds[this.source], startSeconds: CARELESS_WHISPER.start };
    if (this.wanted) this.player.loadVideoById(options);
    else this.player.cueVideoById(options);
  }

  onState(state) {
    // 1 playing, 2 paused, 0 ended (loop the track while swimming)
    if (state === 1) this.setStatus('playing');
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

  pause() {
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

class SwimDirector {
  constructor({ scene, controllerManager, audioSystem }) {
    this.controllers = controllerManager;
    this.car = controllerManager.entities.swim;
    this.smoke = new TireSmoke(scene);
    this.skids = new SkidMarks(scene);
    this.screech = new TireScreech(audioSystem);
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
      this.score.bank();
      this.radio.stop();
      this.lastContact[0] = this.lastContact[1] = null;
    }
  }

  setMuted(muted) {
    this.radio.setMuted(muted);
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
      if (impact > CRASH_SPEED_CHANGE) this.score.wipeout();
      this.score.update(dt, drift.slipAngle, c.speed);
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
        while (this.smokeBudget >= 1) {
          this.smokeBudget -= 1;
          const p = contacts[Math.random() < 0.5 ? 0 : 1];
          this.smoke.emit(p.x, c.position.y, p.z, worldVX, worldVZ, strength);
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
  }
}

export { CARELESS_WHISPER, SWIM_STARTS, SQUEEZE_ROUTE, SwimDirector };
