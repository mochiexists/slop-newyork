// Where the car is, by the game's own map: road (and which lane of the road graph), pavement, plaza, park, a street
// obstacle, or inside a building. Every source is the game's:
//   pavement   city-config.js BLOCKS / blockAt: the raised curb islands (controllers.js isPointOnSidewalk);
//   plaza      city-grid.js plazaPieces(): Broadway's paved plazas (GEO.plazas) cut between the cross streets and
//              either side of the avenue they cross (Times Square's bowtie, Herald Square). They are not BLOCKS, so
//              blockAt says "road" on them; this file repeats city-grid.js's cut (it can't be imported: it builds
//              meshes) and the runner checks the result against the page's own plaza footprints;
//   building   the colliders the car is pushed out of (controllers.js resolveHorizontalCollision), dumped from the
//              page (lib/page.mjs dumpMap): polygon, oriented box or box;
//   obstacle   ground footprints traffic keeps clear of on the street (steam stacks, subway stairs: road-network.js's
//              blockedOnStreet rule), dumped from the page;
//   lane       road-network.js edges (the traffic lanes), dumped from the page.
import { ALL_AVENUES, ALL_STREETS, avenueX, blockAt, nearestRoads, streetZ } from '../../../js/city-config.js';
import { GEO } from '../../../js/nyc-geodata.js';

const CELL = 32;
// The swim car's half extents (swim-car.js SWIM_BOX)
const CAR_HALF_WIDTH = 0.97;
const CAR_HALF_LENGTH = 2.52;
const OBSTACLE_MAX_SIDE = 50; // m: road-network.js blockedOnStreet ignores bigger footprints on the street (park bounds)
const FOOTPRINT_STEP = 0.4; // m between the points sampled round the car's box

// The car-local points of the footprint (x across, z forward): the centre line, then the outline. The first is the
// centre, which classify(x, z) of the car is.
const FOOTPRINT_POINTS = (() => {
  const pts = [];
  const along = (from, to) => {
    const n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / FOOTPRINT_STEP));
    for (let i = 0; i < n; i++) pts.push([from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n]);
  };
  const w = CAR_HALF_WIDTH, l = CAR_HALF_LENGTH;
  along([0, 0], [0, l]);
  along([0, 0], [0, -l]);
  for (const [a, b] of [[[-w, -l], [w, -l]], [[w, -l], [w, l]], [[w, l], [-w, l]], [[-w, l], [-w, -l]]]) along(a, b);
  return pts;
})();

// Midtown, with room round the roam's box (swim-roam.js: 11th to 1st Ave, 57th to 14th St)
function midtownRegion() {
  const margin = 60;
  return {
    minX: avenueX('11') - margin, maxX: avenueX('1') + margin,
    minZ: streetZ(57) - margin, maxZ: streetZ(14) + margin
  };
}

// city-grid.js clipPolygonHalfPlane: Sutherland-Hodgman clip to nx * x + nz * z >= c
function clipPolygonHalfPlane(pts, nx, nz, c) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const da = nx * a.x + nz * a.z - c;
    const db = nx * b.x + nz * b.z - c;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  return a * 0.5;
}

// city-grid.js plazaPieces (section 6), line for line
function plazaPieces(def, n0, n1, aveId) {
  const streetHalf = (n) => {
    const st = ALL_STREETS.find((t) => t.number === n);
    return st ? st.width * 0.5 : 5;
  };
  const [ax, az] = def.a;
  const [bx, bz] = def.b;
  const hw = def.w * 0.5;
  const xAt = (z) => ax + ((z - az) / (bz - az)) * (bx - ax);
  const ave = ALL_AVENUES.find((a) => a.id === aveId);
  const aveHalf = ave.width * 0.5 + 0.4;
  const pieces = [];
  for (let n = n0; n > n1; n--) {
    const zN = streetZ(n) + streetHalf(n) + 0.6;
    const zS = streetZ(n - 1) - streetHalf(n - 1) - 0.6;
    if (zS - zN < 4) continue;
    const strip = [{ x: xAt(zN) - hw, z: zN }, { x: xAt(zN) + hw, z: zN }, { x: xAt(zS) + hw, z: zS }, { x: xAt(zS) - hw, z: zS }];
    const west = clipPolygonHalfPlane(strip, -1, 0, -(ave.x - aveHalf));
    const east = clipPolygonHalfPlane(strip, 1, 0, ave.x + aveHalf);
    for (const piece of [west, east]) {
      if (piece.length >= 3 && Math.abs(signedArea(piece)) > 25) pieces.push({ name: def.name, pts: piece, zN, zS, west: piece === west });
    }
  }
  return pieces;
}

function allPlazaPieces() {
  const ts = GEO.plazas.find((d) => d.name === 'Times Square');
  const hs = GEO.plazas.find((d) => d.name === 'Herald Square');
  return [...(ts ? plazaPieces(ts, 47, 42, '7') : []), ...(hs ? plazaPieces(hs, 35, 33, '6') : [])];
}

function pointInRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    const [ax, az] = Array.isArray(a) ? a : [a.x, a.z];
    const [bx, bz] = Array.isArray(b) ? b : [b.x, b.z];
    if ((az > z) !== (bz > z) && x < ax + ((bx - ax) * (z - az)) / (bz - az)) inside = !inside;
  }
  return inside;
}

function insideCollider(c, x, z) {
  if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) return false;
  if (c.polygon) {
    let inside = pointInRing(c.polygon.outer, x, z);
    for (const hole of c.polygon.holes) if (pointInRing(hole, x, z)) inside = !inside;
    return inside;
  }
  if (c.obb) {
    const o = c.obb;
    const dx = x - o.cx, dz = z - o.cz;
    return Math.abs(dx * o.cs - dz * o.sn) <= o.hx && Math.abs(dx * o.sn + dz * o.cs) <= o.hz;
  }
  return true;
}

class Grid {
  constructor() {
    this.cells = new Map();
  }

  add(item) {
    for (let ix = Math.floor(item.minX / CELL); ix <= Math.floor(item.maxX / CELL); ix++) {
      for (let iz = Math.floor(item.minZ / CELL); iz <= Math.floor(item.maxZ / CELL); iz++) {
        const key = ix * 100000 + iz;
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(item);
      }
    }
  }

  at(x, z) {
    return this.cells.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) ?? [];
  }
}

// The classifier over a page dump (lib/page.mjs dumpMap)
class SwimMap {
  constructor(dump) {
    this.region = dump.region;
    this.plazas = allPlazaPieces().map((p) => ({
      ...p, minX: Math.min(...p.pts.map((q) => q.x)), maxX: Math.max(...p.pts.map((q) => q.x)),
      minZ: Math.min(...p.pts.map((q) => q.z)), maxZ: Math.max(...p.pts.map((q) => q.z))
    }));
    this.buildings = new Grid();
    for (const c of dump.colliders) this.buildings.add(c);
    this.obstacles = new Grid();
    // Footprints on the street that block it as road-network.js's blockedOnStreet has it: small ones, not the plazas'
    // bounding boxes (the plazas are classified by their outline above)
    const plazaBox = (r) => this.plazas.some((p) => Math.abs(p.minX - r.minX) < 0.6 && Math.abs(p.maxX - r.maxX) < 0.6 && Math.abs(p.minZ - r.minZ) < 0.6 && Math.abs(p.maxZ - r.maxZ) < 0.6);
    this.plazaFootprints = dump.footprints.filter(plazaBox);
    for (const r of dump.footprints) {
      if (r.pedestrianOnly || plazaBox(r)) continue;
      if (r.maxX - r.minX >= OBSTACLE_MAX_SIDE && r.maxZ - r.minZ >= OBSTACLE_MAX_SIDE) continue;
      const block = blockAt((r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2);
      if (block) continue; // (on a curb island already: pavement covers it)
      this.obstacles.add(r);
    }
    this.lanes = new Grid();
    for (const e of dump.edges) {
      const x1 = e.x0 + e.dx * e.span, z1 = e.z0 + e.dz * e.span;
      this.lanes.add({ ...e, minX: Math.min(e.x0, x1) - e.half, maxX: Math.max(e.x0, x1) + e.half, minZ: Math.min(e.z0, z1) - e.half, maxZ: Math.max(e.z0, z1) + e.half });
    }
  }

  // The plaza pieces against the page's own plaza footprints (their bounds): how many of each the other matches
  plazaCheck() {
    return { pieces: this.plazas.length, matchedFootprints: this.plazaFootprints.length };
  }

  // 'building' | 'plaza' | 'pavement' | 'median' | 'park' | 'obstacle' | 'road'
  classify(x, z) {
    for (const c of this.buildings.at(x, z)) if (insideCollider(c, x, z)) return 'building';
    for (const p of this.plazas) {
      if (x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ && pointInRing(p.pts, x, z)) return 'plaza';
    }
    const block = blockAt(x, z);
    if (block) {
      if (block.median) return 'median';
      return block.park > 0.6 ? 'park' : 'pavement';
    }
    for (const r of this.obstacles.at(x, z)) {
      if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return 'obstacle';
    }
    return 'road';
  }

  // The traffic lane under (x, z): the road-network edge whose corridor holds it, its lateral offset and the lane
  // nearest that offset, or null between the edges (an intersection box, or off the graph)
  lane(x, z) {
    let best = null;
    for (const e of this.lanes.at(x, z)) {
      const s = (x - e.x0) * e.dx + (z - e.z0) * e.dz;
      if (s < 0 || s > e.span) continue;
      const lateral = (x - e.x0) * -e.dz + (z - e.z0) * e.dx;
      if (Math.abs(lateral) > e.half) continue;
      const nearestLane = e.lanes.length ? e.lanes.reduce((m, l) => (Math.abs(l - lateral) < Math.abs(m - lateral) ? l : m), e.lanes[0]) : null;
      const offLane = nearestLane === null ? null : Math.abs(nearestLane - lateral);
      if (!best || (offLane ?? 99) < (best.offLane ?? 99)) best = { edge: e.id, dx: e.dx, dz: e.dz, lateral, half: e.half, lane: nearestLane, offLane, axis: e.axis };
    }
    return best;
  }

  // The named street under (x, z) (city-config.js nearestRoads), with how far off its centreline
  street(x, z) {
    const near = nearestRoads(x, z, 25);
    return near.length ? { name: near[0].road.name, dist: near[0].dist, width: near[0].road.w, dir: near[0].road.dir } : null;
  }

  // The car's footprint at (x, z) heading h: what each point of its outline (every FOOTPRINT_STEP m round the box) and
  // its centre line is on. (Nine points, corners and mid-sides, let a kerb corner poke into the box unseen: Codex
  // round 1 found a pose at 8th Ave & 42nd St.)
  footprint(x, z, h) {
    const sin = Math.sin(h), cos = Math.cos(h);
    const out = [];
    for (const [ax, az] of FOOTPRINT_POINTS) {
      // car local x across (to its right as heading turns), z forward: world = rotate by heading (swim-mode.js rearContacts)
      const px = x + cos * ax + sin * az, pz = z - sin * ax + cos * az;
      out.push(this.classify(px, pz));
    }
    return out;
  }
}

export { CAR_HALF_LENGTH, CAR_HALF_WIDTH, SwimMap, allPlazaPieces, midtownRegion, pointInRing };
