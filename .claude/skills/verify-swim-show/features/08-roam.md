# Beat 8: endless roam, stopped < 10 % of the time, never stuck

**What it is.** After the scripted run the show keeps extending the route with `RoamRoute` (swim-roam.js, seed 7):
Midtown's avenues and wide cross streets, swimming each, drifting each corner, unsticking itself (`unstick`: backing
out, pulling round) when blocked, waiting in a red light's queue.

**How to reach it.** Fresh scenarios of the full 165 s: the roam starts once the car is within 25 m of 57th St & 9th
Ave (or at an `I`-key roam's start). Needs ≥ 30 s of it: the full scenarios give ~40-70 s; lengthen with
`--duration` to judge it harder.

**How it is driven.** The AI's keys.

**The end state that proves it** (`beatRoam`): stopped (ground speed < 1 m/s) under 10 % of the roam; never stuck (no
10 s window in which the car stays within 5 m of where it was); the show still driving at the end (phase not `off`).
Time spent backing out is shown. The speed chart's tail, and `failures/` stills at a stuck moment.

**Gotchas.**
- A red light's queue counts as stopped: musa's "stopped < 10 %" includes it.
- If the run never reaches 57th & 9th (stuck on 8th Ave, say), the roam is empty: INCONCLUSIVE here, and beat 6/7 say
  why.
