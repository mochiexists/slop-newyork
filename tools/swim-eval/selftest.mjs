#!/usr/bin/env node
// Every check seen failing: the synthetic ideal show must pass all eight beats, and each deliberate break
// (lib/synthetic.mjs BREAKS) must turn its own beat NOT VERIFIED. Prints a markdown table (for LOG.md); exit 1 if any
// check failed to fail, or the ideal show didn't pass.
// usage: node tools/swim-eval/selftest.mjs --map <maps/map-<sha>.json | tools/swim-eval/test/map-fixture.json>
//        [--write-fixture <file>]   (the map trimmed to round the synthetic show's path, for tests/)
import { readFileSync, writeFileSync } from 'node:fs';
import { checkTrace } from './lib/check.mjs';
import { SwimMap } from './lib/map.mjs';
import { BREAKS, brokenTrace, idealTrace } from './lib/synthetic.mjs';

const FIXTURE_REACH = 40; // m round the synthetic path that the fixture keeps of the map

function selftest(dump) {
  const map = new SwimMap(dump);
  const rows = [];
  const ideal = checkTrace(idealTrace(), map);
  const idealPass = ideal.beats.every((b) => b.verdict === 'VERIFIED');
  rows.push({ name: 'ideal show (no break)', beat: '-', expected: 'all VERIFIED', got: ideal.beats.map((b) => `${b.id}:${b.verdict === 'VERIFIED' ? 'V' : b.verdict}`).join(' '), ok: idealPass, why: '' });
  for (const brk of BREAKS) {
    const result = checkTrace(brokenTrace(brk), map);
    const beat = result.beats[brk.beat - 1];
    const others = result.beats.filter((b) => b.id !== brk.beat && b.verdict !== 'VERIFIED' && b.verdict !== 'N/A').map((b) => b.id);
    const why = beat.criteria.filter((c) => c.pass === false).map((c) => `${c.name} ${c.value}${c.unit}`).join('; ');
    // (a break that takes the beat's evidence away, rather than breaking it, must leave it INCONCLUSIVE: never VERIFIED)
    const expected = brk.expect ?? 'NOT VERIFIED';
    let ok = beat.verdict === expected;
    // (a break aimed at one criterion must fail that one, not the beat by some other: or, `criterionPasses`, leave it
    // passing where the break is a case the check must not count against the show)
    let target = '';
    if (brk.criterion) {
      const c = beat.criteria.find((q) => q.name === brk.criterion);
      const want = brk.criterionPasses ? true : false;
      ok &&= !!c && c.pass === want;
      target = ` [${brk.criterion}: ${c ? `${c.value}${c.unit} ${c.pass ? 'passes' : 'fails'}` : 'missing'}, want ${want ? 'pass' : 'fail'}]`;
    }
    rows.push({ name: brk.name, beat: brk.beat, expected: `${expected}${brk.criterion ? ` on "${brk.criterion}"` : ''}`, got: `${beat.verdict}${target}`, ok, why, others });
  }
  return { rows, ok: rows.every((r) => r.ok) };
}

// The map dump cut down to what lies near the synthetic show's path
function fixture(dump) {
  const pts = idealTrace().frames.filter((_, i) => i % 30 === 0);
  const near = (r) => pts.some((p) => p.x > r.minX - FIXTURE_REACH && p.x < r.maxX + FIXTURE_REACH && p.z > r.minZ - FIXTURE_REACH && p.z < r.maxZ + FIXTURE_REACH);
  const edgeBox = (e) => {
    const x1 = e.x0 + e.dx * e.span, z1 = e.z0 + e.dz * e.span;
    return { minX: Math.min(e.x0, x1), maxX: Math.max(e.x0, x1), minZ: Math.min(e.z0, z1), maxZ: Math.max(e.z0, z1) };
  };
  return { region: dump.region, colliders: dump.colliders.filter(near), footprints: dump.footprints.filter(near), edges: dump.edges.filter((e) => near(edgeBox(e))) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const mapFile = args[args.indexOf('--map') + 1];
  if (!args.includes('--map') || !mapFile) {
    console.error('usage: node tools/swim-eval/selftest.mjs --map <map.json> [--write-fixture <file>]');
    process.exit(2);
  }
  const dump = JSON.parse(readFileSync(mapFile, 'utf8'));
  if (args.includes('--write-fixture')) writeFileSync(args[args.indexOf('--write-fixture') + 1], JSON.stringify(fixture(dump)));
  const { rows, ok } = selftest(dump);
  console.log('| break | beat | expected | got | other beats not VERIFIED | what failed |\n|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.name} | ${r.beat} | ${r.expected} | ${r.ok ? '' : '**'}${r.got}${r.ok ? '' : '** (check never failed!)'} | ${r.others?.length ? r.others.join(', ') : '-'} | ${r.why} |`);
  console.log(ok ? '\nselftest: every check failed on its break, and the ideal show passed' : '\nselftest: FAILED');
  process.exitCode = ok ? 0 : 1;
}

export { fixture, selftest };
