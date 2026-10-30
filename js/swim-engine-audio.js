// The swimming car's engine voice: recorded loops of a tuned BMW M3 (G80, S58 straight-six) pitched and crossfaded
// by the engine model in swim-engine.js, with the throttle opening the sound up, the limiter's bounce, shift cuts,
// overrun crackles, a turbo whistle and a blow-off flutter on lift. The recordings are fetched by
// tools/fetch-m3-sound.sh and never committed; until (or unless) they load, the same voice runs on the synthesized
// six-cylinder loops from audio-synthesis.js. A GTA V sound mod decoded by tools/extract-m5-mod-sound.py (also never
// committed) adds an engine to swap in for the M3 (a V10's granular banks, stitched into accel and decel loops) and
// pops, burbles and bangs that layer over either engine's crackle. It is a motor voice like the others
// (update/dispose) plus tick(), which runs the engine at frame rate so shifts and the limiter don't wait for the 10 Hz
// ambience update.

import { setControlRate } from './audio-synthesis.js';
import { M3_ENGINE, createEngineState, readGearbox, stepEngine } from './swim-engine.js';

// The clips tools/fetch-m3-sound.sh writes, with the engine speed each loop was measured at
const M3_CLIPS = {
  folder: 'assets/audio/m3/',
  loops: [
    { file: 'idle.wav', rpm: 706 },
    { file: 'low.wav', rpm: 2650 },
    { file: 'high.wav', rpm: 6654 }
  ],
  crackle: 'crackle.wav'
};

// What tools/extract-m5-mod-sound.py decodes from a GTA V sound mod (Azerrty's "M5 Sound Mod"), never committed:
// overrun one-shots layered over either engine's crackle...
const M5_MOD_SHOTS = {
  folder: 'assets/audio/m5mod/',
  pops: ['pop-1.wav', 'pop-2.wav', 'pop-3.wav', 'pop-4.wav', 'pop-5.wav'],
  burbles: ['burble-1.wav', 'burble-2.wav', 'burble-3.wav', 'burble-4.wav', 'burble-5.wav', 'burble-6.wav', 'burble-7.wav'],
  bangs: ['bang-1.wav', 'bang-2.wav', 'bang-3.wav']
};
// ...and the engine voice the M3's can be swapped for (audio-system.js): steady loops stitched from the mod's granular
// V10 banks, an accel set on the throttle and a decel set off it. A loop's rpm is its grain rate (Hz) times 100; the
// recordings span less than the engine model revs through, so pitchRange maps the model's idle to the idle loop and
// its limiter to the top loops.
const M5_MOD_ENGINE_CLIPS = {
  folder: 'assets/audio/m5mod/engine/',
  loops: [
    { file: 'idle.wav', rpm: 1060 },
    { file: 'accel-1.wav', rpm: 1600 },
    { file: 'accel-2.wav', rpm: 2400 },
    { file: 'accel-3.wav', rpm: 3300 },
    { file: 'accel-4.wav', rpm: 4200 },
    { file: 'accel-5.wav', rpm: 5100 },
    { file: 'accel-6.wav', rpm: 6000 }
  ],
  decelLoops: [
    { file: 'idle.wav', rpm: 1060 },
    { file: 'decel-1.wav', rpm: 2300 },
    { file: 'decel-2.wav', rpm: 3200 },
    { file: 'decel-3.wav', rpm: 4200 },
    { file: 'decel-4.wav', rpm: 5100 },
    { file: 'decel-5.wav', rpm: 6000 }
  ],
  pitchRange: [1060, 6000],
  crackle: null
};

// The compressed copy of each clip tools/encode-sounds.sh writes next to its WAV, loaded first: loops as FLAC
// (lossless, so they keep the WAV's exact length and loop without a seam), one-shots as Opus in WebM
const ENCODED_FORMATS = { loop: 'flac', shot: 'webm' };

const LOOP_RMS = 0.16; // every loop is levelled to this, so the crossfade doesn't jump in loudness
const CRACKLE_PEAK = 0.9;
const MOD_SHOT_PEAK = 0.9;
const MOD_LAYER_LEVEL = 0.6; // the mod's one-shots sit under the M3 crackle
const MOD_BANG_LIFT = 0.6; // a lift at least this strong can fire a bang instead of a pop cluster...
const MOD_BANG_CHANCE = 0.5; // ...this often at a full lift
const LIMITER_POP_CHANCE = 0.45; // share of limiter cuts that pop
const LIMITER_POP_GAP = 0.12; // s at least between two limiter pops
const ACCEL_LOAD = 0.35; // engine load from which a bank with decel loops plays its accel loops alone
const LOOP_SWAP_TIME = 0.25; // s to fade from one set of loops to another (the recordings arriving, an engine swap)
const CROSSFADE_WIDTH = 0.7; // share of the (log) rpm gap between two loops over which they crossfade
const OVERRUN_TIME = 1.6; // s of popping after a hard lift from high revs

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Equal-power weights of loops recorded at `loopRPMs` (ascending) for an engine at `rpm`: one loop alone near its
 * own speed, crossfading with its neighbour around the (logarithmic) middle between them.
 */
function loopWeights(rpm, loopRPMs, out = new Array(loopRPMs.length), width = CROSSFADE_WIDTH) {
  const last = loopRPMs.length - 1;
  for (let i = 0; i <= last; i++) out[i] = 0;
  if (!(rpm > loopRPMs[0])) {
    out[0] = 1;
    return out;
  }
  if (rpm >= loopRPMs[last]) {
    out[last] = 1;
    return out;
  }
  let i = 0;
  while (rpm > loopRPMs[i + 1]) i++;
  const t = Math.log(rpm / loopRPMs[i]) / Math.log(loopRPMs[i + 1] / loopRPMs[i]);
  const x = clamp((t - 0.5) / width + 0.5, 0, 1);
  const blend = x * x * (3 - 2 * x);
  out[i] = Math.cos(blend * Math.PI / 2);
  out[i + 1] = Math.sin(blend * Math.PI / 2);
  return out;
}

// The engines the swimming car can sound like. A bank list maps each to its loaded bank, null when its recordings
// aren't there, or undefined while they load (or before sound starts).
const SWIM_ENGINES = {
  m3: { label: 'M3 S58', clips: M3_CLIPS },
  m5mod: { label: 'M5 V10 (GTA mod)', clips: M5_MOD_ENGINE_CLIPS }
};

// The bank to play for an engine choice: the pick once it has loaded, else the M3 recordings, else none (synthesized).
function swimEngineBank(choice, banks) {
  return banks[choice] || banks.m3 || null;
}

// The engine a swap goes to: the other one, unless its recordings are known to be missing.
function nextSwimEngine(choice, banks) {
  const other = choice === 'm5mod' ? 'm3' : 'm5mod';
  return banks[other] === null ? choice : other;
}

// The rpm a bank's loops should sound at: the engine's own, or mapped onto the bank's pitchRange (idle to limiter).
function enginePitch(rpm, bank, engine = M3_ENGINE) {
  if (!bank.pitchRange) return rpm;
  const [low, high] = bank.pitchRange;
  return low + (rpm - engine.idle) * (high - low) / (engine.limiter - engine.idle);
}

// Scales a decoded clip to a target RMS (loops) or peak (one-shots), never past a 0.95 peak.
function levelBuffer(buffer, { rms = 0, peak = 0 }) {
  const data = buffer.getChannelData(0);
  let energy = 0, top = 0;
  for (let i = 0; i < data.length; i++) {
    energy += data[i] * data[i];
    top = Math.max(top, Math.abs(data[i]));
  }
  if (!top) return buffer;
  const wanted = rms ? rms / Math.sqrt(energy / data.length) : peak / top;
  const scale = Math.min(wanted, 0.95 / top);
  for (let i = 0; i < data.length; i++) data[i] *= scale;
  return buffer;
}

/**
 * Fetches and decodes one clip (a .wav path), preferring its compressed copy (ENCODED_FORMATS[kind]) and taking the
 * WAV when the copy isn't there or the browser can't decode it. Resolves to the buffer, or null when neither is there.
 */
async function decodeClip(context, fetchFile, url, kind) {
  try {
    const response = await fetchFile(url.replace(/\.wav$/, `.${ENCODED_FORMATS[kind]}`));
    if (response.ok) return await context.decodeAudioData(await response.arrayBuffer());
  } catch { /* Try the WAV. */ }
  const response = await fetchFile(url);
  if (!response.ok) return null;
  return await context.decodeAudioData(await response.arrayBuffer());
}

/**
 * Fetches and decodes the recorded clips. Resolves to a bank ({ recorded, loops: [{ buffer, rpm }], decelLoops,
 * pitchRange, crackle }) or to null when they aren't there (a fresh clone that hasn't run tools/fetch-m3-sound.sh);
 * it never rejects. The first loop is tried alone, so a missing set costs a single try (its compressed copy, then
 * its WAV); a file listed twice is fetched once.
 */
async function loadSwimEngineClips(context, clips = M3_CLIPS, fetchFile = globalThis.fetch) {
  const decoded = new Map();
  const decode = (file, kind = 'loop') => {
    if (!decoded.has(file)) decoded.set(file, decodeClip(context, fetchFile, clips.folder + file, kind));
    return decoded.get(file);
  };
  // Loops levelled to one loudness (a shared buffer is levelled twice, which leaves it as it was)
  const loadSet = async (loops) => {
    const buffers = await Promise.all(loops.map((loop) => decode(loop.file)));
    if (buffers.some((buffer) => !buffer)) return null;
    return buffers.map((buffer, i) => ({ buffer: levelBuffer(buffer, { rms: LOOP_RMS }), rpm: loops[i].rpm }));
  };
  try {
    if (!await decode(clips.loops[0].file)) return null;
    const loops = await loadSet(clips.loops);
    const decelLoops = clips.decelLoops ? await loadSet(clips.decelLoops) : null;
    if (!loops || (clips.decelLoops && !decelLoops)) return null;
    const crackle = clips.crackle ? await decode(clips.crackle, 'shot').catch(() => null) : null;
    return {
      recorded: true,
      loops,
      decelLoops,
      pitchRange: clips.pitchRange || null,
      crackle: crackle && levelBuffer(crackle, { peak: CRACKLE_PEAK })
    };
  } catch {
    return null;
  }
}

/**
 * Fetches and decodes the sound mod's one-shots. Resolves to { pops, burbles, bangs } (buffers levelled to a peak)
 * or to null when they aren't there; it never rejects. The first pop is tried alone, so a missing set costs a single
 * try, and a clip that fails later is left out of its group.
 */
async function loadM5ModShots(context, shots = M5_MOD_SHOTS, fetchFile = globalThis.fetch) {
  const decode = async (file) => {
    const buffer = await decodeClip(context, fetchFile, shots.folder + file, 'shot');
    return buffer && levelBuffer(buffer, { peak: MOD_SHOT_PEAK });
  };
  const group = async (files) => (await Promise.all(files.map((file) => decode(file).catch(() => null)))).filter(Boolean);
  try {
    const first = await decode(shots.pops[0]);
    if (!first) return null;
    const [pops, burbles, bangs] = await Promise.all([group(shots.pops.slice(1)), group(shots.burbles), group(shots.bangs)]);
    return { pops: [first, ...pops], burbles, bangs };
  } catch {
    return null;
  }
}

// The fallback: audio-synthesis.js's six-cylinder exhaust loops, at the engine speeds they were built for.
function synthesizedBank(resources) {
  const six = resources.combustion.suv;
  return {
    recorded: false,
    loops: [
      { buffer: six.exhaust, rpm: six.referenceRPM },
      { buffer: six.highExhaust, rpm: six.highReferenceRPM }
    ],
    crackle: null
  };
}

// As in audio-synthesis.js: only reschedule a parameter when its target moves.
function smoothParameter(parameter, timeConstant, epsilon = 0.0001) {
  let target = NaN;
  return (value, now, smoothing = timeConstant) => {
    if (Math.abs(value - target) < epsilon) return;
    parameter.cancelScheduledValues(now);
    if (Number.isNaN(target)) parameter.setValueAtTime(value, now);
    else parameter.setTargetAtTime(value, now, smoothing);
    target = value;
  };
}

/**
 * options: entity (the swim car), controls() → { throttle } as driven this frame, clips() → the recorded bank or null,
 * shots() → the sound mod's one-shots (loadM5ModShots) or null.
 */
function createSwimEngineVoice(context, resources, output,
  { entity = null, controls = () => null, clips = () => null, shots = () => null } = {}) {
  const nodes = [];
  const own = (node) => { nodes.push(node); return node; };
  const gain = (value = 0) => {
    const node = own(context.createGain());
    node.gain.value = value;
    return node;
  };
  const filter = (type, frequency, q = 0.7) => {
    const node = own(context.createBiquadFilter());
    setControlRate(node.frequency, node.detune, node.Q, node.gain);
    node.type = type;
    node.frequency.value = Math.min(frequency, context.sampleRate * 0.45);
    node.Q.value = q;
    return node;
  };

  // loops → bus → tone (opens with load) → body (low-end weight under load) → level → cut (limiter, shifts) → mix
  const mix = gain();
  mix.channelCount = 1;
  mix.channelCountMode = 'explicit';
  mix.connect(output);
  const bus = gain(1);
  const tone = filter('lowpass', 2000, 0.6);
  const body = filter('peaking', 170, 0.9);
  const level = gain();
  const cut = gain(1);
  bus.connect(tone).connect(body).connect(level).connect(cut).connect(mix);
  const toneCutoff = smoothParameter(tone.frequency, 0.03, 1);
  const bodyBoost = smoothParameter(body.gain, 0.05, 0.05);
  const engineLevel = smoothParameter(level.gain, 0.03);
  const cutLevel = smoothParameter(cut.gain, 0.006, 0.001);

  // Turbo: a faint whistle that rises with boost, and air rushing through the intake
  const whistle = own(context.createOscillator());
  whistle.type = 'triangle';
  whistle.frequency.value = 3000;
  const whistleGain = gain();
  whistle.connect(whistleGain).connect(mix);
  const intake = own(context.createBufferSource());
  intake.buffer = resources.noise;
  intake.loop = true;
  const intakeFilter = filter('bandpass', 1800, 0.8);
  const intakeGain = gain();
  intake.connect(intakeFilter).connect(intakeGain).connect(mix);
  const whistlePitch = smoothParameter(whistle.frequency, 0.08, 1);
  const whistleLevel = smoothParameter(whistleGain.gain, 0.08);
  const intakeLevel = smoothParameter(intakeGain.gain, 0.08);
  const intakeTone = smoothParameter(intakeFilter.frequency, 0.08, 1);

  const state = createEngineState(M3_ENGINE);
  const input = { speed: 0, throttle: 0, wheelspin: 0, slipAngle: 0, gear: 0, rpm: NaN, limiter: false };
  let layer = null;
  let synthesized = null;
  let retiring = [];
  let player = false;
  let doppler = 1;
  let disposed = false;
  let overrunUntil = 0, nextPop = 0;
  let wasCut = false, nextLimiterPop = 0;
  const oneShots = new Set();

  function buildLayer(bank, now, fade) {
    const layerGain = gain(fade ? 0 : 1);
    layerGain.connect(bus);
    const sources = [], gains = [], rates = [], levels = [];
    // One set of loops, or an accel set and a decel set; each set's sources are a run of the flat lists
    const sets = [];
    for (const loops of [bank.loops, bank.decelLoops]) {
      if (!loops?.length) continue;
      sets.push({ first: sources.length, rpms: loops.map((loop) => loop.rpm), weights: [] });
      for (const { buffer } of loops) {
        const source = own(context.createBufferSource());
        source.buffer = buffer;
        source.loop = true;
        const loopGain = gain();
        source.connect(loopGain).connect(layerGain);
        source.start(now, Math.random() * buffer.duration);
        sources.push(source);
        gains.push(loopGain);
        rates.push(smoothParameter(source.playbackRate, 0.012, 0.0005));
        levels.push(smoothParameter(loopGain.gain, 0.02, 0.001));
      }
    }
    if (fade) layerGain.gain.setTargetAtTime(1, now, LOOP_SWAP_TIME / 3);
    return { bank, layerGain, sources, gains, rates, levels, sets };
  }

  function retire(old, now) {
    old.layerGain.gain.cancelScheduledValues(now);
    old.layerGain.gain.setTargetAtTime(0, now, LOOP_SWAP_TIME / 3);
    for (const source of old.sources) source.stop(now + LOOP_SWAP_TIME * 1.5);
    retiring.push({ layer: old, until: now + LOOP_SWAP_TIME * 1.5 });
  }

  function releaseLayer(old) {
    for (const node of [...old.sources, ...old.gains, old.layerGain]) {
      node.disconnect();
      const index = nodes.indexOf(node);
      if (index >= 0) nodes.splice(index, 1);
    }
  }

  // A one-shot from a buffer: the recorded crackle, or a stretch of it
  function playShot(buffer, when, { offset = 0, duration, rate = 1, volume = 1, cutoff = 0 }) {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const shotGain = context.createGain();
    shotGain.gain.value = volume;
    let head = source;
    let highpass = null;
    if (cutoff) {
      highpass = context.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = cutoff;
      head = source.connect(highpass);
    }
    head.connect(shotGain).connect(mix);
    source.start(when, offset, duration);
    const shot = { source, nodes: [source, highpass, shotGain].filter(Boolean) };
    oneShots.add(shot);
    source.onended = () => {
      for (const node of shot.nodes) node.disconnect();
      oneShots.delete(shot);
    };
  }

  // Without a recording, a pop is a short, dark burst of the shared noise
  function syntheticPop(when, volume) {
    const noise = resources.noise;
    const offset = Math.random() * (noise.duration - 0.1);
    const source = context.createBufferSource();
    source.buffer = noise;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 380 + Math.random() * 500;
    band.Q.value = 0.9;
    const popGain = context.createGain();
    popGain.gain.setValueAtTime(0, when);
    popGain.gain.linearRampToValueAtTime(volume * 1.6, when + 0.003);
    popGain.gain.setTargetAtTime(0, when + 0.004, 0.018);
    source.connect(band).connect(popGain).connect(mix);
    source.start(when, offset, 0.12);
    const shot = { source, nodes: [source, band, popGain] };
    oneShots.add(shot);
    source.onended = () => {
      for (const node of shot.nodes) node.disconnect();
      oneShots.delete(shot);
    };
  }

  function crackle(when, volume, short) {
    const buffer = layer?.bank.crackle;
    if (buffer) {
      const duration = short ? 0.35 : buffer.duration;
      const offset = short ? Math.random() * Math.max(0, buffer.duration - duration) : 0;
      playShot(buffer, when, { offset, duration, rate: 0.92 + Math.random() * 0.2, volume, cutoff: 90 });
    } else if (!modShot(short ? 'burbles' : 'pops', when, volume, 1)) { // the mod's shots stand in for a recording
      const pops = short ? 1 + Math.floor(Math.random() * 2) : 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < pops; i++) syntheticPop(when + i * (0.05 + Math.random() * 0.12), volume * (0.6 + Math.random() * 0.4));
    }
  }

  // The sound mod's layer: a random pop cluster, burble or bang. False when the mod's clips aren't loaded.
  function modShot(kind, when, volume, level = MOD_LAYER_LEVEL) {
    const group = shots()?.[kind];
    if (!group?.length) return false;
    const buffer = group[Math.floor(Math.random() * group.length)];
    playShot(buffer, when, { duration: buffer.duration, rate: 0.94 + Math.random() * 0.12, volume: volume * level,
      cutoff: kind === 'bangs' ? 35 : 90 });
    return true;
  }

  // Lifting with boost up: the blow-off valve's whoosh, fluttering as the compressor surges
  function blowoff(when, strength) {
    const source = context.createBufferSource();
    source.buffer = resources.noise;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.4;
    band.frequency.setValueAtTime(3200, when);
    band.frequency.exponentialRampToValueAtTime(1100, when + 0.4);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(0.16 * strength, when + 0.012);
    envelope.gain.setTargetAtTime(0, when + 0.05, 0.12);
    const flutter = context.createOscillator();
    flutter.type = 'square';
    flutter.frequency.setValueAtTime(24, when);
    flutter.frequency.linearRampToValueAtTime(15, when + 0.45);
    const depth = context.createGain();
    depth.gain.value = 0.45;
    const flutterGain = context.createGain();
    flutterGain.gain.value = 0.55;
    flutter.connect(depth).connect(flutterGain.gain);
    source.connect(band).connect(envelope).connect(flutterGain).connect(mix);
    source.start(when, Math.random() * (resources.noise.duration - 0.7), 0.65);
    flutter.start(when);
    flutter.stop(when + 0.65);
    const shot = { source, nodes: [source, band, envelope, flutter, depth, flutterGain], extra: flutter };
    oneShots.add(shot);
    source.onended = () => {
      for (const node of shot.nodes) node.disconnect();
      oneShots.delete(shot);
    };
  }

  // The bank clips() names (the recordings arriving, or a swap between engines) fades in over the one playing.
  function useBank(now) {
    synthesized ||= synthesizedBank(resources);
    const wanted = clips() || synthesized;
    if (!layer) {
      layer = buildLayer(wanted, now, false);
    } else if (layer.bank !== wanted) {
      retire(layer, now);
      layer = buildLayer(wanted, now, true);
    }
    for (let i = retiring.length - 1; i >= 0; i--) {
      if (now < retiring[i].until) continue;
      releaseLayer(retiring[i].layer);
      retiring.splice(i, 1);
    }
  }

  // Runs the engine one frame and moves the sound with it.
  function tick(dt, now = context.currentTime) {
    if (disposed || !(dt > 0)) return;
    useBank(now);
    if (player && entity) {
      input.speed = Number.isFinite(entity.speed) ? entity.speed : 0;
      input.wheelspin = entity.drift?.wheelspin || 0;
      input.slipAngle = entity.drift?.slipAngle || 0;
      input.throttle = controls()?.throttle || 0;
      readGearbox(entity, input); // the car's own gear, revs and limiter, when it has them
    } else {
      input.speed = input.throttle = input.wheelspin = input.slipAngle = 0;
      input.gear = 0;
      input.rpm = NaN;
      input.limiter = false;
    }
    stepEngine(state, input, dt, M3_ENGINE);

    const rpm = state.rpm;
    const span = clamp((rpm - M3_ENGINE.idle) / (M3_ENGINE.limiter - M3_ENGINE.idle), 0, 1);
    const load = state.load;
    // With a decel set, the accel loops play on the throttle and the decel loops off it (and through the cuts).
    const pitch = enginePitch(rpm, layer.bank);
    const accel = layer.sets.length > 1 ? clamp(load / ACCEL_LOAD, 0, 1) : 1;
    layer.sets.forEach((set, s) => {
      const share = s === 0 ? Math.sin(accel * Math.PI / 2) : Math.cos(accel * Math.PI / 2);
      loopWeights(pitch, set.rpms, set.weights);
      for (let j = 0; j < set.rpms.length; j++) {
        layer.rates[set.first + j](clamp(pitch / set.rpms[j] * doppler, 0.25, 4), now);
        layer.levels[set.first + j](set.weights[j] * share, now);
      }
    });
    // Off the throttle the exhaust goes dark and quiet; on it, it opens up and gains weight.
    const synthetic = !layer.bank.recorded;
    toneCutoff((synthetic ? 500 : 900) + span * 2600 + Math.pow(load, 0.7) * (synthetic ? 2400 : 8000), now);
    bodyBoost(load * 5, now);
    engineLevel((0.32 + 0.55 * Math.pow(load, 0.8) + 0.13 * span) * (synthetic ? 0.8 : 1), now);
    let cutTarget = 1;
    if (state.cut) cutTarget = 0.3;
    else if (state.shifting) cutTarget = 0.55;
    cutLevel(cutTarget, now, state.cut ? 0.004 : 0.012);

    whistlePitch((2600 + state.boost * 4200) * doppler, now);
    whistleLevel(state.boost * state.throttle * 0.01, now);
    intakeTone((900 + span * 2200) * doppler, now);
    intakeLevel(state.boost * 0.035 + state.throttle * span * 0.02, now);

    // Overrun: a burst of pops when the throttle snaps shut at high revs, then a few stragglers while coasting.
    // The sound mod (when decoded) adds a pop cluster to each, or on a hard lift sometimes a deep bang.
    if (state.lift) {
      const volume = 0.55 + 0.45 * state.lift;
      crackle(now, volume, false);
      const bang = state.lift >= MOD_BANG_LIFT && Math.random() < MOD_BANG_CHANCE * state.lift;
      modShot(bang ? 'bangs' : 'pops', now + Math.random() * 0.05, volume);
      overrunUntil = now + OVERRUN_TIME * state.lift;
      nextPop = now + 0.5 + Math.random() * 0.4;
    } else if (now < overrunUntil && state.throttle < 0.1 && rpm > 2600 && now >= nextPop) {
      const volume = 0.35 + Math.random() * 0.25;
      crackle(now, volume, true);
      modShot(Math.random() < 0.5 ? 'burbles' : 'pops', now, volume);
      nextPop = now + 0.18 + Math.random() * 0.45;
    }
    if (state.throttle > 0.2) overrunUntil = 0;
    // Bouncing off the limiter, some of the fuel cuts pop through the mod's layer.
    if (state.cut && !wasCut && now >= nextLimiterPop && Math.random() < LIMITER_POP_CHANCE
      && modShot(Math.random() < 0.5 ? 'burbles' : 'pops', now, 0.35 + Math.random() * 0.2)) {
      nextLimiterPop = now + LIMITER_POP_GAP + Math.random() * LIMITER_POP_GAP;
    }
    wasCut = state.cut;
    // A crisp "brap" on a flat-out upshift
    if (state.upshift && state.throttle > 0.8 && rpm > 4000) crackle(now, 0.3, true);
    if (state.blowoff) blowoff(now, state.blowoff);
  }

  // The 10 Hz ambience update: who is driving and the Doppler shift. The engine itself runs in tick().
  function update({ doppler: shift = 1, player: driven = false } = {}) {
    if (disposed) return;
    doppler = Number.isFinite(shift) ? clamp(shift, 0.5, 2) : 1;
    player = !!driven;
  }

  const startTime = context.currentTime;
  mix.gain.setTargetAtTime(1, startTime, 0.04);
  whistle.start(startTime);
  intake.start(startTime, Math.random() * resources.noise.duration);
  useBank(startTime);

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const shot of oneShots) {
      shot.source.onended = null;
      try { shot.source.stop(); } catch { /* Already stopped. */ }
      try { shot.extra?.stop(); } catch { /* Already stopped. */ }
      for (const node of shot.nodes) node.disconnect();
    }
    oneShots.clear();
    for (const old of [layer, ...retiring.map((entry) => entry.layer)]) {
      for (const source of old?.sources || []) {
        try { source.stop(); } catch { /* Already stopped. */ }
      }
    }
    whistle.stop();
    intake.stop();
    for (const node of nodes) node.disconnect();
  }

  return { update, tick, dispose, state };
}

export { M3_CLIPS, M5_MOD_SHOTS, M5_MOD_ENGINE_CLIPS, ENCODED_FORMATS, SWIM_ENGINES, swimEngineBank, nextSwimEngine, loopWeights,
  enginePitch, levelBuffer, loadSwimEngineClips, loadM5ModShots, createSwimEngineVoice };
