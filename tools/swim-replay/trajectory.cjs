// Trajectories of the swimming car and how far two of them part.
//
// A trajectory is a list of samples [t, x, z, heading, speed, slip, vx, vz, angularVel, keys]: t the sim seconds since
// the run began, the car's state as a physics step starts from it, keys a bitmask (W 1, S 2, A 4, D 8, Space 16) of
// what was pressed for that step. On a fixed clock every run samples the same times and two runs compare sample by
// sample; on a frame clock (the build before it, 89419cc) the times differ, so the other run is read at the reference's
// times by linear interpolation (under 2 mm of error on a 10 m donut at 30 Hz, against divergences of metres).
const FIELDS = ['t', 'x', 'z', 'heading', 'speed', 'slip', 'vx', 'vz', 'angularVel', 'keys'];
const KEY_BITS = { forward: 1, backward: 2, left: 4, right: 8, handbrake: 16 };

function keyBits(keys) {
  let bits = 0;
  for (const [key, bit] of Object.entries(KEY_BITS)) if (keys[key]) bits |= bit;
  return bits;
}

function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// The other trajectory's state at time t (linear between its samples; heading unwrapped across ±π)
function sampleAt(samples, t, cursor) {
  let i = cursor.i;
  while (i + 1 < samples.length && samples[i + 1][0] <= t) i++;
  cursor.i = i;
  const a = samples[i], b = samples[i + 1];
  if (!b || a[0] === t) return a;
  const f = (t - a[0]) / (b[0] - a[0]);
  const out = a.slice();
  for (let k = 1; k < 9; k++) {
    out[k] = k === 3 ? a[3] + wrapAngle(b[3] - a[3]) * f : a[k] + (b[k] - a[k]) * f;
  }
  out[0] = t;
  return out;
}

// How far `run` parts from `reference` over the time both cover: the largest position gap (m), heading (rad), speed
// (m/s) and slip (rad) differences, where each first passes 1e-6 m, 1 cm and 1 m, whether the two sample the same
// times, and how many samples are bit for bit the same
function compare(reference, run, { until = Infinity } = {}) {
  const ref = reference.samples, other = run.samples;
  const end = Math.min(until, ref[ref.length - 1][0], other[other.length - 1][0]);
  // (a fixed clock's runs step the same times; a recording keeps them rounded, so "the same" is to a nanosecond)
  const sameClock = ref.length > 1 && other.length > 1 && Math.abs(ref[1][0] - other[1][0]) < 1e-9;
  const result = {
    end, compared: 0, identical: 0, sameClock, maxPosition: 0, maxHeading: 0, maxSpeed: 0, maxSlip: 0,
    firstMicro: null, firstCentimetre: null, firstMetre: null, worstAt: null
  };
  const cursor = { i: 0 };
  for (let n = 0; n < ref.length && ref[n][0] <= end; n++) {
    const a = ref[n];
    const b = sameClock ? other[n] : sampleAt(other, a[0], cursor);
    if (!b) break;
    result.compared++;
    if (a.every((value, k) => value === b[k])) result.identical++;
    const position = Math.hypot(a[1] - b[1], a[2] - b[2]);
    if (position > result.maxPosition) {
      result.maxPosition = position;
      result.worstAt = a[0];
    }
    result.maxHeading = Math.max(result.maxHeading, Math.abs(wrapAngle(a[3] - b[3])));
    result.maxSpeed = Math.max(result.maxSpeed, Math.abs(a[4] - b[4]));
    result.maxSlip = Math.max(result.maxSlip, Math.abs(wrapAngle(a[5] - b[5])));
    if (result.firstMicro === null && position > 1e-6) result.firstMicro = a[0];
    if (result.firstCentimetre === null && position > 0.01) result.firstCentimetre = a[0];
    if (result.firstMetre === null && position > 1) result.firstMetre = a[0];
  }
  return result;
}

function describe(name, c) {
  const at = (t) => (t === null ? 'never' : `${t.toFixed(2)} s`);
  return `${name}: ${c.compared} samples over ${c.end.toFixed(1)} s, ${c.identical} identical`
    + `${c.sameClock ? '' : ' (interpolated: different frame times)'}; max gap ${c.maxPosition.toExponential(3)} m`
    + `${c.worstAt === null ? '' : ` at ${c.worstAt.toFixed(2)} s`}, heading ${c.maxHeading.toExponential(2)} rad,`
    + ` speed ${c.maxSpeed.toExponential(2)} m/s, slip ${c.maxSlip.toExponential(2)} rad;`
    + ` past 1e-6 m ${at(c.firstMicro)}, past 1 cm ${at(c.firstCentimetre)}, past 1 m ${at(c.firstMetre)}`;
}

module.exports = { FIELDS, KEY_BITS, compare, describe, keyBits, sampleAt, wrapAngle };
