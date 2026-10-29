const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const physics = loadModule(read('js/drift-physics.js'));
const engine = loadModule(read('js/swim-engine.js'));
const audio = loadModule(read('js/swim-engine-audio.js'), {
  imports: { './audio-synthesis.js': { setControlRate() {} }, './swim-engine.js': engine }
});
const { M3_ENGINE, rpmPerSpeed, createEngineState, stepEngine } = engine;

const DT = 1 / 240;
const idle = { throttle: 0, brake: 0, reverse: 0, steer: 0, handbrake: 0, burnout: 0 };

function car(speed = 0) {
  return { position: { x: 0, z: 0 }, heading: 0, speed, vx: 0, vz: 0, angularVel: 0, steerAngle: 0 };
}

// Drives the drift model and the engine together, recording every step
function drive(c, state, seconds, input, log = []) {
  for (let t = 0; t < seconds; t += DT) {
    const telemetry = physics.stepDriftCar(c, input, DT);
    stepEngine(state, { speed: c.speed, throttle: input.throttle, wheelspin: telemetry.wheelspin, slipAngle: telemetry.slipAngle }, DT);
    log.push({ speed: c.speed, gear: state.gear, rpm: state.rpm, cut: state.cut, upshift: state.upshift, lift: state.lift,
      blowoff: state.blowoff });
  }
  return log;
}

// The engine alone, with the wheels' state given directly
function run(state, seconds, input, log = []) {
  for (let t = 0; t < seconds; t += DT) {
    stepEngine(state, input, DT);
    log.push({ rpm: state.rpm, gear: state.gear, cut: state.cut, blip: state.blip, upshift: state.upshift, lift: state.lift });
  }
  return log;
}

test('the gearing matches a G80 M3: first runs out near 58 km/h, top gear is long', () => {
  const first = M3_ENGINE.limiter / rpmPerSpeed(0) * 3.6;
  assert.ok(first > 54 && first < 62, `first gear tops out at ${first.toFixed(0)} km/h`);
  assert.ok(rpmPerSpeed(7) * 98 < M3_ENGINE.limiter, 'eighth gear reaches the car\'s top speed under the limiter');
  for (let gear = 1; gear < M3_ENGINE.ratios.length; gear++) assert.ok(rpmPerSpeed(gear) < rpmPerSpeed(gear - 1));
  assert.ok(rpmPerSpeed(-1) > 0, 'reverse has a ratio too');
});

test('a parked engine idles, and engine speed never leaves idle..limiter', () => {
  const state = createEngineState();
  run(state, 2, { speed: 0, throttle: 0, wheelspin: 0 });
  assert.equal(Math.round(state.rpm), M3_ENGINE.idle);
  assert.equal(state.gear, 0);
  const log = drive(car(), createEngineState(), 14, { ...idle, throttle: 1 });
  for (const step of log) {
    assert.ok(step.rpm >= M3_ENGINE.idle * 0.9 && step.rpm <= M3_ENGINE.limiter + 60, `rpm ${step.rpm}`);
  }
});

test('a flat-out launch shifts up through the gears in order, each shift dropping the revs by the ratio step', () => {
  const log = drive(car(), createEngineState(), 14, { ...idle, throttle: 1 });
  const shifts = log.map((step, i) => ({ ...step, i })).filter((step) => step.upshift);
  assert.ok(shifts.length >= 5, `${shifts.length} upshifts`);
  shifts.forEach((shift, n) => assert.equal(shift.gear, n + 1, 'one gear at a time, from first'));
  for (const shift of shifts.slice(1)) {
    // Just before the shift the engine is near the top; a tenth of a second later it sits on the next gear's revs
    const before = log[shift.i - 1].rpm;
    const after = log[shift.i + 24].rpm;
    assert.ok(before > 6000, `shifts up near the top (${before.toFixed(0)} rpm)`);
    const expected = before * rpmPerSpeed(shift.gear) / rpmPerSpeed(shift.gear - 1);
    assert.ok(Math.abs(after - expected) < 700, `after the shift ${after.toFixed(0)} rpm, expected about ${expected.toFixed(0)}`);
  }
});

test('wheelspin at a launch flares the revs before the road speed catches up', () => {
  const log = drive(car(), createEngineState(), 0.6, { ...idle, throttle: 1 });
  const end = log[log.length - 1];
  assert.equal(end.gear, 0, 'still in first');
  assert.ok(end.rpm > end.speed * rpmPerSpeed(0) + 1000, `${end.rpm.toFixed(0)} rpm at ${end.speed.toFixed(1)} m/s`);
});

test('a burnout holds the limiter, bouncing off the fuel cut many times a second', () => {
  const state = createEngineState();
  const log = run(state, 2, { speed: 0, throttle: 1, wheelspin: 1 });
  const held = log.slice(log.length / 2);
  const cuts = held.filter((step, i) => step.cut && !held[i - 1]?.cut).length;
  assert.ok(cuts >= 8 && cuts <= 30, `${cuts} fuel cuts in a second`);
  const low = Math.min(...held.map((step) => step.rpm)), high = Math.max(...held.map((step) => step.rpm));
  assert.ok(high >= M3_ENGINE.limiter && low > M3_ENGINE.limiter - 600, `bounces between ${low.toFixed(0)} and ${high.toFixed(0)}`);
  assert.equal(state.gear, 0);
});

test('a throttle stab at a standstill blips the revs, which fall back to idle', () => {
  const state = createEngineState();
  run(state, 0.5, { speed: 0, throttle: 0, wheelspin: 0 });
  const stab = run(state, 0.15, { speed: 0, throttle: 1, wheelspin: 0 });
  assert.equal(stab.filter((step) => step.blip).length, 1, 'one blip event');
  const peak = Math.max(...stab.map((step) => step.rpm));
  assert.ok(peak > 3000, `flares to ${peak.toFixed(0)} rpm`);
  run(state, 1.5, { speed: 0, throttle: 0, wheelspin: 0 });
  assert.ok(state.rpm < M3_ENGINE.idle + 100, `settles at ${state.rpm.toFixed(0)} rpm`);
});

test('lifting off from high revs with boost up crackles and dumps the boost', () => {
  const state = createEngineState();
  run(state, 2, { speed: 0, throttle: 1, wheelspin: 1 });
  assert.ok(state.boost > 0.8, `boost ${state.boost.toFixed(2)}`);
  const lift = run(state, 0.3, { speed: 0, throttle: 0, wheelspin: 0 });
  const events = lift.filter((step) => step.lift > 0);
  assert.equal(events.length, 1, 'one lift-off');
  assert.ok(events[0].lift > 0.7);
  // A gentle part-throttle lift at low revs does neither
  const cruise = createEngineState();
  run(cruise, 1, { speed: 10, throttle: 0.4, wheelspin: 0 });
  stepEngine(cruise, { speed: 10, throttle: 0, wheelspin: 0 }, DT);
  assert.equal(cruise.lift, 0);
  assert.equal(cruise.blowoff, 0);
});

test('off the throttle the wheels hold the revs (engine braking) and the gearbox steps down as the car slows', () => {
  const state = createEngineState();
  run(state, 4, { speed: 60, throttle: 0, wheelspin: 0 }); // settle into a cruising gear first
  const log = [];
  for (let speed = 60; speed > 2; speed -= 0.05) {
    stepEngine(state, { speed, throttle: 0, wheelspin: 0 }, DT * 4);
    log.push({ speed, gear: state.gear, rpm: state.rpm });
  }
  const gears = log.map((step) => step.gear);
  for (let i = 1; i < gears.length; i++) assert.ok(gears[i] <= gears[i - 1], 'never shifts up while slowing');
  assert.ok(gears[0] >= 5 && gears[gears.length - 1] <= 1, `from ${gears[0] + 1}th down to ${gears[gears.length - 1] + 1}`);
  let settled = 0; // log steps (1/60 s each) since the last gear change; a downshift's rev-match takes about 0.15 s
  for (let i = 1; i < log.length; i++) {
    const step = log[i];
    settled = step.gear === log[i - 1].gear ? settled + 1 : 0;
    const coupled = step.speed * rpmPerSpeed(step.gear);
    if (settled > 12 && coupled > M3_ENGINE.idle + 200) {
      assert.ok(Math.abs(step.rpm - coupled) < 250, `${step.rpm.toFixed(0)} vs ${coupled.toFixed(0)}`);
    }
  }
});

test('sideways, the gearbox holds its gear and lets the revs hit the limiter', () => {
  const sliding = createEngineState();
  const straight = createEngineState();
  sliding.gear = straight.gear = 1;
  run(sliding, 1, { speed: 22, throttle: 1, wheelspin: 1, slipAngle: 0.5 });
  run(straight, 1, { speed: 22, throttle: 1, wheelspin: 1, slipAngle: 0 });
  assert.equal(sliding.gear, 1);
  assert.ok(sliding.limiting, 'on the limiter');
  assert.ok(straight.gear > 1, 'without the slide it shifts up');
});

test('reversing selects reverse', () => {
  const state = createEngineState();
  run(state, 0.5, { speed: -4, throttle: 0.6, wheelspin: 0 });
  assert.equal(state.gear, -1);
  assert.ok(state.rpm > M3_ENGINE.idle);
});

test('loop weights crossfade with equal power and play one loop alone near its own speed', () => {
  const rpms = audio.M3_CLIPS.loops.map((loop) => loop.rpm);
  for (let rpm = 500; rpm <= 7400; rpm += 37) {
    const w = audio.loopWeights(rpm, rpms);
    const power = w.reduce((sum, value) => sum + value * value, 0);
    assert.ok(Math.abs(power - 1) < 1e-9, `power ${power} at ${rpm}`);
    assert.ok(w.filter((value) => value > 1e-6).length <= 2, 'at most two loops at once');
  }
  assert.deepEqual([...audio.loopWeights(500, rpms)], [1, 0, 0]);
  assert.deepEqual([...audio.loopWeights(7200, rpms)], [0, 0, 1]);
  const atLow = audio.loopWeights(rpms[1] * 1.05, rpms);
  assert.ok(atLow[1] > 0.999, 'the low loop alone just above its recorded speed');
  const between = audio.loopWeights(Math.sqrt(rpms[1] * rpms[2]), rpms);
  assert.ok(Math.abs(between[1] - between[2]) < 1e-9, 'an even mix halfway (in log rpm)');
});

test('the clips the voice loads are the ones tools/fetch-m3-sound.sh cuts, and they stay out of git', () => {
  const script = read('tools/fetch-m3-sound.sh');
  const clips = [...script.matchAll(/^\s*"(\w+)\|([\w-]{11})\|([\d.]+)\|([\d.]+)\|(loop|shot)"$/gm)]
    .map(([, name, id, start, end, kind]) => ({ name, id, start: +start, end: +end, kind }));
  const loops = clips.filter((clip) => clip.kind === 'loop').map((clip) => `${clip.name}.wav`);
  assert.deepEqual([...audio.M3_CLIPS.loops.map((loop) => loop.file)], loops);
  assert.ok(clips.some((clip) => `${clip.name}.wav` === audio.M3_CLIPS.crackle));
  for (const clip of clips) assert.ok(clip.end > clip.start && clip.end - clip.start <= 3, `${clip.name} is short`);
  // Each loop's measured speed is written down in the script's header too
  for (const loop of audio.M3_CLIPS.loops) assert.match(script, new RegExp(`-> ${loop.rpm} rpm`));
  assert.ok(script.includes(audio.M3_CLIPS.folder.replace(/\/$/, '')), 'writes where the voice reads');
  assert.match(read('.gitignore'), /^assets\/audio\/$/m);
});

test('missing clips resolve to no bank after a single request, never an error', async () => {
  const requests = [];
  const context = { decodeAudioData: async () => { throw new Error('nothing to decode'); } };
  const bank = await audio.loadSwimEngineClips(context, audio.M3_CLIPS, async (url) => {
    requests.push(url);
    return { ok: false, status: 404 };
  });
  assert.equal(bank, null);
  assert.deepEqual(requests, ['assets/audio/m3/idle.wav']);
  const offline = await audio.loadSwimEngineClips(context, audio.M3_CLIPS, async () => { throw new TypeError('offline'); });
  assert.equal(offline, null);
});

test('loaded clips are levelled: loops to one loudness, the crackle to a peak', async () => {
  const buffers = new Map();
  const fake = (amplitude) => {
    const data = Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i * 0.3) * amplitude);
    return { getChannelData: () => data, duration: 0.125 };
  };
  const context = { decodeAudioData: async (bytes) => buffers.get(bytes) };
  const bank = await audio.loadSwimEngineClips(context, audio.M3_CLIPS, async (url) => {
    const bytes = { url };
    buffers.set(bytes, fake(url.includes('high') ? 0.9 : 0.05));
    return { ok: true, arrayBuffer: async () => bytes };
  });
  assert.equal(bank.recorded, true);
  const rms = bank.loops.map(({ buffer }) => {
    const data = buffer.getChannelData(0);
    return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
  });
  for (const value of rms) assert.ok(Math.abs(value - rms[0]) < 1e-3, `loop RMS ${rms}`);
  assert.deepEqual([...bank.loops.map((loop) => loop.rpm)], [...audio.M3_CLIPS.loops.map((loop) => loop.rpm)]);
  const peak = Math.max(...bank.crackle.getChannelData(0).map(Math.abs));
  assert.ok(peak > 0.85 && peak <= 0.95);
});
