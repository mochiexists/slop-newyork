# Beat 4: donuts round the cop (with the bird)

**What it is.** The donut driver's `drift` phase: it picks keys a few times a second by playing each choice ahead on
the car's own physics, to hold a sideways circle of `DRIFT_RADIUS` (11 m on 89419cc) round the cop, `DONUT_LAPS` (2)
laps, then powers out. The first lap is seen from the chase camera, the second from the seat with the bird out.

**How to reach it.** Fresh scenarios (from the launch), or straight in: `launch-musa` injects musa's over-rotated
launch (session 2026-11-01T15-34-47-424, frame 10800) at P, with fresh hands and a donut driver in `drift` that has
already swept 0.25 laps; the `launch-*` family varies it (over-rotated, slow, spun past 90°, 5.5 m and 19 m from the
cop). Each must recover.

**How it is driven.** The AI's keys; an injected state is written once at the P frame, never again.

**The end state that proves it** (`beatDonuts`, window: launch → powerOut): laps round the cop ≥ 2 (bearing swept
round the cop, plus what the injection had swept); the Kasa circle fit (donut-score.py's, on frames ≥ 10° sideways)
centred ≤ 2 m from the cop, radius 8-12 m; median drift angle 30-50°; no cop contact (the cruiser's own `collide`
moving the car); no frame with the footprint on pavement, plaza, median, park or a building; no building push.
Shown too: the closest box clearance to the cop, frames over street furniture (the steam stack). On the report: the
opening map's green circle against the cop, the drift-angle chart between its 30° and 50° rules.

**Gotchas.**
- By the game's map no circle centred on COP_SPOT with r 8-12 keeps a 30-50° sideways car fully on the road (best
  91-93 % at r 8-9; r 11 is ~71 %): Broadway's plaza pieces and the corner kerbs cut in. 1 m east of the cop at r 8-8.5
  it is clear of the kerb all round, but crosses the Con Ed steam stack (2 × 2 m, 6 m from the cop; a `streetDetails`
  footprint, not a collider: the car drives through it). The selftest's ideal show uses that circle.
- A run that ends mid-donut leaves beat 5 INCONCLUSIVE, not failed; the show gives up on its own at 30 s
  (`DONUT_TIME_LIMIT`), so beat 5 calls 35 s of donuts with no way out NOT VERIFIED.
- musa's session scores NOT VERIFIED here (0.34 laps, centre 7.4 m off, radius 3.8 m): the first sanity check.
