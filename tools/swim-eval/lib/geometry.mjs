// The show's fixed points (as swim-show.js places them, from the same city data) and the small geometry the checker
// shares: ground speed, angle wrapping, the Kasa circle fit, box clearance.
import { avenueX, streetZ } from '../../../js/city-config.js';

const DRIFT_RADIUS = 11; // swim-show.js
const ROLL_DISTANCE = 22; // swim-show.js
const COP = { x: avenueX('7') - 2, z: streetZ(45) }; // swim-show.js COP_SPOT
const SHOW_SPOT = { x: COP.x - DRIFT_RADIUS, z: COP.z - ROLL_DISTANCE, heading: 0 };
const MPH = 2.23694; // mph per m/s

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// Speed over the ground (m/s): the car's forward speed plus its sideways slide (drift-physics.js keeps both)
function groundSpeed(f) {
  const s = Math.sin(f.h), c = Math.cos(f.h);
  return Math.hypot(s * f.v + (f.vx ?? 0), c * f.v + (f.vz ?? 0));
}

// The direction the car is travelling (rad, the heading convention: atan2(x, z))
function travelHeading(f) {
  const s = Math.sin(f.h), c = Math.cos(f.h);
  return Math.atan2(s * f.v + (f.vx ?? 0), c * f.v + (f.vz ?? 0));
}

// Kasa fit (donut-score.py): x² + z² + D x + E z + F = 0 by least squares; { cx, cz, r } or null
function kasaFit(points) {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0, bx = 0, bz = 0, bs = 0;
  for (const [x, z] of points) {
    const b = -(x * x + z * z);
    sx += x; sz += z; sxx += x * x; szz += z * z; sxz += x * z;
    bx += b * x; bz += b * z; bs += b;
  }
  const m = [[sxx, sxz, sx], [sxz, szz, sz], [sx, sz, n]];
  const rhs = [bx, bz, bs];
  const det = (a) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
    + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d0 = det(m);
  if (Math.abs(d0) < 1e-9) return null;
  const sol = [0, 1, 2].map((col) => det(m.map((row, r) => row.map((v, c) => (c === col ? rhs[r] : v)))) / d0);
  const [D, E, F] = sol;
  const cx = -D / 2, cz = -E / 2;
  return { cx, cz, r: Math.sqrt(Math.max(0, cx * cx + cz * cz - F)) };
}

// Two oriented boxes ({ x, z, sin, cos, hw, hl }): the largest separation on their four axes (- overlapping)
function boxClearance(a, b) {
  const axes = [[a.sin, a.cos], [a.cos, -a.sin], [b.sin, b.cos], [b.cos, -b.sin]];
  let gap = -Infinity;
  for (const [ax, az] of axes) {
    const project = (o) => o.hl * Math.abs(o.sin * ax + o.cos * az) + o.hw * Math.abs(o.cos * ax - o.sin * az);
    gap = Math.max(gap, Math.abs((b.x - a.x) * ax + (b.z - a.z) * az) - project(a) - project(b));
  }
  return gap;
}

export { COP, DRIFT_RADIUS, MPH, SHOW_SPOT, boxClearance, groundSpeed, kasaFit, travelHeading, wrapAngle };
