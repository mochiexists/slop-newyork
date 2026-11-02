import { ALL_AVENUES, ALL_STREETS, blockAt } from './city-config.js';

// The carriageway, as the show's AI plans its stunts on it: the roadway of the avenues and streets, curb to curb, off
// the raised curb islands (city-config.js BLOCKS, the pavement the car is pushed off) and off Broadway's paved plazas
// (city-grid.js cuts those outside the avenue's and the cross streets' roadways, so an avenue's or a street's own
// roadway is never plaza). A donut or a way out the AI only plays ahead is judged on it: does the car's whole body, at
// that pose, stay on the road?
//
// The roadway is each avenue's segments (city-config.js: x, its curb-to-curb width along z0..z1) and each numbered
// street's runs (z, its width along x0..x1). A crossing is where the two overlap; the curb's rounded corners are left
// out, which only costs a little road.

// The swim car's half extents (swim-car.js SWIM_BOX) and the points of its outline the check samples, as shares of
// them: the corners and every OUTLINE_STEP m between (a curb's rounded corner poking in between two points 1.26 m apart
// went unseen: Codex 2026-11-03)
const HALF_WIDTH = 0.97;
const HALF_LENGTH = 2.52;
const OUTLINE_STEP = 0.5; // m
const OUTLINE = (() => {
  const points = [];
  const corners = [[-1, 1], [1, 1], [1, -1], [-1, -1]];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    const length = Math.hypot((bx - ax) * HALF_WIDTH, (bz - az) * HALF_LENGTH);
    const n = Math.ceil(length / OUTLINE_STEP);
    for (let k = 0; k < n; k++) points.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return points;
})();

const AVENUES = ALL_AVENUES.filter((a) => !a.isHighway && a.segs).flatMap((a) => a.segs.map((s) => ({ x: a.x, half: s.w / 2, z0: s.z0, z1: s.z1 })));
// (the numbered streets with runs; a few named streets city-config.js adds have none)
const STREETS = ALL_STREETS.filter((s) => s.runs).sort((a, b) => a.z - b.z)
  .map((s) => ({ z: s.z, runs: s.runs.map(([x0, x1, , w]) => ({ x0, x1, half: w / 2 })) }));
const WIDEST_STREET = Math.max(...STREETS.flatMap((s) => s.runs.map((r) => r.half)));

function onAvenue(x, z) {
  for (const a of AVENUES) if (z >= a.z0 && z <= a.z1 && Math.abs(x - a.x) <= a.half) return true;
  return false;
}

function onStreet(x, z) {
  // (the streets by z: the first that could reach z, then on while they still can)
  let lo = 0, hi = STREETS.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (STREETS[mid].z < z - WIDEST_STREET) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < STREETS.length && STREETS[i].z <= z + WIDEST_STREET; i++) {
    const s = STREETS[i];
    for (const r of s.runs) if (x >= r.x0 && x <= r.x1 && Math.abs(z - s.z) <= r.half) return true;
  }
  return false;
}

/** Whether (x, z) is on the roadway of an avenue or a street, off the curb islands */
function onCarriageway(x, z) {
  return (onAvenue(x, z) || onStreet(x, z)) && !blockAt(x, z);
}

/**
 * How many points of the car's outline at (x, z), `heading`, grown by `margin` m all round, are off the carriageway
 * (0: the whole body is on the road)
 */
function footprintOff(x, z, heading, margin = 0) {
  const s = Math.sin(heading), c = Math.cos(heading);
  const w = HALF_WIDTH + margin, l = HALF_LENGTH + margin;
  let off = 0;
  for (const [across, along] of OUTLINE) {
    const lx = across * w, lz = along * l;
    // (the car's local x across and z forward, turned into the world by its heading)
    if (!onCarriageway(x + c * lx + s * lz, z - s * lx + c * lz)) off++;
  }
  return off;
}

export { footprintOff, onCarriageway };
