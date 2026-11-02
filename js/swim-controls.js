import { shiftDown, shiftUp, toggleManual } from './drift-physics.js';
import { SWIM_STARTS, SQUEEZE_ROUTE, SHOW_SPOT } from './swim-mode.js';
import { bindSwimEngineToggle } from './swim-engine-toggle.js';
import { M5Cockpit } from './m5-cockpit.js';
import { loadSwimCarModel } from './m3-model.js';
import { installSessionRecorder } from './session-recorder.js';
import { SwimClock } from './swim-clock.js';

// The swimming mode's wiring into the page: the car's cockpit, recorder, model and engine button (setUpSwimCar), and
// its keys, the teleport menu's swim buttons and the map's Squeeze route (bindSwimControls). main.js creates the
// SwimDirector, calls these two, adds the mode's hints and speed meter scale below to its own tables and updates the
// director and cockpit each frame; the upstream file keeps only those hooks.

// The swimming car's parts that live outside the physics, once the director exists. Returns the cockpit (main.js
// updates it each frame).
function setUpSwimCar({ controllerManager, cameraSystem, audioSystem, swimDirector, isTypingInField }) {
  const m5Cockpit = new M5Cockpit(controllerManager.entities.swim, swimDirector.radio);
  // The swimming car's fixed clock (swim-clock.js): main.js advances it each frame
  const clock = controllerManager.swimClock = new SwimClock({ controllers: controllerManager, director: swimDirector });
  // The swimming car's flight recorder: to the dev server's /session-log, and a file on L (session-recorder.js); it
  // notes where each of the clock's runs starts
  const recorder = installSessionRecorder({ controllerManager, cameraSystem, isTypingInField, onSaved: () => swimDirector.score.flash('SESSION SAVED', 'banked') });
  clock.onRun = (run, car) => recorder.run(run, car, controllerManager.swimDriver, swimDirector.cruiser, swimDirector.show);
  // Full build: the real M3 Competition model replaces the procedural car when assets/models/m3.glb is there
  loadSwimCarModel(controllerManager.entities.swim, m5Cockpit).catch((error) => console.warn('M3 model not loaded:', error));
  // The swimming car's engine sound, M3 or the GTA mod's M5: the button on the Careless Whisper card and K
  audioSystem.swimSounds.onChange = bindSwimEngineToggle(document.getElementById('swim-engine'), audioSystem.swimSounds);
  audioSystem.swimSounds.onChange();
  return m5Cockpit;
}

// Keyboard guide for the mode: [keys, action] (main.js controlHints)
const SWIM_CONTROL_HINTS = [[['W', 'S'], 'Gas / Brake'], [['W', 'S'], 'Both: burnout'], [['Space'], 'Handbrake'],
  [['P'], 'AI show'], [['I'], 'AI drives / you drive'], [['F'], 'Flip off'], [['G'], 'George Michael'],
  [['K'], 'Engine sound'], [['T'], 'Auto / manual'], [['Z', 'X'], 'Gear down / up']];
// Full scale of the speed meter in mph (main.js topSpeedMph): drift-physics.js caps the car at 85 m/s
const SWIM_TOP_SPEED_MPH = 190;

// `app` is main.js's: controllerManager, swimDirector, m5Cockpit, audioSystem, mapSystem, isTypingInField,
// selectMode(mode), teleportTo(x, z, heading) → where it landed, closePopovers().
function bindSwimControls(app) {
  const { controllerManager, swimDirector, m5Cockpit, audioSystem, mapSystem, selectMode, teleportTo, closePopovers } = app;

  // The two reference clips: get in the M5 where each one starts. The map carries the Squeeze Benz drive.
  document.querySelectorAll('[data-swim-start]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const start = SWIM_STARTS[btn.getAttribute('data-swim-start')];
      if (!start) return;
      selectMode('swim');
      swimDirector.stopShow();
      const at = teleportTo(start.x, start.z, start.heading);
      swimDirector.parkCruiserNear(at.x, at.z, start.heading);
      closePopovers();
    });
  });

  // The AI show: donuts round the cop in Times Square, the escape, then the AI roams on until P or a driving key
  // (the show's run starts the city's clock on its point in the signal cycle, swim-show.js start)
  function startSwimShow() {
    selectMode('swim');
    teleportTo(SHOW_SPOT.x, SHOW_SPOT.z, SHOW_SPOT.heading);
    swimDirector.startShow();
  }
  document.querySelectorAll('[data-swim-show]').forEach((btn) => {
    btn.addEventListener('click', () => {
      startSwimShow();
      closePopovers();
    });
  });
  mapSystem.overlayRoutes.push({ points: SQUEEZE_ROUTE, color: '#ff4fa3' });

  // The mode's keys (main.js's own shortcuts have the mode on 5 and the follow cameras on 6-8). Those that change the
  // car outside the physics are noted for a replay, with the tick they come before (session-recorder.js)
  const noteEvent = (name) => controllerManager.swimRecorder?.event(name, controllerManager.swimClock?.ticks);
  window.addEventListener('keydown', (e) => {
    if (app.isTypingInField(e)) return;
    const swimming = controllerManager.activeMode === 'swim';
    const plain = !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey; // a single press, no shortcut modifier
    const car = controllerManager.entities.swim;
    switch (e.code) {
      case 'KeyP':
        if (e.repeat || mapSystem.isFullMapOpen) break;
        if (swimDirector.show.running) {
          swimDirector.stopShow();
          noteEvent(SWIM_EVENTS.stopShow);
        } else {
          startSwimShow();
        }
        break;
      case 'KeyI': // the AI drives on from where the car is (swim-show.js roam), or gives the car back
        if (plain && swimming) {
          swimDirector.toggleAI();
          noteEvent(SWIM_EVENTS.toggleAI);
        }
        break;
      case 'KeyG': // George Michael on / off
        if (plain && swimming) {
          if (swimDirector.radio.wanted) swimDirector.radio.pause();
          else swimDirector.radio.play();
        }
        break;
      case 'KeyF': // the driver's left hand up (toggle), see m5-cockpit.js
        if (plain && swimming) m5Cockpit.toggleBird();
        break;
      case 'KeyK': // swap the engine sound, M3 / M5 (GTA mod), see swim-engine-toggle.js
        if (plain && swimming) audioSystem.swimSounds.toggle();
        break;
      case 'KeyT': // automatic or manual gearbox
        if (plain && swimming) {
          const manual = toggleManual(car);
          noteEvent(SWIM_EVENTS.manual);
          swimDirector.score.flash(manual ? 'MANUAL · X UP · Z DOWN' : 'AUTOMATIC', 'banked');
        }
        break;
      case 'KeyX': // manual: shift up
        if (!e.repeat && swimming && car.manual) {
          shiftUp(car);
          noteEvent(SWIM_EVENTS.shiftUp);
        }
        break;
      case 'KeyZ': // manual: shift down (refused if it would over-rev)
        if (!e.repeat && swimming && car.manual) {
          shiftDown(car);
          noteEvent(SWIM_EVENTS.shiftDown);
        }
        break;
    }
  });
}

// The recorded events (session-recorder.js) and what a replay does for each, with the car and the director
const SWIM_EVENTS = { stopShow: 'stopShow', toggleAI: 'toggleAI', manual: 'manual', shiftUp: 'shiftUp', shiftDown: 'shiftDown' };
function replayEvent(name, car, swimDirector) {
  if (name === SWIM_EVENTS.stopShow) swimDirector.stopShow();
  else if (name === SWIM_EVENTS.toggleAI) swimDirector.toggleAI();
  else if (name === SWIM_EVENTS.manual) toggleManual(car);
  else if (name === SWIM_EVENTS.shiftUp) shiftUp(car);
  else if (name === SWIM_EVENTS.shiftDown) shiftDown(car);
}

export { SWIM_CONTROL_HINTS, SWIM_EVENTS, SWIM_TOP_SPEED_MPH, bindSwimControls, replayEvent, setUpSwimCar };
