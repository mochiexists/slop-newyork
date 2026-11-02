# Beat 6: swim on 7th Ave above 70 mph with splits and close calls, no contacts

**What it is.** The scripted run (`ESCAPE_ROUTE`): down 7th Ave, west on 42nd St, up 8th Ave, west on 57th St to 9th
Ave, the cop chasing for 14 s; the show stages rows of two cars side by side to split as each corner comes up
(swim-traffic.js `stageRoute`, seeded by the scenario's traffic seed).

**How to reach it.** Fresh scenarios of the full 165 s (the run takes ~60-90 s after the donuts); launch scenarios
reach its start.

**How it is driven.** The AI's keys.

**The end state that proves it** (`beatSwim`). One window, the 7th Ave stretch: from where beat 5's way out ends (the
50 mph moment) to the route's first corner (the first turn of the build's `ESCAPE_ROUTE`, carried in the trace: 42nd
St to e7f9c83, 34th St once worker C's opening lands), fixed by the route, not by where the car is. In it: every frame
on 7th Ave (any named road within its width + 4 m, so crossings count) with the footprint clear of the kerb; ≥ 70 mph
held unbroken ≥ 1 s; ≥ 1 split and ≥ 1 close call scored by the game in its time and on 7th Ave. Over the whole run: 0
traffic contacts (every contact traffic.js accepts with the car, hooked before the correction and at any speed:
`touch-traffic`; plus box overlaps and the game's impact reports), 0 building pushes, 0 cop contacts.

**Gotchas.**
- 7th Ave from 45th to 42nd St is ~245 m, from a car leaving a donut: 70 mph there needs the way out to be quick.
- The game's own collision listener only reports impacts over 0.5 m/s (`impact-traffic`) and the box overlap is
  sampled after the cars are pushed apart: a grazing sideswipe escaped both (Codex 2026-11-03 #10), so the runner
  hooks traffic.js's `collideWithPlayer` as it is served (`GAME_HOOKS`). A contact's screenshot is taken on the frame
  it starts.
- Codex's false passes are selftest breaks now: splits only on 8th Ave, a detour over the plaza at speed, 70 mph for
  one frame.
- A session has no traffic in it: its contacts, splits and close calls are "not logged" (INCONCLUSIVE, not a pass).
