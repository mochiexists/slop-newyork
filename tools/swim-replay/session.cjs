// Recorded sessions (js/session-recorder.js) as replay plans: the run to play again, its start, the player's keys and
// the events tick by tick from it, and the recorded trajectory to hold the replay against.
const { readFileSync } = require('node:fs');

const TICK = 1 / 120; // s: the swim clock's tick (js/swim-clock.js SWIM_TICK)

// Every chunk of a session (the dev server's .jsonl, one chunk a line, or a downloaded .json, one chunk 'all') as one
// list of frames (objects by field), with the runs, events and driver keyframes at their indices in that list
function readSession(file) {
  const text = readFileSync(file, 'utf8').trim();
  const chunks = text.includes('\n') ? text.split('\n').map((line) => JSON.parse(line)) : [JSON.parse(text)];
  const session = { name: chunks[0].session, build: null, frames: [], runs: [], events: [] };
  for (const chunk of chunks) {
    const offset = session.frames.length;
    session.build = chunk.build ?? session.build;
    for (const row of chunk.frames) session.frames.push(Object.fromEntries(chunk.fields.map((field, i) => [field, row[i]])));
    for (const [index, run] of chunk.runs ?? []) session.runs.push({ index: offset + index, ...run });
    for (const [index, event] of chunk.events ?? []) session.events.push({ index: offset + index, ...event });
  }
  return session;
}

// The plan to replay run `which` (default the last): its start, the player's keys and events per tick from it, and
// what was recorded of the car for each of those ticks, as trajectory samples (rounded as the recorder rounds them)
function replayPlan(session, which = null) {
  if (!session.runs.length) throw new Error(`${session.name}: no run starts recorded (a build before the swim clock?)`);
  const number = which ?? session.runs.length - 1;
  const run = session.runs[number];
  if (!run) throw new Error(`${session.name}: no run ${number} (${session.runs.length} runs)`);
  const end = session.runs[number + 1]?.index ?? session.frames.length;
  const keys = [];
  const recorded = [];
  for (let i = run.index; i < end; i++) {
    const f = session.frames[i];
    // a run is its unbroken ticks: a gap (another mode, the tab hidden) ends it
    if (f.tick !== run.tick + keys.length) break;
    // (the recording rounds dt to 0.1 ms: its times are the ticks' own)
    recorded.push([keys.length * TICK, f.x, f.z, f.heading, f.speed, f.slipAngle, f.vx, f.vz, f.angularVel,
      (f.forward ? 1 : 0) | (f.backward ? 2 : 0) | (f.left ? 4 : 0) | (f.right ? 8 : 0) | (f.handbrake ? 16 : 0)]);
    keys.push(f.player);
  }
  const events = session.events.filter((e) => e.index >= run.index && e.index < run.index + keys.length)
    .map((e) => [e.index - run.index, e.name]);
  return { session: session.name, build: session.build, number, runs: session.runs.length, start: run, keys, events, recorded };
}

module.exports = { readSession, replayPlan };
