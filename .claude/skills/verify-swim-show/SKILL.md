---
name: verify-swim-show
description: Verify the AI show (press P in swim mode) against musa's 8-beat checklist with the eval harness in tools/swim-eval. Use before claiming any change to the show, the donuts, the AI driver, the swim car's physics, traffic staging or the roam "works", to capture a baseline before a change, to score a player session .jsonl, or when musa says the show looks wrong ("no donuts", "starts on the pavement", "it got stuck"). Drives the real game headless on a virtual clock, judges by the worst run, writes report pages with maps, numbers and screenshots.
---

# Verify the swim show

The show is judged by **musa's checklist** (8 beats, and a 9th for "any driving key takes over; I hands back",
`features/`), measured on the game's own map, over many scenarios,
**by the worst run**. Verdicts are VERIFIED / NOT VERIFIED / INCONCLUSIVE (not a pass) / N/A (not in that scenario).
A claim about the show reads "old value vs new value" from two summaries: capture the baseline before you change
anything.

Everything lives in `tools/swim-eval/` (committed). Output goes in your task's scratch folder, never `/tmp`, never in
the repo. Port: pick one nobody else uses (8792 was the eval worker's); `lsof -i :<port>` first.

## 1. Launch

Nothing to install: Chrome, `playwright-core` (`/Users/timapple/Documents/mcc/fujira/theforest/clawpost/clawpost/web/node_modules/playwright-core`)
and `ffmpeg` are on musa's Mac. The runner starts its own static server (`lib/server.mjs`) on `--port` when nothing
answers there and stops it when done; it serves the repo and `/assets/` from the main checkout (the M3 model and
engine sounds are never committed, so a worktree lacks them; `--assets <dir>` to change). Run from the repo root.

## 2. Doctor: is this instance worth driving?

```
node tools/swim-eval/doctor.mjs --port <port>
```

Checks Chrome, Playwright, ffmpeg, the assets, the build (and warns if `js/` has uncommitted changes: the run is of
the working tree), that `js/main.js` still has the four lines the runner hooks (each exactly once), then loads the
game headless: WebGPU adapter, the loop starting, the loading screen going, the director / controllers / traffic
reachable, no page errors of the game's own (YouTube's ad errors from the radio are ignored). It WARNs on a slow
machine (real frames/s; a 120 Hz show of 165 s is ~20 000 frames); slow is fine, it is the same run, only later.
`FAIL` on hooks means main.js changed: update `MAIN_HOOKS` in `lib/runner.mjs` (and `tests/swim-eval.test.mjs` will
have told you already).

## 3. Drive

```
# one scenario (2-10 min): run, check, report page
node tools/swim-eval/run.mjs fresh-s1-120 --out <dir> --port <port>
# the whole suite (baseline 22 runs, deterministic 20), then the summary page (always over the whole set's finished
# runs: --only a,b reruns just those). At most 2 browsers at once: WebGPU browsers starve each other on
# one Mac (3 at once sat 13 min without loading). Each run's wall clock is in run.json and the summary.
node tools/swim-eval/suite.mjs --out <dir> --port <port> --jobs 2
# score a player session offline (its AI part)
node tools/swim-eval/check.mjs <session.jsonl> --map <dir>/maps/map-<sha>.json --out <dir>
# re-check a run folder without re-running (after a checker change)
node tools/swim-eval/check.mjs <dir>/<scenario>
# every check seen failing: the synthetic ideal show and a handoff show, each at both layouts, and 60 break cases
node tools/swim-eval/selftest.mjs --map tools/swim-eval/test/map-fixture.json
```

Scenarios (`lib/scenarios.mjs`): `fresh-s<traffic seed>-<clock>` (clock `120`, `60`, `30`, `mix` = each frame 1/120 or
1/60 at random, `musa` = the dt column of musa's 2026-11-01 session, cycled), `warm-s1-mix` / `warm-s2-musa` (60 s of
driving before P), `launch-musa` (musa's over-rotated launch injected at P) and its family `launch-overrotated`,
`launch-slow`, `launch-spun`, `launch-close`, `launch-far`, `launch-musa-120`, `launch-musa-mix`; `takeover-donuts-30`
and `takeover-run-30` (a driving key mid-show, then I: beat 9); broken builds `broken-roll-and-radius`, `broken-bird`,
`broken-takeover`, `broken-handback` (each must fail its beat live; not in a suite). Any
`fresh-s<n>-<clock>[-w<warm-up s>]` is made up on the spot. `--duration <s>` shortens a run while you iterate.

Which suite: `--set baseline` (the default) runs every clock on three seeds, for a build where the frame rate changes
the run (89419cc and before). From 2771a69 the game steps on a fixed 1/120 s clock (`js/swim-clock.js`) and a seed's
run is the same tick for tick at any frame rate (checked through this harness: 120 Hz and 30 Hz, 3001 ticks, every
field equal), so use `--set deterministic`: one run per seed on the 30 Hz clock (a quarter of the frames to render),
eight traffic seeds, each scenario kind once more on a second clock, and the two takeovers (22 runs, ~25 min at
`--jobs 2`). Spend runs on seeds and scenarios, not repeats.
On a fixed-clock build the trace has one row per tick (after the whole `SwimClock.step`: car, director, traffic; the
car's sim state), not per frame (the frame's car is the drawn pose between two ticks). Math.random doesn't reach the
sim there (seed 1 vs 11: 40 s identical). A warm-up does: P starts the show's run on the city's signal clock as it
stands (`swim-clock.js beginRun`, no `elapsed` from the show), so a warm run parts from the fresh run of the same seed
at its first red light (s1: 24 s in). Compare a warm run with a warm run of the same length, never with a fresh one.

How it drives: a virtual animation clock (`lib/page.mjs clockInit`) hands the game the scenario's frame times and is
paused between the runner's steps, so every key press, the P press and every screenshot lands on an exact frame;
Math.random is seeded at load and again at P; the traffic seed goes through the show's own `traffic.reseed` call.
The same scenario replays bit for bit (checked: two parallel runs, 2403 frames, every field equal). The AI presses
its keys itself; the harness only presses P (and, for a warm-up, W/A/D as a player). An injected start state is
written once at the P frame, before the beat, never during it.

main.js, traffic.js and swim-show.js are rewritten as the page fetches them (`GAME_HOOKS` in lib/runner.mjs: main.js
exposes `__swim`, `__evalWorld`, `__evalControllers`, `__evalCockpit` and calls `__clock.loopStarting()`; traffic.js's
`collideWithPlayer` and the cruiser's `collide` call the probe with every contact they accept, before pushing the cars
apart, at any speed); no game file changes. The doctor and `tests/swim-eval.test.mjs` fail when a hooked line moves.
The checker judges by the build's own spots: the probe reads `COP_SPOT`, `SHOW_SPOT`, `DRIFT_RADIUS` and
`ESCAPE_ROUTE` from the page into the trace (geometry.mjs keeps the 45th St layout only for older traces and
sessions); an injected launch is placed round the build's cop (`placeLaunch`). To see a check fail live, patch the build the
same way in the page (a `page.route` text replacement), never in the repo.

## 4. Evidence

Per run, `<dir>/<scenario>/`: `report.html` (open this), `verdict.json`, `trace.json` (every frame since P),
`run.json` (scenario, injected state, build sha, page errors, shots), `video.webm` (kept: never delete recordings),
`shots/` (a JPEG at every beat change and every contact, chase or seat camera as the show cuts it), `failures/` (a
still from the video at each failure moment), `session.jsonl` (the game's own flight recorder for the run).
Across runs: `<dir>/summary.html` (scenarios × beats, worst case per beat, counts, the spread of the key numbers).

Before you trust a verdict, **look at the screenshots** (Read the JPEGs) and the opening map on the report page. A
run that passes too easily: suspect the observation before the system (is the trace's window the beat you think, did
the map classify the plaza?). To look at a report page yourself: `node tools/swim-eval/lib/snap-page.mjs <page.html>
<out.png>` and Read the PNG (shrink with `sips -Z 1800`).

Warm-up: `warm-*` scenarios press I at the Squeeze start (the AI roams through the player's keys), I again after the
warm-up to take the car back, then P; run.json logs the metres driven. (W with the wheel swung each second, the old
show-clock.cjs warm-up, pins the car against the kerb in its first 40 m: `warmupMode: 'swing'` keeps it for
comparison only.)

A run that reaches its end can sit minutes before "done" on a loaded machine: Playwright's video encoder lags and
closing the page waits for it. Slow, not stuck; don't kill it there.

## 5. Cleanup

Kill only what you started (note the PIDs; never `pkill` by pattern: other sessions run Chrome too). `suite.mjs` and
`run.mjs` exit on SIGTERM (`kill <pid>`) and take their browsers with them; check `pgrep -P <pid>` is empty after.
(Before that fix, a killed suite's workers carried on with new browsers.) A server you started by hand (`node
tools/swim-eval/lib/server.mjs <port> <repo> <assets>`) you stop by its PID. Evidence stays: never delete videos,
traces or shots; a rerun into a folder renames an earlier video to `video-earlier-<ms>.webm`. Empty `video-raw/`
folders may stay.

## Reading a verdict

Each beat lists its criteria as "measured (want)"; ✗ marks the one that missed. Thresholds are in
`lib/check.mjs` `THRESHOLDS` with what each reads as: changing one is changing the spec, so log why. Never weaken a
check to make it pass. Positions come from `lib/map.mjs`: pavement = the game's curb islands (`BLOCKS`), plaza =
`city-grid.js`'s plaza pieces (ported; checked against the page's own plaza footprints), building = the colliders the
car is pushed out of, lanes = the road graph's edges, street furniture (the steam stack) counted on its own.

## Features (one file per beat)

| beat | file |
|---|---|
| 1. Start on the road, in a 7th Ave lane heading toward the cop | `features/01-start-on-road.md` |
| 2. Slow roll under 12 mph for ~4 s, no burnout | `features/02-slow-roll.md` |
| 3. Floor it | `features/03-floor-it.md` |
| 4. Donuts round the cop | `features/04-donuts.md` |
| 5. Drift out onto 7th Ave, 50 mph within ~3 s | `features/05-drift-out.md` |
| 6. Swim 7th Ave above 70 mph, splits and close calls, no contacts | `features/06-swim.md` |
| 7. Corners drifted, on the road | `features/07-corners.md` |
| 8. Endless roam: stopped < 10 %, never stuck | `features/08-roam.md` |
| 9. Any driving key takes over; I hands back | `features/09-takeover.md` |

Not covered by the harness: sound, camera framing (the screenshots show it, nothing scores it: the bird is checked
as drawn, look at the `bird-up` shot for whether it is in frame), pedestrians. A session (`check.mjs <session.jsonl>`)
is read with the 45th St layout it was recorded on; a session from a build that moved the cop needs its spots.
