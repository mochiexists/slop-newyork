# Beat 1: start on the road, in a 7th Ave lane heading toward the cop

**What it is.** P teleports the car to `SHOW_SPOT` (swim-show.js) and the show rolls it toward the NYPD cruiser parked
at `COP_SPOT` (7th Ave & 45th St, 2 m west of the avenue's centreline). musa wants that start on the carriageway, in a
lane, pointed at the cop: not on the Times Square plaza or the pavement.

**How to reach it.** Any fresh scenario: `node tools/swim-eval/run.mjs fresh-s1-120 --out <dir> --duration 10`. It is
the trace's first frame (t of the first show frame) and the roll after it. Injected (launch-*) scenarios have no
start: N/A.

**How it is driven.** Only P. Nothing else is pressed.

**The end state that proves it** (`lib/check.mjs beatStart`): the car's centre and its whole footprint (corners and
mid-sides of the 0.97 × 2.52 m box) classify as `road`; `nearestRoads` names 7th Ave with the car inside half its
width; the point lies in a road-graph edge's corridor (a lane); heading within 30° of the line to the cop and within
20° of 7th Ave's one-way direction (south, heading 0); no roll frame off the road. Screenshot `shots/00-p.jpg`; on the
report's opening map the P marker sits on the plaza (beige) or the road (light).

**Gotchas.**
- `city-config.js blockAt` says "road" on the plaza: the plazas are not BLOCKS. The plaza comes from
  `lib/map.mjs plazaPieces`, a port of city-grid.js's (the runner checks it against the page's own plaza footprints:
  9 of 9 on 89419cc). If city-grid.js's plaza cut changes, port it again.
- On 89419cc `SHOW_SPOT` is (-597.8, -266.6): 13 m west of 7th Ave's centreline, on the bowtie's plaza piece. Every
  fresh run starts NOT VERIFIED here until the spot moves.
- The heading convention is the game's: heading 0 faces +z (south), `atan2(dx, dz)`.
