// The swim UI's engine switch (the button on the Careless Whisper card, and the K key in main.js): which recording the
// swimming car's engine plays, the tuned M3 or the GTA V mod's M5. audio-system.js swaps the banks and remembers the
// pick; this only shows it.

import { SWIM_ENGINES } from './swim-engine-audio.js';

const MOD_MISSING_HINT = 'run tools/extract-m5-mod-sound.py to install it';

/** Wires the button to the audio system; returns update(), to call whenever the engine or its banks change. */
function bindSwimEngineToggle(button, audioSystem) {
  button?.addEventListener('click', () => audioSystem.toggleSwimEngine());
  return function update() {
    if (!button) return;
    const choice = audioSystem.swimEngine;
    const modMissing = audioSystem.swimEngineBanks.m5mod === null;
    const other = SWIM_ENGINES[choice === 'm3' ? 'm5mod' : 'm3'].label;
    button.textContent = SWIM_ENGINES[choice].label;
    button.dataset.engine = choice;
    button.setAttribute('aria-pressed', String(choice === 'm5mod'));
    button.classList.toggle('is-unavailable', modMissing);
    button.title = modMissing
      ? `Engine sound: ${SWIM_ENGINES.m5mod.label} is not installed (${MOD_MISSING_HINT}) [K]`
      : `Engine sound: switch to ${other} [K]`;
  };
}

export { bindSwimEngineToggle };
