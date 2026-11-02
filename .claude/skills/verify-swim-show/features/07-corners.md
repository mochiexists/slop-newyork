# Beat 7: corners drifted, on the road

**What it is.** Every sharp corner of the route (the scripted run's and the roam's after it): the autopilot drifts a
corner sharper than its `sharpTurn`, and the show holds it clear of traffic (`clearNextCorner`).

**How to reach it.** Fresh scenarios of the full 165 s: 42nd & 7th, 42nd & 8th, 57th & 8th, 57th & 9th, then the
roam's corners.

**How it is driven.** The AI's keys.

**The end state that proves it** (`beatCorners`): the corners are the route's own vertices turning ≥ 45° (the trace
logs the AI's path whenever it changes; a session's turns are read off its heading, ≥ 60° within 60 m); a corner is
driven when the car passes within 25 m of it; for each, the frames within 30 m: the drift angle reaches ≥ 15°, no
footprint point on pavement/plaza/median/park/building, no building push or traffic overlap. Dashed rings on the
report's whole-run map.

**Gotchas.**
- A corner the car never reached (the run ended first) isn't counted; no corner at all is INCONCLUSIVE.
- A drifted corner swings the tail wide: the footprint check is of the whole box at its heading, so a tail over the
  kerb counts.
