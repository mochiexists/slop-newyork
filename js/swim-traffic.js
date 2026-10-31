import { SWIM_BOX } from './swim-car.js';

// The AI show's hold on the city's traffic (traffic.js): a corner it keeps clear, a seeded layout that repeats, and the
// streets of its run staged as rows of two cars side by side to split. traffic.js keeps only the hooks: it imports
// trafficMath as its `Math`, hands createShowTraffic() the internals the show needs, and asks the result about the
// clear zone (zoneGap, keepsClear) and a car's staging (unstage) where it drives, spawns and places cars. A player
// driving freely gets none of this: the staging is the show's alone.

// Math, as traffic.js sees it: every random choice traffic makes (where cars appear, their turns, lane changes) comes
// from trafficMath.random, so reseed() can make a scene repeat. Everything else is the real Math. (One source for the
// module: the page makes a single traffic system; a second one would share the seeded sequence.)
const trafficMath = Object.create(Math);
trafficMath.random = Math.random;

// A small seeded generator (mulberry32): the same seed gives the same sequence
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The AI show's traffic down one leg of its route (a → b, swim-show.js): rows of two cars side by side in neighbouring
// lanes every `spacing` metres or so, each keeping to its lane's outer edge, so the gap between them is a split (under
// a metre of air either side of the swim car). Lanes in other directions, and `startGap`/`endGap` metres at the leg's
// ends (the corners the show holds clear), are left alone. Returns the placements, { edge, lane, s, bias, row }, from
// `random` () → [0, 1), and the stretch of each edge they take over, from the leg's start to the last row:
// { edge, from, to }.
const SHOW_ROWS = {
  spacing: 50, // m between rows, give or take 30%, on a road `wideLanes` wide (further apart on a narrower one, where
  wideLanes: 4, // a row fills more of it, so the swim car can straighten up between them). Far enough apart for the
  // swim car to line up on the next split at 80 mph; at 22 m it met a row every half second and crawled at 45 mph
  bias: 0.8, // m toward its lane's outer edge each car keeps: 5.2 m centre to centre, 0.7 m of air either side
  pace: 6, // m/s the staged cars drive at (Midtown's crawl): the swim car comes up on them fast, and they are still
  // on the stretch when it gets there
  startGap: 30,
  endGap: 35,
  maxLength: 320, // m of a leg laid out at most (traffic further than this from the car is retired anyway)
  end: 3 // m kept clear of an edge's ends (the crosswalks)
};
const PAIR_LANES = 4; // m between neighbouring lanes' centres at most for a row (lanes are 3.6 m apart)
const ALONG_LEG = 0.98; // an edge runs down the leg if its direction is this close to the leg's (cosine)
const ON_LEG = 12; // m from the leg's line at most for the middle of an edge's lanes
const SPAWN_CLEARANCE = 15; // m beyond the clear zone's edge where nothing spawns
const CLEARED_TO = 40; // m beyond the clear zone's edge a car inside it is moved to, at least

function showTrafficLayout(edges, a, b, options, random) {
  const o = { ...SHOW_ROWS, ...options };
  const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length;
  const last = Math.min(length - o.endGap, o.startGap + o.maxLength);
  const placements = [];
  const stretches = [];
  let row = 0;
  for (const e of edges) {
    const dot = e.dx * ux + e.dz * uz;
    if (dot < ALONG_LEG || e.lanes.length < 2) continue;
    const middle = (e.lanes[0] + e.lanes[e.lanes.length - 1]) / 2;
    const cx = e.sx + e.dx * e.len / 2 + e.rx * middle, cz = e.sz + e.dz * e.len / 2 + e.rz * middle;
    if (Math.abs((cx - a.x) * uz - (cz - a.z) * ux) > ON_LEG) continue;
    const along0 = (e.sx - a.x) * ux + (e.sz - a.z) * uz;
    const from = Math.max(o.end, (o.startGap - along0) / dot);
    const to = Math.min(e.len - o.end, (last - along0) / dot);
    if (to < 0 || -along0 / dot > e.len) continue;
    stretches.push({ edge: e, from: -along0 / dot, to });
    const pairs = [];
    for (let k = 0; k + 1 < e.lanes.length; k++) if (e.lanes[k + 1] - e.lanes[k] < PAIR_LANES) pairs.push(k);
    if (!pairs.length) continue;
    const spacing = o.spacing * Math.max(1, o.wideLanes / e.lanes.length);
    for (let s = from + random() * spacing * 0.5; s <= to; s += spacing * (0.7 + random() * 0.6)) {
      const k = pairs[Math.floor(random() * pairs.length)];
      // (lanes count rightward: the left car keeps left, the right one right)
      placements.push({ edge: e, lane: k, s, bias: -o.bias, row }, { edge: e, lane: k + 1, s, bias: o.bias, row });
      row++;
    }
  }
  return { placements, stretches };
}

// The show's side of one traffic system. `traffic` is what traffic.js hands over from inside createTrafficSystem:
//   vehicles, cars, edges, player                    its pools, road graph and player snapshot
//   place(v, e, lane, s), locate(v)                  put a vehicle on a lane, and work out where that puts it
//   spawnNear(v, rMin, protectView)                  spawnVehicle out to the near radius; false if no lane was free
//   buildOccupancy()                                 rebuild the lanes' occupancy lists
//   inView(v)                                        whether v is in the protected near view
//   focus()                                          [x, z] traffic is laid out around
//   jumpTo(x, z)                                     move that focus at once, as a teleport does
//   lookahead                                        m a driver looks ahead (LOOKAHEAD)
// Returns `api`, the calls the traffic system adds for the show (swim-show.js), and the hooks traffic.js calls.
function createShowTraffic(traffic) {
  const { vehicles, cars, edges, player } = traffic;
  // A stunt area kept clear for the swimming show (swim-mode.js): { x, z, r } or null. Traffic stops short of it and
  // nothing spawns inside it.
  let clearZone = null;

  // Distance to the edge of the clear zone if v's path runs into it
  function zoneGap(v) {
    if (!clearZone) return Infinity;
    const dx = clearZone.x - v.x, dz = clearZone.z - v.z;
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    const along = dx * fx + dz * fz;
    const across = Math.abs(dz * fx - dx * fz);
    if (along < 0 || across > clearZone.r || along > traffic.lookahead + clearZone.r) return Infinity;
    return along - Math.sqrt(clearZone.r ** 2 - across ** 2) - v.half;
  }

  // Whether a vehicle may not spawn at (x, z)
  function keepsClear(x, z) {
    return Boolean(clearZone) && Math.hypot(x - clearZone.x, z - clearZone.z) < clearZone.r + SPAWN_CLEARANCE;
  }

  // A vehicle (re)placed on a lane is ordinary traffic again: its own pace (a show pair may have set it to its
  // partner's, see stageRoute), its lane's centre, no longer staged
  function unstage(v) {
    v.v0 = v.ownV0 ??= v.v0;
    v.bias = 0;
    v.staged = false;
  }

  // Clear (or with null release) a stunt area: vehicles inside it now are moved elsewhere, the rest hold short of it
  function setClearZone(zone) {
    clearZone = zone ? { x: zone.x, z: zone.z, r: zone.r } : null;
    if (!clearZone) return;
    for (const v of vehicles) {
      if (v.edge && Math.hypot(v.x - clearZone.x, v.z - clearZone.z) < clearZone.r + v.half) {
        // No free lane right now: park it off the road until the regular respawn finds it a place
        if (!traffic.spawnNear(v, clearZone.r + CLEARED_TO, true)) v.edge = null;
      }
    }
  }

  // Lay the same traffic out round a spot every time (the AI show's opening), and keep every later choice (turns,
  // lane timers) on the same sequence. Vehicles are re-placed in pool order on the edges near the spot.
  function reseed(seed, x, z) {
    const random = trafficMath.random = seededRandom(seed);
    traffic.jumpTo(x, z);
    for (const v of vehicles) {
      v.edge = null;
      // The per-driver randomness drawn when the pool was made, drawn again from the seed
      v.laneTimer = random() * 0.5;
      v.blinkPhase = random() * 0.8;
      v.reaction = 0.6 + random() * 0.4;
    }
    traffic.buildOccupancy();
    const playerWasActive = player.active;
    player.active = false;
    for (const v of vehicles) traffic.spawnNear(v, 0, false);
    player.active = playerWasActive;
  }

  // Lay out the AI show's traffic down a leg of its route (showTrafficLayout), taking over whatever is on that stretch
  // now: the cars there make way, then the rows are filled from them and from the cars furthest away and out of view
  // (never buses). They all drive at the same crawl, so a row stays side by side. Returns the cars placed.
  function stageRoute(a, b, options = {}) {
    const rows = { ...SHOW_ROWS, ...options };
    const { placements, stretches } = showTrafficLayout(edges, a, b, rows, trafficMath.random);
    if (!placements.length) return 0;
    const spare = [];
    for (const v of cars) {
      const r = v.edge && !v.conn ? stretches.find((stretch) => stretch.edge === v.edge) : null;
      if (r && v.s > r.from - v.half && v.s < r.to + 15) {
        v.edge = null;
        spare.push(v);
      }
    }
    const [focusX, focusZ] = traffic.focus();
    const away = (v) => (v.edge ? Math.hypot(v.x - focusX, v.z - focusZ) : Infinity);
    const others = cars.filter((v) => !spare.includes(v) && (!v.edge || !traffic.inView(v)));
    others.sort((p, q) => away(q) - away(p));
    spare.push(...others);
    let placed = 0;
    for (let i = 0; i < placements.length && placed < spare.length; i++) {
      const p = placements[i];
      const v = spare[placed++];
      traffic.place(v, p.edge, p.lane, p.s);
      v.bias = p.bias;
      v.dl = p.bias;
      v.v0 = Math.min(v.v0, rows.pace);
      v.speed = v.v0;
      v.staged = true;
      traffic.locate(v);
      v.prevX = v.x;
      v.prevZ = v.z;
    }
    return placed;
  }

  // The show is over: its staged rows drive on as ordinary traffic, back at their own pace and free to change lanes
  function releaseStaged() {
    for (const v of cars) {
      if (!v.staged) continue;
      v.staged = false;
      v.bias = 0;
      v.v0 = v.ownV0 ?? v.v0;
    }
  }

  return { api: { setClearZone, reseed, stageRoute, releaseStaged }, zoneGap, keepsClear, unstage };
}

export { SHOW_ROWS, SWIM_BOX, createShowTraffic, seededRandom, showTrafficLayout, trafficMath };
