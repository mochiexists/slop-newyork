import * as THREE from 'three/webgpu';
import { attribute, mix, mrt, texture, vec3, vec4 } from 'three/tsl';
import { BODY_SPECS, carTipZ } from './cars.js';
import { M3_ENGINE, createEngineState, readGearbox, stepEngine } from './swim-engine.js';

// The swimming car's exhaust: pops, bangs and crackles you hear and short flames from the quad tips you see, on the
// overrun (the throttle snapped shut at high revs, then a crackling train while it coasts), on a flat-out upshift and
// as the engine bounces off the limiter. One engine model (swim-engine.js, fed the car's own gearbox and pedal like the
// engine voice) decides when; the sound is synthesized here (a noise crack over a falling sine thump, no recordings)
// and layers over the engine voice's own crackle; the flames are eight additive camera-facing quads in one draw call
// (a hot core and a plume per tip) that bloom, fading in a few hundredths of a second.

// When the exhaust fires
const OVERRUN_TIME = 1.5; // s of crackle after a full-strength lift (shorter for a lift from lower revs)
const OVERRUN_MIN_RPM = 2600; // the crackle dies away below this
const OVERRUN_PEDAL = 0.1; // pedal above which the overrun is over (back on the gas)
const CRACKLE_GAP = [0.045, 0.16]; // s between two crackles at the start of the overrun (stretching out as it ends)
const UPSHIFT_POP_RPM = 4500; // rpm at least, and...
const UPSHIFT_POP_THROTTLE = 0.7; // ...this much throttle, for an upshift to bark
const LIMITER_POP_CHANCE = 0.5; // share of the limiter's fuel cuts that pop
const LIMITER_POP_GAP = 0.14; // s at least between two limiter pops

// How they sound: peak levels into the city mix (its compressor follows)
const POP_LEVEL = { bang: 0.5, brap: 0.38, limiter: 0.26, crackle: 0.2 };
const NOISE_SECONDS = 0.5;

// How they look
const TIP_COUNT = 4;
const FLAME_DECAY = 0.055; // s: time constant of a flame dying away
const FLAME_MIN = 0.01; // glow below which a flame is out
const CORE_SIZE = 0.16; // m across at full strength
const PLUME_SIZE = 0.5;
const PLUME_REACH = 0.26; // m the plume sits out behind its tip at full strength
// Brightness over white, into the bloom but not so far the tone mapping bleaches the fire to white
const CORE_HDR = 4;
const PLUME_HDR = 2.6;
const CORE_COLOR = [1.0, 0.6, 0.2];
const PLUME_COLOR = [1.0, 0.3, 0.05];
// The quad tips in the car frame (x left, y up, z forward, origin between the axles): the M3 model's, read off its
// geometry (tools: the tips' bounds span x ±0.53, y 0.23-0.34, z -2.59 at the outlets), and the procedural car's pipes
const M3_TIPS = { xs: [-0.47, -0.36, 0.36, 0.47], y: 0.28, z: -2.6 };
const PROCEDURAL_TIPS = { xs: [-0.56, -0.43, 0.43, 0.56], y: 0.3 };
const MODEL_NAME = 'M3Competition'; // m3-model.js's root for the full build's car
const MODEL_CHECK_TIME = 1; // s between looks for the model (it loads once, after the scene)

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const between = (random, [low, high]) => low + random() * (high - low);

/**
 * Pure: the moments the exhaust fires, from the car's telemetry. step() runs the engine model one frame and returns
 * this frame's events ({ kind: 'bang' | 'crackle' | 'brap' | 'limiter', strength 0..1, tips: 'all' | 'left' |
 * 'right' }); the array is reused, read it before the next step.
 */
class ExhaustTrigger {
  constructor(random = Math.random) {
    this.random = random;
    this.state = createEngineState(M3_ENGINE);
    this.input = { speed: 0, throttle: 0, wheelspin: 0, slipAngle: 0, gear: 0, rpm: NaN, limiter: false };
    this.events = [];
    this.clock = 0;
    this.overrunLeft = 0;
    this.overrunTime = 0;
    this.overrunStrength = 0;
    this.nextCrackle = 0;
    this.nextLimiterPop = 0;
    this.wasCut = false;
  }

  // car: the swim entity (speed, drift telemetry, its gearbox); pedal 0..1 as driven this frame
  step(dt, car, pedal) {
    const events = this.events;
    events.length = 0;
    if (!(dt > 0)) return events;
    this.clock += dt;
    const input = this.input;
    input.speed = Number.isFinite(car.speed) ? car.speed : 0;
    input.wheelspin = car.drift?.wheelspin || 0;
    input.slipAngle = car.drift?.slipAngle || 0;
    input.throttle = clamp(Number.isFinite(pedal) ? pedal : 0, 0, 1);
    readGearbox(car, input);
    const state = stepEngine(this.state, input, dt, M3_ENGINE);
    const random = this.random;

    // The overrun: a bang as the throttle snaps shut, then a crackling train while the car coasts on high revs
    if (state.lift > 0) {
      events.push({ kind: 'bang', strength: state.lift, tips: 'all' });
      this.overrunTime = this.overrunLeft = OVERRUN_TIME * state.lift;
      this.overrunStrength = state.lift;
      this.nextCrackle = this.clock + between(random, CRACKLE_GAP);
    } else if (this.overrunLeft > 0) {
      this.overrunLeft -= dt;
      if (input.throttle > OVERRUN_PEDAL || state.rpm < OVERRUN_MIN_RPM) this.overrunLeft = 0;
      else if (this.clock >= this.nextCrackle) {
        const left = clamp(this.overrunLeft / this.overrunTime, 0, 1);
        events.push({ kind: 'crackle', strength: this.overrunStrength * Math.sqrt(left) * (0.5 + 0.5 * random()),
          tips: random() < 0.5 ? 'left' : 'right' });
        // Dense at first, stretching out as it dies
        this.nextCrackle = this.clock + between(random, CRACKLE_GAP) * (1 + 2 * (1 - left));
      }
    }

    // A flat-out upshift barks as the ignition cuts for the shift
    if (state.upshift && state.throttle > UPSHIFT_POP_THROTTLE && state.rpm > UPSHIFT_POP_RPM) {
      const strength = state.throttle * clamp((state.rpm - 4000) / 3000, 0.3, 1);
      events.push({ kind: 'brap', strength, tips: 'all' });
    }

    // Bouncing off the limiter, some of the fuel cuts pop
    if (state.cut && !this.wasCut && this.clock >= this.nextLimiterPop && random() < LIMITER_POP_CHANCE) {
      events.push({ kind: 'limiter', strength: 0.45 + 0.3 * random(), tips: random() < 0.5 ? 'left' : 'right' });
      this.nextLimiterPop = this.clock + LIMITER_POP_GAP * (1 + random());
    }
    this.wasCut = state.cut;
    return events;
  }
}

// The pops' sound: a crack of band-passed noise over a sine thump falling in pitch, into the city's audio mix
class ExhaustPops {
  constructor(audioSystem, random = Math.random) {
    this.audio = audioSystem;
    this.random = random;
    this.context = null;
    this.noise = null;
  }

  ready() {
    const audio = this.audio;
    const context = audio?.context;
    if (!context || !audio.mix || !audio.enabled || context.state !== 'running') return null;
    if (this.context !== context) {
      const length = Math.round(context.sampleRate * NOISE_SECONDS);
      this.noise = context.createBuffer(1, length, context.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      this.context = context;
    }
    return context;
  }

  play(event) {
    const context = this.ready();
    if (!context) return;
    const random = this.random;
    const now = context.currentTime;
    const level = POP_LEVEL[event.kind] * (0.4 + 0.6 * event.strength);
    if (event.kind === 'crackle') {
      // A crackle is a few tiny cracks a few milliseconds apart
      const clicks = 2 + Math.floor(random() * 3);
      for (let i = 0; i < clicks; i++) this.crack(context, now + i * (0.006 + random() * 0.018), level * (0.6 + 0.4 * random()), 1800 + random() * 2400, 0.006);
      return;
    }
    this.crack(context, now, level, 900 + random() * 1300, event.kind === 'bang' ? 0.022 : 0.015);
    this.thump(context, now, level * (event.kind === 'bang' ? 1.1 : 0.7));
  }

  // band-passed noise: attack in a millisecond, decay with time constant tau
  crack(context, when, level, frequency, tau) {
    const source = context.createBufferSource();
    source.buffer = this.noise;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = frequency;
    band.Q.value = 0.8;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, when + 0.001);
    gain.gain.setTargetAtTime(0, when + 0.002, tau);
    source.connect(band).connect(gain).connect(this.audio.mix);
    source.onended = () => gain.disconnect();
    source.start(when, this.random() * (NOISE_SECONDS - 0.15), tau * 7);
  }

  // the low body of a bang: a sine from 150 Hz falling to 50 Hz
  thump(context, when, level) {
    const osc = context.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(50, when + 0.08);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, when + 0.003);
    gain.gain.setTargetAtTime(0, when + 0.004, 0.03);
    osc.connect(gain).connect(this.audio.mix);
    osc.onended = () => gain.disconnect();
    osc.start(when);
    osc.stop(when + 0.2);
  }
}

function createFlameTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// Flames from the four tips: a core and a plume each, lit by bursts and dying away within a tenth of a second
class ExhaustFlames {
  constructor(car, random = Math.random) {
    this.car = car;
    this.random = random;
    this.glow = new Float32Array(TIP_COUNT); // each tip's flame, 0..1
    this.size = new Float32Array(TIP_COUNT).fill(1); // each burst's own size
    this.lit = false;
    this.tips = null;
    this.modelCheck = 0;
    const count = TIP_COUNT * 2;
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    // the first TIP_COUNT instances are the cores, the rest the plumes
    const heat = new Float32Array(count);
    heat.fill(1, 0, TIP_COUNT);
    geometry.setAttribute('flameAlpha', this.alpha);
    geometry.setAttribute('flameHeat', new THREE.InstancedBufferAttribute(heat, 1));
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    // SSR keeps seeing the road and the bumper underneath
    material.mrtNode = mrt({ normal: vec4(0), metalRough: vec4(0) });
    const shape = texture(createFlameTexture()).a;
    const hot = attribute('flameHeat', 'float');
    const plume = vec3(...PLUME_COLOR).mul(PLUME_HDR);
    const core = vec3(...CORE_COLOR).mul(CORE_HDR);
    material.colorNode = mix(plume, core, hot);
    material.opacityNode = shape.mul(attribute('flameAlpha', 'float'));
    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.name = 'SwimExhaustFlames';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 991;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this._matrix = new THREE.Matrix4();
    this._position = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._facing = new THREE.Quaternion();
    this._chassis = new THREE.Quaternion();
    this.hideAll();
    // In a group, not straight on the chassis: the full build's model hides the chassis's own meshes when it loads
    this.group = new THREE.Group();
    this.group.name = 'SwimExhaust';
    this.group.add(this.mesh);
    car.chassisPivot?.add(this.group);
  }

  hideAll() {
    this._matrix.makeScale(0, 0, 0);
    for (let i = 0; i < TIP_COUNT * 2; i++) {
      this.mesh.setMatrixAt(i, this._matrix);
      this.alpha.array[i] = 0;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }

  // The M3 model's tips once it has loaded, the procedural car's until then
  tipLayout(dt) {
    if (this.tips === M3_TIPS) return this.tips;
    this.modelCheck -= dt;
    if (this.modelCheck <= 0 || !this.tips) {
      this.modelCheck = MODEL_CHECK_TIME;
      if (this.car.chassisPivot?.getObjectByName(MODEL_NAME)) this.tips = M3_TIPS;
      else if (!this.tips) this.tips = { ...PROCEDURAL_TIPS, z: carTipZ(BODY_SPECS.m5, PROCEDURAL_TIPS.y, false) - 0.05 };
    }
    return this.tips;
  }

  burst(event) {
    const random = this.random;
    for (let i = 0; i < TIP_COUNT; i++) {
      // tips 0, 1 are on the car's right (-x), 2, 3 on its left
      const left = i >= TIP_COUNT / 2;
      if (event.tips === 'left' && !left) continue;
      if (event.tips === 'right' && left) continue;
      const strength = event.strength * (0.75 + 0.25 * random());
      if (strength > this.glow[i]) {
        this.glow[i] = strength;
        this.size[i] = 0.8 + 0.4 * random();
      }
    }
    this.lit = true;
  }

  update(dt, camera) {
    const tips = this.tipLayout(dt);
    if (!this.lit) return;
    const decay = Math.exp(-dt / FLAME_DECAY);
    let any = false;
    // Camera-facing in the chassis frame: the chassis's world turn undone, then the camera's
    this.car.chassisPivot.getWorldQuaternion(this._chassis);
    this._facing.copy(this._chassis).invert().multiply(camera.quaternion);
    for (let i = 0; i < TIP_COUNT; i++) {
      const glow = this.glow[i] < FLAME_MIN ? 0 : this.glow[i];
      this.glow[i] = glow * decay;
      if (glow > 0) any = true;
      const flicker = 0.85 + 0.3 * this.random();
      const x = tips.xs[i];
      // the core sits in the tip's mouth, the plume out behind it, reaching further on a bigger bang
      this.place(i, x, tips.y, tips.z - 0.03, CORE_SIZE * this.size[i] * (0.6 + 0.4 * glow) * flicker, glow);
      this.place(i + TIP_COUNT, x, tips.y + 0.02 * glow, tips.z - PLUME_REACH * glow * this.size[i],
        PLUME_SIZE * this.size[i] * glow * flicker, glow * 0.85);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.lit = any;
  }

  place(index, x, y, z, size, alpha) {
    if (!(alpha > 0) || !(size > 0)) {
      this._matrix.makeScale(0, 0, 0);
      this.alpha.array[index] = 0;
    } else {
      this._position.set(x, y, z);
      this._scale.set(size, size, size);
      this._matrix.compose(this._position, this._facing, this._scale);
      this.alpha.array[index] = Math.min(1, alpha);
    }
    this.mesh.setMatrixAt(index, this._matrix);
  }
}

// The whole exhaust, driven by SwimDirector each frame: car the swim entity, controls() its pedal input as driven
class SwimExhaust {
  constructor({ car, audioSystem, controls }) {
    this.car = car;
    this.controls = controls;
    this.trigger = new ExhaustTrigger();
    this.pops = new ExhaustPops(audioSystem);
    this.flames = new ExhaustFlames(car);
  }

  update(dt, camera, active) {
    if (active) {
      const input = this.controls();
      const pedal = input ? Math.max(input.throttle || 0, input.reverse || 0) : 0;
      for (const event of this.trigger.step(dt, this.car, pedal)) {
        this.pops.play(event);
        this.flames.burst(event);
      }
    }
    this.flames.update(dt, camera);
  }
}

export { ExhaustTrigger, ExhaustPops, ExhaustFlames, SwimExhaust, M3_TIPS, OVERRUN_TIME, UPSHIFT_POP_RPM, LIMITER_POP_CHANCE };
