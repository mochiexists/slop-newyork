import {
  SWIM_ENGINES, createSwimEngineVoice, loadSwimEngineClips, loadM5ModShots, nextSwimEngine, swimEngineBank
} from './swim-engine-audio.js';

// The swimming car's engine in the city's audio (audio-system.js keeps the hooks: it makes one of these, loads it with
// each audio context and asks it for the swim car's voice; audio-sources.js asks it for the pedal). Which engine the
// car sounds like (SWIM_ENGINES) is remembered; its banks load with the audio context.

const STORAGE_KEY = 'nyc-swim-engine';
const unit = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

// The swimming car's pedal as driven this frame, 0-1: the keyboard driver's output (swim-car.js swimDriver, after any
// AI driver has pressed its keys); before the first swim frame, the keys. (audio-sources.js plays it as the engine load.)
function swimThrottle(controllers) {
  const input = controllers.swimDriver?.input;
  return input ? unit(Math.max(input.throttle, input.reverse)) : unit(+controllers.keys.forward);
}

class SwimEngineSounds {
  // `audioSystem`: the CityAudioSystem (its current context), `controllers`: the ThirdPersonControllerManager
  constructor(audioSystem, controllers) {
    this.audioSystem = audioSystem;
    this.controllers = controllers;
    this.engine = 'm3'; // the SWIM_ENGINES id playing
    this.banks = {}; // id → its loaded bank, null once known to be missing
    this.shots = null; // the sound mod's pops, once loaded
    this.onChange = () => {}; // the engine or its banks changed (swim-engine-toggle.js shows it)
    this.pedal = { throttle: 0 };
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (Object.hasOwn(SWIM_ENGINES, saved)) this.engine = saved;
    } catch { /* Private browsing. */ }
  }

  // The recorded engines (tools/fetch-m3-sound.sh, tools/extract-m5-mod-sound.py), for a new audio context; the voice
  // runs synthesized until, or unless, the chosen one loads, and the sound mod's pops layer over whichever plays.
  load(context) {
    this.shots = null;
    this.banks = {};
    for (const [id, engine] of Object.entries(SWIM_ENGINES)) {
      loadSwimEngineClips(context, engine.clips).then((bank) => {
        if (this.audioSystem.context !== context) return;
        this.banks[id] = bank;
        if (!bank && this.engine === id) this.engine = nextSwimEngine(id, this.banks); // stays on M3
        this.onChange();
      });
    }
    loadM5ModShots(context).then((shots) => {
      if (this.audioSystem.context === context) this.shots = shots;
    });
  }

  // Swaps the car between its engines (the voice crossfades); an engine known to be missing isn't picked.
  toggle() {
    const next = nextSwimEngine(this.engine, this.banks);
    if (next === this.engine) return;
    this.engine = next;
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Storage is optional. */ }
    this.onChange();
  }

  // The pedal, for the voice
  controls() {
    this.pedal.throttle = swimThrottle(this.controllers);
    return this.pedal;
  }

  // The voice for a motor source, or null when it isn't the swimming car (audio-system.js then makes its own)
  voiceFor(source, siren, input) {
    if (siren || source.kind !== 'swim') return null;
    const { context, resources } = this.audioSystem;
    return createSwimEngineVoice(context, resources, input, { entity: source.id, controls: () => this.controls(),
      clips: () => swimEngineBank(this.engine, this.banks), shots: () => this.shots });
  }
}

export { SwimEngineSounds, swimThrottle };
