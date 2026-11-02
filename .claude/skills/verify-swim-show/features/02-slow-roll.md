# Beat 2: slow roll under 12 mph for ~4 s, no burnout

**What it is.** The DonutDriver's `roll` phase: a feathered W (pressed under `rollSpeed - rollBand`, let go over
`rollSpeed`, 5 m/s = 11.2 mph) down the roll line until the car is `launchLead` s short of the tangent point.

**How to reach it.** Any fresh scenario, show phase `roll` (trace frames with `phase: 'roll'`), from P to the donut
driver's `launch` event.

**How it is driven.** By the AI's own keys; the harness presses nothing.

**The end state that proves it** (`beatRoll`): roll time 3-6 s; top speed over the ground < 12 mph (shown to 0.01:
the roll's own target sits at 11.2 mph and its overshoot lands within a few hundredths of 12); wheelspin ≥ 0.5
(drift-physics.js, 0-1) for less than 0.2 s in total; no frame with W and S together. Screenshots `00-p` and
`01-donut-launch`; the speed chart's first stretch sits under the dashed 12 mph rule.

**Gotchas.**
- The ground speed counts the sideways slide (`speed` plus `vx, vz`), not just `car.speed`.
- musa's own session came out 12.05 mph: the roll passes or fails on the overshoot of the feather, so look at the
  number, not only the verdict.
