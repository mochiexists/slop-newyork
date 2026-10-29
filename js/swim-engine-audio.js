// The swimming car's engine voice: recorded loops of a tuned BMW M3 (G80, S58 straight-six) pitched and crossfaded
// by the engine model in swim-engine.js, with the throttle opening the sound up, the limiter's bounce, shift cuts,
// overrun crackles, a turbo whistle and a blow-off flutter on lift. The recordings are fetched by
// tools/fetch-m3-sound.sh and never committed; until (or unless) they load, the same voice runs on the synthesized
// six-cylinder loops from audio-synthesis.js. It is a motor voice like the others (update/dispose) plus tick(),
// which runs the engine at frame rate so shifts and the limiter don't wait for the 10 Hz ambience update.

import { setControlRate } from './audio-synthesis.js';
import { M3_ENGINE, createEngineState, stepEngine } from './swim-engine.js';

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

const LOOP_RMS = 0.16; // every loop is levelled to this, so the crossfade doesn't jump in loudness
const CRACKLE_PEAK = 0.9;
const LOOP_SWAP_TIME = 0.25; // s to fade from the synthesized loops to the recordings once they arrive
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
 * Fetches and decodes the recorded clips. Resolves to a bank ({ recorded, loops: [{ buffer, rpm }], crackle }) or to
 * null when they aren't there (a fresh clone that hasn't run tools/fetch-m3-sound.sh); it never rejects. The first
 * loop is tried alone, so a missing set costs a single request.
 */
async function loadSwimEngineClips(context, clips = M3_CLIPS, fetchFile = globalThis.fetch) {
  const decode = async (file) => {
    const response = await fetchFile(clips.folder + file);
    if (!response.ok) return null;
    return await context.decodeAudioData(await response.arrayBuffer());
  };
  try {
    const first = await decode(clips.loops[0].file);
    if (!first) return null;
    const rest = await Promise.all(clips.loops.slice(1).map((loop) => decode(loop.file)));
    const buffers = [first, ...rest];
    if (buffers.some((buffer) => !buffer)) return null;
    const crackle = clips.crackle ? await decode(clips.crackle).catch(() => null) : null;
    return {
      recorded: true,
      loops: buffers.map((buffer, i) => ({ buffer: levelBuffer(buffer, { rms: LOOP_RMS }), rpm: clips.loops[i].rpm })),
      crackle: crackle && levelBuffer(crackle, { peak: CRACKLE_PEAK })
    };
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
 * options: entity (the swim car), controls() → { throttle } as driven this frame, clips() → the recorded bank or null.
 */
function createSwimEngineVoice(context, resources, output, { entity = null, controls = () => null, clips = () => null } = {}) {
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
  const input = { speed: 0, throttle: 0, wheelspin: 0, slipAngle: 0 };
  let layer = null;
  let retiring = [];
  let player = false;
  let doppler = 1;
  let disposed = false;
  let overrunUntil = 0, nextPop = 0;
  const oneShots = new Set();

  function buildLayer(bank, now, fade) {
    const layerGain = gain(fade ? 0 : 1);
    layerGain.connect(bus);
    const sources = [], gains = [], rates = [], levels = [];
    for (const { buffer } of bank.loops) {
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
    if (fade) layerGain.gain.setTargetAtTime(1, now, LOOP_SWAP_TIME / 3);
    return { bank, layerGain, sources, gains, rates, levels, rpms: bank.loops.map((loop) => loop.rpm), weights: [] };
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
    } else {
      const pops = short ? 1 + Math.floor(Math.random() * 2) : 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < pops; i++) syntheticPop(when + i * (0.05 + Math.random() * 0.12), volume * (0.6 + Math.random() * 0.4));
    }
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

  function useBank(now) {
    const recorded = clips();
    if (!layer) {
      layer = buildLayer(recorded || synthesizedBank(resources), now, false);
    } else if (recorded && layer.bank !== recorded) {
      retire(layer, now);
      layer = buildLayer(recorded, now, true);
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
    } else {
      input.speed = input.throttle = input.wheelspin = input.slipAngle = 0;
    }
    stepEngine(state, input, dt, M3_ENGINE);

    const rpm = state.rpm;
    const span = clamp((rpm - M3_ENGINE.idle) / (M3_ENGINE.limiter - M3_ENGINE.idle), 0, 1);
    const load = state.load;
    loopWeights(rpm, layer.rpms, layer.weights);
    for (let i = 0; i < layer.sources.length; i++) {
      layer.rates[i](clamp(rpm / layer.rpms[i] * doppler, 0.25, 4), now);
      layer.levels[i](layer.weights[i], now);
    }
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
    if (state.lift) {
      crackle(now, 0.55 + 0.45 * state.lift, false);
      overrunUntil = now + OVERRUN_TIME * state.lift;
      nextPop = now + 0.5 + Math.random() * 0.4;
    } else if (now < overrunUntil && state.throttle < 0.1 && rpm > 2600 && now >= nextPop) {
      crackle(now, 0.35 + Math.random() * 0.25, true);
      nextPop = now + 0.18 + Math.random() * 0.45;
    }
    if (state.throttle > 0.2) overrunUntil = 0;
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

export { M3_CLIPS, loopWeights, levelBuffer, loadSwimEngineClips, createSwimEngineVoice };
