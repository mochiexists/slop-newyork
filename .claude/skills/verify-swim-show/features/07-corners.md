# Beat 7: corners drifted, on the road

**What it is.** Every sharp corner of the route (the scripted run's and the roam's after it): the autopilot drifts a
corner sharper than its `sharpTurn`, and the show holds it clear of traffic (`clearNextCorner`).

**How to reach it.** Fresh scenarios of the full 165 s: 42nd & 7th, 42nd & 8th, 57th & 8th, 57th & 9th, then the
roam's corners.

**How it is driven.** The AI's keys.

**The end state that proves it** (`beatCorners`): the corners are the route's own vertices turning ≥ 45° (the trace
logs the AI's path whenever it changes; a session's turns are read off its heading, ≥ 60° within 60 m); a corner is
driven when the car passes within 25 m of it; judged on its first pass (the frames within 30 m): the turn completed
(left the window ≥ 15 m down the way out, travelling within 45° of it), and drifted: one unbroken spell at ≥ 15°
lasting ≥ 0.5 s and covering ≥ 50 % of the turning distance (where the travel turns from 10 % to 90 % of the
corner's turn); no footprint point on pavement/plaza/median/park/building, no building push or traffic contact.
Dashed rings on the report's whole-run map. (Before 2026-11-03 one frame at 15° made a corner drifted: Codex #9.)

**Gotchas.**
- A corner the car never reached, or the trace ends inside, isn't counted; no corner at all is INCONCLUSIVE.
- The threshold against musa's own driving (2026-11-01 sessions, 9 completed corners): unbroken spells 0.9-4.0 s,
  49-100 % of the turn (median 76 %); 8 of 9 pass. `eval-loop/fixes/harness/drift-calibration.json`.
- A drifted corner swings the tail wide: the footprint check is of the whole box at its heading, so a tail over the
  kerb counts.
