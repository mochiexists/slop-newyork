# Beat 6: swim on 7th Ave above 70 mph with splits and close calls, no contacts

**What it is.** The scripted run (`ESCAPE_ROUTE`): down 7th Ave, west on 42nd St, up 8th Ave, west on 57th St to 9th
Ave, the cop chasing for 14 s; the show stages rows of two cars side by side to split as each corner comes up
(swim-traffic.js `stageRoute`, seeded by the scenario's traffic seed).

**How to reach it.** Fresh scenarios of the full 165 s (the run takes ~60-90 s after the donuts); launch scenarios
reach its start.

**How it is driven.** The AI's keys.

**The end state that proves it** (`beatSwim`, window: escape until the car is within 25 m of 57th St & 9th Ave): top
speed on 7th Ave (frames with 7th Ave the nearest street, before the 42nd St corner) ≥ 70 mph; ≥ 1 split and ≥ 1 close
call scored by the game (`closeCalls.update`, events `split` / `close`); 0 traffic contacts (oriented boxes
overlapping, any speed: events `contact-traffic`, each with a screenshot), 0 building pushes, 0 cop contacts.

**Gotchas.**
- 7th Ave from 45th to 42nd St is ~245 m, from a car leaving a donut: 70 mph there needs the way out to be quick.
- The game's own collision listener only reports impacts over 0.5 m/s (`impact-traffic`); the box overlap catches
  the gentle ones too. A contact's screenshot is taken on the frame it starts.
- A session has no traffic in it: its contacts, splits and close calls are "not logged" (INCONCLUSIVE, not a pass).
