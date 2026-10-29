# Slop New York

A New York City simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Explore Manhattan on foot, by car, by bicycle, or by helicopter.

[Try it live](https://mrdoob.github.io/slop-newyork/)

## Swimming in Slop New York

A fan remix, made for fun and not for sale: a tuned BMW M3 Competition that drifts and "swims" (New York for weaving
through traffic at speed) round Manhattan, after the Squeeze Benz clips from Times Square.

- **The opening** (Teleport → AI show, or **P**): a burnout in Times Square, a drift circle round the NYPD cruiser as
  Careless Whisper comes in, the escape down 7th Ave with the cop behind, swimming through the traffic on 42nd and
  8th, then the car is yours. The traffic is seeded, so it plays the same each time. Any driving key takes the wheel.
- **Driving** (Swimming mode, **5**): W gas, S brake/reverse, A/D steer, Space handbrake. W+S at a standstill is a
  burnout; gas and full lock in a slide is a drift circle (Space tightens it). Drifts and close calls (a car passed with
  under a metre to spare) score, and close calls in a row chain.
- **G** plays or stops George Michael, **F** flips the bird, **K** swaps the engine voice, **6–0** pick the camera
  (**8** is the driver's seat).

The music streams from YouTube's own player; nothing of it is stored here.

### Two versions

The repository is the **minimal** version and stays close to the original's size (about 3.3 MB, 1.45 MB gzipped): the
car is drawn in code, the engine is synthesized and the music streams. The **full** version adds local assets that are
never committed: recordings of a tuned M3 (`tools/fetch-m3-sound.sh`), the decoded GTA V M5 sound mod
(`tools/extract-m5-mod-sound.py`) and the Sketchfab M3 model (`tools/prepare-m3-model.sh`). The game uses whichever
of them it finds and falls back to the minimal version's car and sound for the rest. `tools/build-variants.sh` builds
both into `dist/minimal` and `dist/full`.

## Make it your own

Fork it, remix it, improve it, break it. Make games, animations, films, experiments, or something completely different. Use it as a starting point and take it wherever you want. Have fun!

Explore other cities and community remixes in [Slop Cities](https://github.com/zz85/slop-cities).

## License and data

The project code is available under the [MIT License](LICENSE).

Geographic data: NYC Open Data (including [building footprints and heights](https://data.cityofnewyork.us/City-Government/BUILDING/5zhs-2jue) and [tree locations](https://data.cityofnewyork.us/Environment/Forestry-Tree-Points/hn5i-inap)), [MTA subway entrances](https://data.ny.gov/Transportation/MTA-Subway-Entrances-and-Exits-2024/i9wp-a4ja), and © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Third-party data and dependencies retain their respective licenses.
