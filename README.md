# Slop New York

A New York City simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Explore Manhattan on foot, by car, by bicycle, or by helicopter.

[Try it live](https://mrdoob.github.io/slop-newyork/)

## Swimming in Slop New York

A fan remix, made for fun and not for sale: a tuned BMW M3 Competition that drifts and "swims" (New York for weaving
through traffic at speed) round Manhattan. It is made after two clips:

- [Squeeze Benz in Times Square](https://www.youtube.com/watch?v=Xm3PyqM7ReE): the swim through traffic.
- [BMW donuts round the NYPD](https://www.youtube.com/shorts/Xdhr6e6V2GA): the drift round the cruiser, the bird out
  of the driver's window and Careless Whisper from the chorus.

What's in it:

- **The opening** (Teleport → AI show, or **P**): a burnout in Times Square, then from the driver's seat a drift
  circle round the NYPD cruiser as Careless Whisper comes in on the chorus (where the short has it) and the bird out of
  the window, the escape down 7th Ave with the cop behind, swimming through the traffic on 42nd and 8th, and a
  3-2-1 count before the car is yours. The traffic is seeded, so it plays the same each time. Any driving key takes
  the wheel early.
- **Driving** (Swimming mode, **5**): W gas, S brake/reverse, A/D steer, Space handbrake. W+S at a standstill is a
  burnout. Drifting is the physics': power over or flick it with the handbrake, hold the slide on the gas (more gas,
  a wider and faster drift), and the eight-speed shifts up mid-slide off the limiter. **T** switches to the manual
  gearbox, **Z**/**X** shift down/up. Drifts and close calls (a car passed with under a metre to spare) score, close
  calls in a row chain, and one each side at once is a split between two cars, worth double.
- **G** plays or stops George Michael, **F** flips the bird (out of the window, also from the driver's seat), **K**
  swaps the engine voice, **6–0** pick the camera (**8** is the driver's seat).

The music streams from YouTube's own player; nothing of it is stored here.

### Two versions

The repository is the **minimal** version and stays close to the original's size (about 3.3 MB, 1.45 MB gzipped): the
car is drawn in code, the engine is synthesized and the music streams. The **full** version adds local assets that are
never committed: recordings of a tuned M3 (`tools/fetch-m3-sound.sh`), the decoded GTA V M5 sound mod
(`tools/extract-m5-mod-sound.py`) and the Sketchfab M3 model (`tools/prepare-m3-model.sh`). The game uses whichever
of them it finds and falls back to the minimal version's car and sound for the rest. `tools/encode-sounds.sh` then
shrinks the recordings (FLAC loops, Opus one-shots: about 1 MB of WAV to 0.6 MB). `tools/build-variants.sh` builds
both into `dist/minimal` and `dist/full`.

For the car, download [the model](https://skfb.ly/pNwqZ) from Sketchfab as glTF and run
`zsh tools/prepare-m3-model.sh ~/Downloads/bmw_m3_competition__hassan_visuals_3d.zip`: it bakes, simplifies and
compresses it into `assets/models/m3.glb` (about 2.6 MB, gitignored).

### What this fork adds, and merging upstream

The fork keeps its logic in its own files so [upstream](https://github.com/mrdoob/slop-newyork) can be pulled in
cleanly. Ours: `js/swim-*.js`, `js/drift-*.js`, `js/m5-*.js`, `js/m3-model.js`, `js/session-recorder.js`,
`css/swim.css`, the `tests/` named after them and `tools/` (sound, model and build scripts). The swimming car is
`swim-car.js`, its traffic staging `swim-traffic.js`, its keys and page wiring `swim-controls.js`, its camera
`swim-camera.js`, its engine sound `swim-engine-sounds.js`, its body spec `m5-body.js`.

Upstream files carry only hooks: an import, a registration line, a one-line dispatch, the fifth mode in a list. Most
are marked `Swimming in Slop` (`grep -n "Swimming in Slop" js/*.js` lists them); the rest name the `'swim'` mode.
`traffic.js` imports its `Math` from `swim-traffic.js` (the real one, with a `random()` the show can seed), so its
`Math.random()` lines stay upstream's. `index.html` has the mode's markup and the fork's module preloads in one block.

To merge: `git fetch upstream && git merge upstream/main`, resolve any conflict at a hook by keeping upstream's line
and re-adding the hook, then `node --test tests/*.test.cjs tests/*.test.mjs` (boot.test.cjs checks that every module
is preloaded).

Note on traffic: the AI show stages its streets. Before each street of its run it holds the corner clear and lays
the street out as rows of two cars side by side, a split apart, at Midtown's crawl (`swim-traffic.js`). A player
driving freely gets the city's ordinary traffic, not that.

## Make it your own

Fork it, remix it, improve it, break it. Make games, animations, films, experiments, or something completely different. Use it as a starting point and take it wherever you want. Have fun!

Explore other cities and community remixes in [Slop Cities](https://github.com/zz85/slop-cities).

## License and data

The project code is available under the [MIT License](LICENSE).

Geographic data: NYC Open Data (including [building footprints and heights](https://data.cityofnewyork.us/City-Government/BUILDING/5zhs-2jue) and [tree locations](https://data.cityofnewyork.us/Environment/Forestry-Tree-Points/hn5i-inap)), [MTA subway entrances](https://data.ny.gov/Transportation/MTA-Subway-Entrances-and-Exits-2024/i9wp-a4ja), and © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Third-party data and dependencies retain their respective licenses.

BMW M3 Competition model by [Hassan Visuals 3D](https://sketchfab.com/HassanVisuals3D) ([Sketchfab](https://skfb.ly/pNwqZ), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)), baked, simplified and compressed for the full build.
