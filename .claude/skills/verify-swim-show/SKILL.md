---
name: verify-swim-show
description: Verify the AI show (press P in swim mode) against musa's 8-beat checklist with the eval harness in tools/swim-eval. Use before claiming any change to the show, the donuts, the AI driver, the swim car's physics, traffic staging or the roam "works", to capture a baseline before a change, to score a player session .jsonl, or when musa says the show looks wrong ("no donuts", "starts on the pavement", "it got stuck"). Drives the real game headless on a virtual clock, judges by the worst run, writes report pages with maps, numbers and screenshots.
---

# Verify the swim show

The show is judged by **musa's checklist** (8 beats, `features/`), measured on the game's own map, over many scenarios,
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
# the whole suite (22 runs), then the summary page. At most 2 browsers at once: WebGPU browsers starve each other on
# one Mac (3 at once sat 13 min without loading). Each run's wall clock is in run.json and the summary.
node tools/swim-eval/suite.mjs --out <dir> --port <port> --jobs 2
# score a player session offline (its AI part)
node tools/swim-eval/check.mjs <session.jsonl> --map <dir>/maps/map-<sha>.json --out <dir>
# re-check a run folder without re-running (after a checker change)
node tools/swim-eval/check.mjs <dir>/<scenario>
# every check seen failing (the synthetic ideal show and its 18 breaks)
node tools/swim-eval/selftest.mjs --map tools/swim-eval/test/map-fixture.json
```

Scenarios (`lib/scenarios.mjs`): `fresh-s<traffic seed>-<clock>` (clock `120`, `60`, `30`, `mix` = each frame 1/120 or
1/60 at random, `musa` = the dt column of musa's 2026-11-01 session, cycled), `warm-s1-mix` / `warm-s2-musa` (60 s of
driving before P), `launch-musa` (musa's over-rotated launch injected at P) and its family `launch-overrotated`,
`launch-slow`, `launch-spun`, `launch-close`, `launch-far`, `launch-musa-120`, `launch-musa-mix`. Any
`fresh-s<n>-<clock>[-w<warm-up s>]` is made up on the spot. `--duration <s>` shortens a run while you iterate.

How it drives: a virtual animation clock (`lib/page.mjs clockInit`) hands the game the scenario's frame times and is
paused between the runner's steps, so every key press, the P press and every screenshot lands on an exact frame;
Math.random is seeded at load and again at P; the traffic seed goes through the show's own `traffic.reseed` call.
The same scenario replays bit for bit (checked: two parallel runs, 2403 frames, every field equal). The AI presses
its keys itself; the harness only presses P (and, for a warm-up, W/A/D as a player). An injected start state is
written once at the P frame, before the beat, never during it.

main.js is rewritten as the page fetches it (four one-line hooks: `globalThis.__swim`, `__evalWorld`,
`__evalControllers`, `__clock.loopStarting()`); no game file changes. To see a check fail live, patch the build the
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

## 5. Cleanup

Kill only what you started (note the PIDs; never `pkill` by pattern: other sessions run Chrome too). The runner and
doctor close their own browsers and servers; a server you started by hand (`node tools/swim-eval/lib/server.mjs
<port> <repo> <assets>`) you stop by its PID. Evidence stays: never delete videos, traces or shots. Empty
`video-raw/` folders may stay.

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

Not covered by the harness: "any driving key takes over; I hands back" (no scenario presses a key mid-show), sound,
camera framing (the screenshots show it, nothing scores it), pedestrians.
