# Beat 9: any driving key takes over; I hands back

**What it is.** musa's line under the checklist: "Any driving key takes over; I hands back." swim-show.js `fly`
stops the show the tick a driving key is down and lets that key through to the car; I (swim-mode.js `toggleAI`)
starts `SwimShow.roam` from wherever the car is.

**How to reach it.** `takeover-donuts-30` (D held 1.5 s at 10 s, mid-donut; I at 14 s) and `takeover-run-30` (W held
2 s at 40 s, on the run; I at 45 s), both in the deterministic suite. Any scenario can press keys: `inputs: [{ t,
key, action }]` in lib/scenarios.mjs; each lands between two ticks and is logged in the trace (`input` events).

**How it is driven.** The AI's keys until the player's press; the player's (the runner's keyboard) until I; the AI's
after.

**The end state that proves it** (`beatHandoff`): the first tick after the driving key: the show `off`, no pilot, the
car's keys exactly the player's (`k` = `pk`, the controllers' own) and including that key; every tick from there to
I the same; the first tick after I: the show in `roam` with its pilot; the new route's first point ≤ 0.5 m from the
car; the car moving no more across the press than its speed carries it (+ 0.05 m); the AI driving ≥ 20 m in the next
10 s without giving the car back. The beats the takeover cut short read N/A.

**Gotchas.** `broken-takeover` (keys don't stop the show) and `broken-handback` (the roam's route 40 m off) fail here
live. A scenario without key presses is N/A on this beat.
