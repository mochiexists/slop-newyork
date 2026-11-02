# Beat 5: drift out onto 7th Ave; 50 mph within ~3 s

**What it is.** Past its laps, when the way down the avenue comes round within 45° ahead, the donut driver powers out
(`powerOut`: off the gas with the counter-steer until the slide is under 12°, then floored), and the swim autopilot
takes the car on (`escape` phase) down 7th Ave.

**How to reach it.** Fresh or launch scenarios; the `donut-powerOut` event and screenshot, then `show-escape`.

**How it is driven.** The AI's keys.

**The end state that proves it** (`beatExit`): from the powerOut frame, 50 mph over the ground within 3.5 s; at that
moment (or 3.5 s on, if never) the car is on the road with 7th Ave the nearest street, travelling within 30° of
south. The drift angle as it powers out is shown, not gated.

**Gotchas.**
- In a session there is no powerOut marker: the way out is read back as the car leaving the circle (> 16 m from the
  cop, moving away > 2 m/s).
- "~3 s" is judged at 3.5 s; the number is in the table, so a near miss is visible.
