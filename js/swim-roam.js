import { ALL_AVENUES, ALL_STREETS, avenueX, blockAt, streetZ } from './city-config.js';

// The AI's endless run through Midtown: once the show's route is driven, it keeps going, choosing a street at every
// corner it comes to. It drives the ladder of Midtown's wide roads: the avenues (one-way, driven the way they run;
// two-way ones on the right-hand half) and the wide two-way cross streets (14th, 23rd, 34th, 42nd, 57th), long straights
// to swim through traffic on and a drifted 90° corner at each end. Every leg is checked against the street data (the
// avenue runs that way there, the street is open the whole way across), and the run stays inside the box those roads
// make. Pure and DOM-free, for tests: it hands the route its next corner, and the autopilot drives it.

const ROAM_AVENUES = ['11', '10', '9', '8', '7', '6', '5', 'madison', 'lex', '3', '2', '1'];
const ROAM_STREETS = [57, 42, 34, 23, 14];
const KEEP_RIGHT = 3.5; // m right of a two-way road's centre line (the swim corridor still spans the whole road)
const AVENUE_MIN_LEG = 250; // m it runs down an avenue at least before turning off it (time to swim, then brake)
const STREET_MIN_LEG = 200; // m along a cross street (an avenue block is ~275 m)
const FIRST_MIN_LEG = 60; // m to its first corner when it takes the car over wherever it is (already up to speed)
const PREFERRED_AVENUE_LEG = 900; // m of avenue it likes best between corners
const PREFERRED_STREET_LEG = 600;
const LEG_SPREAD = 500; // m either side of that over which a leg's appeal falls away by one point
const VARIETY = 1.2; // points of chance in each choice, so the run differs corner to corner
const REPEAT_COST = 1.5; // points against a road and direction driven in the last few legs
const MEMORY = 4; // legs it remembers
const RUN_GAP = 60; // m: two runs of a street with a shorter break between them are one street (a crossing, a median)
const END_TOLERANCE = 20; // m a run may stop short of an avenue's centre line and still reach it
const ON_ROAD = 30; // m from a road's line that counts as being on it (starting from wherever the car is)
const BLOCK_STEP = 8; // m between the points a leg's line is checked for curb blocks at
const BLOCK_END = 12; // m at each end of a leg left unchecked (the corner itself, where the car turns)

const AVENUE_BY_ID = new Map(ALL_AVENUES.map((a) => [a.id, a]));
const STREET_BY_NUMBER = new Map(ALL_STREETS.filter((s) => s.number !== null).map((s) => [s.number, s]));
// (the lines it drives keep right of a two-way road's centre, so the box reaches that far past the outer roads)
const BOX_MARGIN = KEEP_RIGHT + 1;
const BOX = {
  minX: avenueX(ROAM_AVENUES[0]) - BOX_MARGIN,
  maxX: avenueX(ROAM_AVENUES[ROAM_AVENUES.length - 1]) + BOX_MARGIN,
  minZ: streetZ(ROAM_STREETS[0]) - BOX_MARGIN,
  maxZ: streetZ(ROAM_STREETS[ROAM_STREETS.length - 1]) + BOX_MARGIN
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The avenue's run covering z0..z1 (+z is south), or null: { dir: +1 south, -1 north, 0 both }
function avenueRun(id, z0, z1) {
  const avenue = AVENUE_BY_ID.get(id);
  if (!avenue?.segs) return null;
  const lo = Math.min(z0, z1), hi = Math.max(z0, z1);
  return avenue.segs.find((s) => s.z0 <= lo + END_TOLERANCE && s.z1 >= hi - END_TOLERANCE) ?? null;
}

// Whether a straight line crosses no curb block (the street data has the odd break where a block stands across a street:
// 57th St between 10th and 11th Ave). Remembered per line.
const clearLines = new Map();
function lineClear(x0, z0, x1, z1) {
  const key = `${Math.round(x0)},${Math.round(z0)},${Math.round(x1)},${Math.round(z1)}`;
  if (clearLines.has(key)) return clearLines.get(key);
  const length = Math.hypot(x1 - x0, z1 - z0);
  let clear = true;
  for (let d = BLOCK_END; d < length - BLOCK_END && clear; d += BLOCK_STEP) {
    const t = d / length;
    if (blockAt(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) clear = false;
  }
  clearLines.set(key, clear);
  return clear;
}

// Whether an avenue may be driven from z0 to z1 (relaxed: the car is already on it, whichever way it runs)
function avenueOpen(id, z0, z1, relaxed = false) {
  const run = avenueRun(id, z0, z1);
  if (!run || !lineClear(avenueX(id), z0, avenueX(id), z1)) return false;
  return relaxed || run.dir === 0 || run.dir === Math.sign(z1 - z0);
}

// A street's runs with the short breaks closed up: [[x0, x1, dir]]
const mergedRuns = new Map();
function streetRuns(number) {
  if (mergedRuns.has(number)) return mergedRuns.get(number);
  const street = STREET_BY_NUMBER.get(number);
  const runs = [];
  for (const [x0, x1, dir] of [...(street?.runs ?? [])].sort((a, b) => a[0] - b[0])) {
    const last = runs[runs.length - 1];
    if (last && x0 - last[1] < RUN_GAP && last[2] === dir) last[1] = Math.max(last[1], x1);
    else runs.push([x0, x1, dir]);
  }
  mergedRuns.set(number, runs);
  return runs;
}

// The street's run covering x0..x1 (+x is east), or null: { dir: +1 east, -1 west, 0 both }
function streetRun(number, x0, x1) {
  const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
  const run = streetRuns(number).find(([a, b]) => a <= lo + END_TOLERANCE && b >= hi - END_TOLERANCE);
  return run ? { dir: run[2] } : null;
}

function streetOpen(number, x0, x1, relaxed = false) {
  const run = streetRun(number, x0, x1);
  if (!run || !lineClear(x0, streetZ(number), x1, streetZ(number))) return false;
  return relaxed || run.dir === 0 || run.dir === Math.sign(x1 - x0);
}

// The line the car drives along a road: the middle of a one-way road, the right-hand half of a two-way one.
// Avenues run along z (sign +1 driving south), streets along x (sign +1 driving east).
function avenueLineX(id, sign, z) {
  const run = avenueRun(id, z, z);
  // driving south, the right-hand side is west (-x)
  return avenueX(id) - (run?.dir === 0 ? sign * KEEP_RIGHT : 0);
}

function streetLineZ(number, sign, x) {
  const run = streetRun(number, x, x);
  // driving east, the right-hand side is south (+z)
  return streetZ(number) + (run?.dir === 0 ? sign * KEEP_RIGHT : 0);
}

const inBox = (x, z) => x >= BOX.minX && x <= BOX.maxX && z >= BOX.minZ && z <= BOX.maxZ;

class RoamRoute {
  constructor(seed = 1) {
    this.random = mulberry32(seed);
    this.road = null; // { kind: 'avenue' | 'street', id, sign }: the road the route's last leg runs along
    this.at = null; // { x, z }: the end of the route so far
    this.recent = [];
    this.relaxed = false; // the first leg may run against a one-way road (the car was already on it)
  }

  // Carry on from the end of a route, which ends at a corner (the show's run ends where 57th St meets 11th Ave): its
  // last leg names the road it came along, and it turns there onto the cross road, whichever way that runs on
  continueFrom(points) {
    const a = points[points.length - 2], b = points[points.length - 1];
    const alongZ = Math.abs(b.z - a.z) > Math.abs(b.x - a.x);
    this.at = { x: b.x, z: b.z };
    this.road = alongZ
      ? { kind: 'avenue', id: nearestAvenue(b.x), sign: Math.sign(b.z - a.z) || 1 }
      : { kind: 'street', id: nearestStreet(b.z), sign: Math.sign(b.x - a.x) || 1 };
    this.relaxed = false;
    this.turnHere();
    return this;
  }

  // At a corner: onto the cross road there, a way it may be driven and that leads on to another corner
  turnHere() {
    const { x, z } = this.at;
    const options = [];
    if (this.road.kind === 'street') {
      const avenue = nearestAvenue(x);
      for (const way of [1, -1]) {
        const onward = ROAM_STREETS.some((n) => (streetZ(n) - z) * way > AVENUE_MIN_LEG && avenueOpen(avenue, z, streetZ(n)));
        if (onward) options.push({ kind: 'avenue', id: avenue, sign: way });
      }
    } else {
      const street = nearestStreet(z);
      for (const way of [1, -1]) {
        const onward = ROAM_AVENUES.some((other) => (avenueX(other) - x) * way > STREET_MIN_LEG && streetOpen(street, x, avenueX(other)));
        if (onward) options.push({ kind: 'street', id: street, sign: way });
      }
    }
    if (options.length) this.road = options[Math.floor(this.random() * options.length)];
  }

  // Start from wherever the car is, heading its way along the road it is on (or the nearest one that way)
  startFrom(x, z, heading) {
    const fx = Math.sin(heading), fz = Math.cos(heading);
    this.at = { x, z };
    if (Math.abs(fz) >= Math.abs(fx)) this.road = { kind: 'avenue', id: nearestAvenue(x), sign: Math.sign(fz) || 1 };
    else this.road = { kind: 'street', id: nearestStreet(z), sign: Math.sign(fx) || 1 };
    this.relaxed = true;
    return this;
  }

  // The next corner: where to turn off the road it is on, and onto which road which way. Returns { x, z }, or null if
  // there is no way on (off the grid it knows).
  next() {
    const all = this.turns(this.road, this.at, this.relaxed);
    if (!all.length) return null;
    // (a corner past which there is no way on is a dead end: 42nd St east of 2nd Ave leads only to 1st Ave, which
    // runs north into a blocked stretch)
    const onward = all.filter((option) => this.turns(option.road, option, false).length > 0);
    const options = onward.length ? onward : all;
    let best = null;
    for (const option of options) {
      const score = option.score + this.random() * VARIETY;
      if (!best || score > best.score) best = { ...option, score };
    }
    this.recent.push(`${this.road.kind}:${this.road.id}:${this.road.sign}`);
    if (this.recent.length > MEMORY) this.recent.shift();
    this.road = best.road;
    this.at = { x: best.x, z: best.z };
    this.relaxed = false;
    return { x: best.x, z: best.z };
  }

  // Appeal of a leg of `length` toward a preferred length, less if that road and way were driven lately
  appeal(length, preferred, road) {
    const repeat = this.recent.includes(`${road.kind}:${road.id}:${road.sign}`) ? REPEAT_COST : 0;
    return -Math.abs(length - preferred) / LEG_SPREAD - repeat;
  }

  // The corners it could turn at next, driving `road` from `from`
  turns(road, from, relaxed) {
    return road.kind === 'avenue' ? this.turnsOffAvenue(road, from, relaxed) : this.turnsOffStreet(road, from, relaxed);
  }

  // Driving an avenue: turn onto a cross street ahead, either way that street runs and leads on to another avenue
  turnsOffAvenue({ id, sign }, from, relaxed) {
    const options = [];
    const streets = ROAM_STREETS.filter((n) => (streetZ(n) - from.z) * sign > (relaxed ? FIRST_MIN_LEG : AVENUE_MIN_LEG));
    for (const number of streets) {
      const z = streetZ(number);
      if (!avenueOpen(id, from.z, z, relaxed)) continue;
      const x = avenueLineX(id, sign, z);
      for (const way of [1, -1]) {
        const road = { kind: 'street', id: number, sign: way };
        // ...as long as an avenue further along that way can be reached on it
        const onward = ROAM_AVENUES.some((other) => (avenueX(other) - avenueX(id)) * way > STREET_MIN_LEG
          && streetOpen(number, avenueX(id), avenueX(other)));
        if (!onward) continue;
        const length = Math.abs(z - from.z);
        options.push({ road, x, z: streetLineZ(number, way, x), score: this.appeal(length, PREFERRED_AVENUE_LEG, road) });
      }
    }
    return options;
  }

  // Driving a cross street: turn onto an avenue ahead, the way it runs, if a cross street further along it can be
  // reached that way (so the box is never left)
  turnsOffStreet({ id, sign }, from, relaxed) {
    const options = [];
    const avenues = ROAM_AVENUES.filter((a) => (avenueX(a) - from.x) * sign > (relaxed ? FIRST_MIN_LEG : STREET_MIN_LEG));
    for (const avenue of avenues) {
      const ax = avenueX(avenue);
      if (!streetOpen(id, from.x, ax, relaxed)) continue;
      for (const way of [1, -1]) {
        const road = { kind: 'avenue', id: avenue, sign: way };
        const z0 = streetZ(id);
        const onward = ROAM_STREETS.some((n) => (streetZ(n) - z0) * way > AVENUE_MIN_LEG && avenueOpen(avenue, z0, streetZ(n)));
        if (!onward) continue;
        const x = avenueLineX(avenue, way, z0);
        const z = STREET_BY_NUMBER.has(id) ? streetLineZ(id, sign, ax) : from.z;
        const length = Math.abs(ax - from.x);
        options.push({ road, x, z, score: this.appeal(length, PREFERRED_STREET_LEG, road) });
      }
    }
    return options;
  }
}

// The roam avenue nearest an x (or, off the box, any avenue), and the street nearest a z
function nearestAvenue(x) {
  let best = null;
  for (const id of ROAM_AVENUES) if (!best || Math.abs(avenueX(id) - x) < Math.abs(avenueX(best) - x)) best = id;
  if (Math.abs(avenueX(best) - x) < ON_ROAD) return best;
  for (const avenue of ALL_AVENUES) {
    if (avenue.isHighway) continue;
    if (Math.abs(avenue.x - x) < Math.abs(avenueX(best) - x)) best = avenue.id;
  }
  return best;
}

function nearestStreet(z) {
  let best = null;
  for (const street of ALL_STREETS) {
    if (street.number === null) continue;
    if (!best || Math.abs(street.z - z) < Math.abs(best.z - z)) best = street;
  }
  return best.number;
}

export { BOX, ROAM_AVENUES, ROAM_STREETS, RoamRoute, avenueOpen, inBox, streetOpen };
