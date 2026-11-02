// The show's AI getting itself going again (swim-show.js unstick): how far along its route it has got and since when,
// how many times it has backed out without getting anywhere, and whether backing out a given way is clear of the
// traffic and the curbs behind it. Its rule: back out only where the way back is clear, never the same way round
// forever: after maxAttempts tries, or noProgress s without getting further along the route, it reroutes (the show
// picks a new way on from where the car is). Pure and DOM-free: the road is handed in, so tests lay out their own.
// (Codex 2026-11-03 #6: fresh-s4 stood 79% of its roam, backing out 76 s; fresh-s1 backed out six times into the same
// queue.)

const RECOVERY = {
  progressStep: 2, // m further along the route that counts as getting somewhere
  noProgress: 4, // s without that, stopped and not waiting in a queue, before it reroutes
  maxAttempts: 2, // times it backs out without getting somewhere before it reroutes
  reverseDistance: 4.5, // m it backs out at most, each try
  minReverse: 1.5, // m of clear way back below which a way back isn't worth taking
  reverseSpeed: 2.5, // m/s it backs out at, at most (S let go above it)
  reverseBrake: 3, // m/s² it reckons its roll back stops at, off S (the keyboard driver's W brakes it, the drag too)
  turnRadius: 6, // m: the arc the car backs round with the wheel on full lock
  sampleStep: 0.4, // m between the poses checked on the way back
  clearance: 0.3, // m it keeps round its body from traffic and curbs, backing out
  halfWidth: 0.97, // the swim car's half extents (swim-car.js SWIM_BOX)
  halfLength: 2.52
};
const CLEARANCES = [0.3, 0.2, 0.1, 0.05, 0.02, 0]; // m it keeps, most first, round something it already stands close to
const MIN_SAMPLE_STEP = 0.05; // m between the poses it checks, at the closest
const AIM_STEP = 0.1; // m between the poses backingToAim looks from

// Whether two boxes (centre, heading, half extents across and along) overlap: the separating axes of both
function boxesOverlap(ax, az, ah, aw, al, bx, bz, bh, bw, bl) {
  const dx = bx - ax, dz = bz - az;
  for (const h of [ah, bh]) {
    const fx = Math.sin(h), fz = Math.cos(h); // along
    const rx = Math.cos(h), rz = -Math.sin(h); // across
    for (const [ux, uz] of [[fx, fz], [rx, rz]]) {
      const reachA = aw * Math.abs(ux * Math.cos(ah) - uz * Math.sin(ah)) + al * Math.abs(ux * Math.sin(ah) + uz * Math.cos(ah));
      const reachB = bw * Math.abs(ux * Math.cos(bh) - uz * Math.sin(bh)) + bl * Math.abs(ux * Math.sin(bh) + uz * Math.cos(bh));
      if (Math.abs(dx * ux + dz * uz) > reachA + reachB) return false;
    }
  }
  return true;
}

/**
 * m the car can back out with the wheel at `steer` (+1 A, -1 D, 0 straight) before its body, grown by `clearance`,
 * meets a car of `obstacles` (each { x, z, yaw, speed, half, halfWidth }, flown on at its speed while it backs) or
 * leaves `road` ({ footprintOff }); up to `distance`. Backing up turns the car the other way to the wheel.
 */
function reverseClear(car, steer, distance, obstacles, road, options = {}) {
  const o = { ...RECOVERY, ...options };
  let x = car.position.x, z = car.position.z, h = car.heading;
  // A car (or a curb) already inside the clearance where the car stands counts only once the car gets closer to it than
  // it is: the clearance it gets is the most of CLEARANCES the car clears it by now (stopped 0.15 m beside a car, the
  // whole 0.3 m refused every way back, and the AI stood for 88 s: fresh-s4-30 on 9f70d21)
  const near = [];
  for (const ob of obstacles) {
    const close = Math.abs(ob.x - x) < 12 && Math.abs(ob.z - z) < 12;
    const clear = close ? CLEARANCES.find((c) => c <= o.clearance && !boxesOverlap(x, z, h, o.halfWidth + c, o.halfLength + c, ob.x, ob.z, ob.yaw ?? 0, ob.halfWidth ?? 0.95, ob.half ?? 2.3)) : o.clearance;
    // (already touching it: it is left out, as the way back only parts them or the car is stuck either way)
    if (clear !== undefined) near.push({ ob, clear });
  }
  const roadMargin = road ? CLEARANCES.find((c) => c <= o.clearance && road.footprintOff(x, z, h, c) === 0) : undefined;
  const offAtStart = road && roadMargin === undefined ? road.footprintOff(x, z, h, 0) : 0;
  // (the poses no further apart than the least clearance it keeps: 0.4 m apart round a car 0.05 m off, the body
  // passed through its corner between two of them, Codex 2026-11-03 round 2)
  let least = road ? Math.min(o.clearance, roadMargin ?? 0) : o.clearance;
  for (const { clear } of near) least = Math.min(least, clear);
  const sample = Math.min(o.sampleStep, Math.max(MIN_SAMPLE_STEP, least));
  for (let d = sample; d <= distance + 1e-9; d += sample) {
    x -= Math.sin(h) * sample;
    z -= Math.cos(h) * sample;
    h -= steer * sample / o.turnRadius;
    if (road && (roadMargin === undefined ? road.footprintOff(x, z, h, 0) > offAtStart : road.footprintOff(x, z, h, roadMargin) > 0)) return d - sample;
    const t = d / o.reverseSpeed;
    for (const { ob, clear } of near) {
      const yaw = ob.yaw ?? 0;
      const ox = ob.x + Math.sin(yaw) * (ob.speed || 0) * t, oz = ob.z + Math.cos(yaw) * (ob.speed || 0) * t;
      if (Math.abs(ox - x) > 12 || Math.abs(oz - z) > 12) continue;
      if (boxesOverlap(x, z, h, o.halfWidth + clear, o.halfLength + clear, ox, oz, yaw, ob.halfWidth ?? 0.95, ob.half ?? 2.3)) return d - sample;
    }
  }
  return distance;
}

/**
 * m of backing out with the wheel at `steer` after which the nose points at `aim` ({ x, z }) to within `within` rad;
 * Infinity if it doesn't by `distance`. (The same arc reverseClear checks.)
 */
function backingToAim(car, steer, distance, aim, within, options = {}) {
  const o = { ...RECOVERY, ...options };
  let x = car.position.x, z = car.position.z, h = car.heading;
  for (let d = 0; d <= distance + 1e-9; d += AIM_STEP) {
    if (d > 0) {
      x -= Math.sin(h) * AIM_STEP;
      z -= Math.cos(h) * AIM_STEP;
      h -= steer * AIM_STEP / o.turnRadius;
    }
    const off = Math.atan2(aim.x - x, aim.z - z) - h;
    if (Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) < within) return d;
  }
  return Infinity;
}

/**
 * The way back to take: the wheel it would like (`wanted`, +1 / -1 / 0) if that way is clear for minReverse, else
 * whichever other is clear furthest. Returns { steer, distance }, or null when no way back is clear.
 */
function chooseReverse(car, wanted, obstacles, road, options = {}) {
  const o = { ...RECOVERY, ...options };
  let best = null;
  for (const steer of [wanted, 0, 1, -1]) {
    const distance = reverseClear(car, steer, o.reverseDistance, obstacles, road, o);
    if (distance < o.minReverse) continue;
    if (steer === wanted) return { steer, distance };
    if (!best || distance > best.distance) best = { steer, distance };
  }
  return best;
}

// How the getting-going-again is going: progress along the route, tries without it
class Recovery {
  constructor(options = {}) {
    this.o = { ...RECOVERY, ...options };
    this.reset();
  }

  reset() {
    this.best = -Infinity; // the furthest along the route it has been (m)
    this.stalled = 0; // s since it last got progressStep further
    this.attempts = 0; // times it has backed out since it last got somewhere
    this.state = 'drive'; // 'drive' | 'reverse' | 'reacquire'
    return this;
  }

  // A tick: `along` m along the route, `waiting` whether it stands in a queue it means to wait in (a red light's).
  // Returns whether it should reroute now.
  progress(along, dt, waiting) {
    if (along > this.best + this.o.progressStep) {
      this.best = along;
      this.stalled = 0;
      this.attempts = 0;
      return false;
    }
    this.stalled = waiting ? 0 : this.stalled + dt;
    return this.stalled > this.o.noProgress || this.attempts >= this.o.maxAttempts;
  }

  // A new route from where the car is: progress counts from there
  rerouted(along) {
    this.best = along;
    this.stalled = 0;
    this.attempts = 0;
    this.state = 'drive';
  }
}

export { RECOVERY, Recovery, backingToAim, boxesOverlap, chooseReverse, reverseClear };
