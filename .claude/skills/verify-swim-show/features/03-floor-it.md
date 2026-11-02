# Beat 3: floor it

**What it is.** The donut driver's `launch` (and `kick`): W down, the wheel turned onto the circle. The keyboard
driver's traction control (drift-physics.js KEYBOARD_DRIVER) gives a W with the wheel turned only what the tyres take,
so the throttle input climbs later than the key: the key is the player's, the throttle the car's answer.

**How to reach it.** Fresh scenarios: the first frame with `phase: 'donuts'` (the `donut-launch` event and screenshot).

**How it is driven.** The AI's keys.

**The end state that proves it** (`beatFloor`): W down for ≥ 90 % of the first 0.5 s; within 1.5 s the keyboard
driver's throttle reaches 0.95 or the rears spin (wheelspin ≥ 0.5); and the speed over the ground rises ≥ 2 m/s in that
time, or the slide starts (≥ 20°, the donut driver's own `slideAngle`).

**Gotchas.**
- A session has no throttle logged: the wheelspin and speed carry it.
- The launch is found by phase in a run; in a session it is read back from the driving (`lib/session.mjs`: the first
  W held unbroken ≥ 0.4 s from a rolling start ≥ 3 m/s).
