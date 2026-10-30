// The swimming car's driver: what of them (and of the cabin round them) shows for the mode and the camera, and the
// bird's timing. Plain numbers, no three.js, so the rules can be tested on their own; m5-cockpit.js builds and poses
// the meshes.

// The window glass of the procedural car while its driver is in it (1 = the painted glass of every other car)
const GLASS_SEE_THROUGH = 0.55;
// s for the left hand to leave the wheel and reach the window (and to come back)
const BIRD_TIME = 0.35;

// swimming: the swim mode is on; inside: the camera is the driver's seat; modelCabin: the full build's M3 model, which
// brings its own interior and glass
function driverView({ swimming, inside, modelCabin }) {
  const cabin = swimming && !modelCabin;
  return {
    // torso, legs and both arms with the hands on the wheel, from every camera
    body: swimming,
    // the head would fill the seat camera's view: it only shows from outside
    head: swimming && !inside,
    // the procedural interior and the open-topped body: from the seat, and through the glass from outside
    cabin,
    glassOpacity: cabin ? GLASS_SEE_THROUGH : 1,
    // the curved display is only redrawn for the seat camera
    display: swimming && inside && !modelCabin
  };
}

// The bird's progress (0 hands on the wheel, 1 out of the window) after dt seconds of raising it or not
function birdStep(amount, raising, dt, swimming = true) {
  if (!swimming) return 0;
  return Math.min(1, Math.max(0, amount + (raising ? dt : -dt) / BIRD_TIME));
}

// Smoothstep of the bird's progress: the arm eases off the wheel and into the window
function birdLift(amount) {
  return amount * amount * (3 - 2 * amount);
}

export { GLASS_SEE_THROUGH, BIRD_TIME, driverView, birdStep, birdLift };
