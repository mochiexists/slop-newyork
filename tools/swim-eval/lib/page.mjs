// What the eval runs inside the game's page. Every export is a self-contained function: Playwright serialises it into
// the page (addInitScript / evaluate), so none may reach for anything outside its own body.
//
//   clockInit      before any page script: a seeded Math.random and a virtual animation clock. The game's frames are
//                  handed timestamps from the scenario's frame-time profile, and once main.js starts its loop the clock
//                  only moves when the runner lets it (run), frame by frame, so key presses, the P press and the
//                  screenshots land on exact frames whatever the headless browser's real frame rate.
//   installProbe   once the city is up: the per-frame trace (the car, the show, the cop, keys, contacts), wrapped
//                  round the game's own objects without changing what they do, plus the stop points for screenshots.
//   dumpMap        the game's own geometry round Midtown, for the checker's road / pavement / plaza / building map.
//   injectState    a scenario's start state, written once at the P frame (before the beat, never during it).
//   readTrace      the trace, in slices (it is too big for one evaluate on a long run).

// ---------------------------------------------------------------------------------------------------------------------
function clockInit(cfg) {
  const mulberry32 = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const LOADING_DT = 1 / 60; // s per frame while the city loads (before the game loop: no driving happens)
  const profileRandom = mulberry32(cfg.clockSeed >>> 0);
  let sequenceIndex = 0;
  // The frame-time profile: a fixed rate, the 120/60 mix musa's Mac ran at, or a recorded dt sequence (cycled)
  const nextDt = () => {
    if (cfg.profile === 'mix') return profileRandom() < 0.5 ? 1 / 120 : 1 / 60;
    if (cfg.profile === 'seq') {
      const dt = cfg.dtSequence[sequenceIndex % cfg.dtSequence.length];
      sequenceIndex++;
      return dt;
    }
    return 1 / Number(cfg.profile);
  };
  if (cfg.seedMath) Math.random = mulberry32(cfg.seed >>> 0);
  const clock = {
    virtual: 0, // ms handed to the game
    free: true, // loading: frames run at LOADING_DT unasked
    loopStarted: false,
    loopFrame: 0, // game-loop frames run
    simTime: 0, // s of game-loop frames run
    budget: 0,
    until: Infinity, // simTime to stop at
    stop: null, // set by the probe: stop after this frame (a beat change, a contact) for a screenshot
    held: [],
    waiter: null,
    realTs: -1,
    lastDt: 0,
    reseedMath(seed) {
      Math.random = mulberry32(seed >>> 0);
    },
    // main.js calls this just before renderer.setAnimationLoop (the runner's rewrite): from here the clock waits
    loopStarting() {
      clock.free = false;
      clock.loopStarted = true;
    },
    // Run up to `frames` game-loop frames, or until simTime reaches `until`, or until the probe asks to stop
    run(frames = Infinity, until = Infinity) {
      return new Promise((resolve) => {
        clock.budget = frames;
        clock.until = until;
        clock.stop = null;
        clock.waiter = resolve;
        const held = clock.held.splice(0);
        for (const cb of held) window.requestAnimationFrame(cb);
        if (frames <= 0) clock.settle();
      });
    },
    settle() {
      const waiter = clock.waiter;
      if (!waiter) return;
      if (clock.budget > 0 && clock.simTime < clock.until && !clock.stop) return;
      clock.waiter = null;
      clock.budget = 0;
      waiter({ frame: clock.loopFrame, simTime: clock.simTime, stop: clock.stop });
    }
  };
  window.__clock = clock;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => raf((ts) => {
    if (ts !== clock.realTs) {
      // A new frame of the browser's: paused, every callback waits for the next run()
      if (!clock.free && (clock.budget <= 0 || clock.simTime >= clock.until || clock.stop)) {
        clock.held.push(callback);
        return;
      }
      clock.realTs = ts;
      const dt = clock.free ? LOADING_DT : nextDt();
      clock.virtual += dt * 1000;
      if (!clock.free) {
        clock.budget--;
        clock.loopFrame++;
        clock.simTime += dt;
        clock.lastDt = dt;
        // (after every callback of this browser frame has run)
        setTimeout(() => clock.settle(), 0);
      }
    }
    callback(clock.virtual);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
async function installProbe(cfg) {
  const d = globalThis.__swim;
  const cm = globalThis.__evalControllers;
  const world = globalThis.__evalWorld;
  const clock = globalThis.__clock;
  const showModule = await import('/js/swim-show.js');
  const car = d.car;
  const show = d.show;
  const cruiser = d.cruiser;
  // (t0: the simTime of the P frame, set by the runner as it starts recording: every t in the trace is s since P)
  const trace = globalThis.__trace = { frames: [], events: [], recording: false, t0: 0 };
  const acc = { building: 0, buildingDepth: 0, cop: 0, copDepth: 0, traffic: 0, trafficSpeed: 0 };
  // (s since P, of the sim's own steps: a frame on a fixed-clock build, 2771a69 on, steps 0-n ticks, and every event
  // and record is stamped with the tick it happens in. simT is added to at the start of each step, the runner zeroes it
  // at P.)
  trace.simT = 0;
  const now = () => +trace.simT.toFixed(4);
  const snapLimit = { last: -Infinity, count: 0 };
  const MAX_INCIDENT_SNAPS = 24;
  const INCIDENT_SNAP_GAP = 1.5; // s between screenshots of incidents
  const incident = (label) => {
    if (!trace.recording || !cfg.snapIncidents) return;
    if (clock.simTime - snapLimit.last < INCIDENT_SNAP_GAP || snapLimit.count >= MAX_INCIDENT_SNAPS) return;
    snapLimit.last = clock.simTime;
    snapLimit.count++;
    clock.stop = clock.stop ?? { kind: 'incident', label, frame: clock.loopFrame, t: now() };
  };

  // The traffic seed: the show reseeds its staged traffic at the start (SHOW_TRAFFIC_SEED); the scenario's seed goes
  // through the same call, at the same moment
  const reseed = d.traffic.reseed;
  d.traffic.reseed = (seed, x, z) => {
    const used = cfg.trafficSeed ?? seed;
    trace.events.push({ kind: 'reseed', t: now(), asked: seed, used });
    return reseed(used, x, z);
  };

  // Buildings (and the island's edge): every push resolveHorizontalCollision gives the swim car
  const resolve = cm.resolveHorizontalCollision.bind(cm);
  cm.resolveHorizontalCollision = (pos, radius, carEntity = null, entity = carEntity) => {
    if (carEntity !== car) return resolve(pos, radius, carEntity, entity);
    const x = pos.x, z = pos.z;
    const result = resolve(pos, radius, carEntity, entity);
    const moved = Math.hypot(pos.x - x, pos.z - z);
    if (moved > 1e-4) {
      acc.building++;
      acc.buildingDepth = Math.max(acc.buildingDepth, moved);
    }
    return result;
  };

  // The cop: the cruiser's own contact resolution with the car
  const collide = cruiser.collide.bind(cruiser);
  cruiser.collide = (player) => {
    const x = player.position.x, z = player.position.z;
    collide(player);
    const moved = Math.hypot(player.position.x - x, player.position.z - z);
    if (moved > 1e-4) {
      acc.cop++;
      acc.copDepth = Math.max(acc.copDepth, moved);
    }
  };

  // Traffic: the game's own collision reports (impacts over 0.5 m/s), chained in front of whatever listens already
  let trafficListener = null;
  const listen = (event) => {
    if (event?.a === car || event?.b === car) {
      acc.traffic++;
      acc.trafficSpeed = Math.max(acc.trafficSpeed, event.speed ?? 0);
    }
    trafficListener?.(event);
  };
  const setListener = d.traffic.setCollisionListener;
  if (setListener) {
    d.traffic.setCollisionListener = (listener) => {
      trafficListener = listener;
      setListener(listen);
    };
    setListener(listen);
  }

  // Close calls and splits as the game scores them
  const closeUpdate = d.closeCalls.update.bind(d.closeCalls);
  d.closeCalls.update = (dt, c, ...groups) => {
    const points = closeUpdate(dt, c, ...groups);
    if (points && trace.recording) {
      trace.events.push({
        kind: d.closeCalls.split ? 'split' : 'close', t: now(), frame: clock.loopFrame, points, chain: d.closeCalls.chain,
        mph: Math.round(Math.abs(c.speed) * 2.237), x: +c.position.x.toFixed(2), z: +c.position.z.toFixed(2), phase: show.phase
      });
    }
    return points;
  };

  // Beat changes: the show's phases and the donut driver's, each a stop point for a screenshot
  const setPhase = show.setPhase.bind(show);
  show.setPhase = (phase) => {
    const from = show.phase;
    setPhase(phase);
    if (!trace.recording) return;
    trace.events.push({ kind: 'phase', t: now(), frame: clock.loopFrame, from, to: phase, x: +car.position.x.toFixed(2), z: +car.position.z.toFixed(2) });
    if (cfg.snapBeats) clock.stop = clock.stop ?? { kind: 'beat', label: `show-${phase}`, frame: clock.loopFrame, t: now() };
  };
  const donutProto = showModule.DonutDriver.prototype;
  if (!donutProto.__evalWrapped) {
    donutProto.__evalWrapped = true;
    const donutSetPhase = donutProto.setPhase;
    donutProto.setPhase = function (phase) {
      const from = this.phase;
      donutSetPhase.call(this, phase);
      globalThis.__evalDonutPhase?.(from, phase);
    };
    const powerOut = donutProto.powerOut;
    donutProto.powerOut = function () {
      const from = this.phase;
      powerOut.call(this);
      globalThis.__evalDonutPhase?.(from, 'powerOut');
    };
  }
  globalThis.__evalDonutPhase = (from, to) => {
    if (!trace.recording) return;
    trace.events.push({ kind: 'donut', t: now(), frame: clock.loopFrame, from, to, x: +car.position.x.toFixed(2), z: +car.position.z.toFixed(2) });
    if (cfg.snapBeats && (to === 'launch' || to === 'drift' || to === 'powerOut')) {
      clock.stop = clock.stop ?? { kind: 'beat', label: `donut-${to}`, frame: clock.loopFrame, t: now() };
    }
  };

  // Oriented boxes: how far apart (- overlapping), on the separating axes of the two boxes
  const clearance = (a, b) => {
    const axes = [[a.sin, a.cos], [a.cos, -a.sin], [b.sin, b.cos], [b.cos, -b.sin]];
    let gap = -Infinity;
    for (const [ax, az] of axes) {
      const project = (o) => o.hl * Math.abs(o.sin * ax + o.cos * az) + o.hw * Math.abs(o.cos * ax - o.sin * az);
      gap = Math.max(gap, Math.abs((b.x - a.x) * ax + (b.z - a.z) * az) - project(a) - project(b));
    }
    return gap;
  };
  const SWIM_HALF = [0.97, 2.52]; // swim-car.js SWIM_BOX
  const COP_HALF = [1.0, 2.4]; // swim-show.js PoliceCruiser.collide
  const NEAR = 14;
  const touching = new Set();
  let lastPath = null;
  let lastPathLength = 0;

  // One record per step of the sim, after the whole step, its time counted from the step's start (so an event inside
  // it, a phase the AI changes as it presses its keys, carries the step's own time). On a fixed-clock build (2771a69
  // on: controllers.swimClock steps the car, the director and then the traffic once per 1/120 s tick, SwimClock.step)
  // around each tick: the traffic's step can still move the car and resolve a contact (Codex round 3); in update() the
  // car would be its drawn pose, between two ticks. Before it (89419cc), around each frame: the time from the start of
  // the controllers' update (where the AI presses its keys), the record after the frame's traffic update.
  const swimClock = cm.swimClock;
  const fixedClock = Boolean(swimClock && typeof swimClock.step === 'function');
  trace.fixedClock = fixedClock;
  if (fixedClock) {
    const tick = swimClock.step.bind(swimClock);
    swimClock.step = (c, dt) => {
      if (trace.recording) trace.simT += dt;
      tick(c, dt);
      record(dt);
    };
  } else {
    const controllersUpdate = cm.update.bind(cm);
    cm.update = (dt, ...rest) => {
      if (trace.recording) trace.simT += dt;
      trace.frameDt = dt;
      return controllersUpdate(dt, ...rest);
    };
    const trafficUpdate = d.traffic.update.bind(d.traffic);
    d.traffic.update = (dt, ...rest) => {
      const result = trafficUpdate(dt, ...rest);
      record(trace.frameDt ?? dt);
      return result;
    };
  }
  function record(dt) {
    // (before P, a warm-up's pushes and impacts are dropped tick by tick: they'd land on the first frame of the show)
    if (!trace.recording) {
      acc.building = acc.buildingDepth = acc.cop = acc.copDepth = acc.traffic = acc.trafficSpeed = 0;
      return;
    }
    const c = car;
    const p = show.pilot;
    const keys = cm._swimKeys ?? {};
    const input = cm.swimDriver?.input ?? {};
    const me = { x: c.position.x, z: c.position.z, sin: Math.sin(c.heading), cos: Math.cos(c.heading), hw: SWIM_HALF[0], hl: SWIM_HALF[1] };
    const cop = cruiser.car;
    let copGap = null;
    if (cruiser.state !== 'hidden') {
      copGap = clearance(me, { x: cop.position.x, z: cop.position.z, sin: Math.sin(cop.heading), cos: Math.cos(cop.heading), hw: COP_HALF[0], hl: COP_HALF[1] });
    }
    // Traffic within reach: the nearest clearance, and contacts by box overlap (any speed)
    let trafficGap = Infinity;
    let overlapping = 0;
    for (const v of [...d.traffic.cars, ...(d.traffic.buses ?? [])]) {
      if (!v.edge || Math.abs(v.x - me.x) > NEAR || Math.abs(v.z - me.z) > NEAR) {
        touching.delete(v);
        continue;
      }
      const gap = clearance(me, { x: v.x, z: v.z, sin: Math.sin(v.yaw), cos: Math.cos(v.yaw), hw: v.halfWidth ?? 0.95, hl: v.halfL ?? v.half ?? 2.3 });
      trafficGap = Math.min(trafficGap, gap);
      if (gap < 0) {
        overlapping++;
        if (!touching.has(v)) {
          touching.add(v);
          trace.events.push({ kind: 'contact-traffic', t: now(), frame: clock.loopFrame, mph: Math.round(Math.abs(c.speed) * 2.237), x: +me.x.toFixed(2), z: +me.z.toFixed(2), bus: !v.halfWidth && !!v.halfL, phase: show.phase, staged: !!v.staged });
          incident('contact-traffic');
        }
      } else {
        touching.delete(v);
      }
    }
    if (acc.cop) {
      trace.events.push({ kind: 'contact-cop', t: now(), frame: clock.loopFrame, depth: +acc.copDepth.toFixed(3), mph: Math.round(Math.abs(c.speed) * 2.237), x: +me.x.toFixed(2), z: +me.z.toFixed(2), phase: show.phase });
      incident('contact-cop');
    }
    if (acc.building) {
      trace.events.push({ kind: 'contact-building', t: now(), frame: clock.loopFrame, pushes: acc.building, depth: +acc.buildingDepth.toFixed(3), mph: Math.round(Math.abs(c.speed) * 2.237), x: +me.x.toFixed(2), z: +me.z.toFixed(2), phase: show.phase });
      incident('contact-building');
    }
    if (acc.traffic) {
      trace.events.push({ kind: 'impact-traffic', t: now(), frame: clock.loopFrame, speed: +acc.trafficSpeed.toFixed(2), x: +me.x.toFixed(2), z: +me.z.toFixed(2), phase: show.phase });
    }
    // The route the AI drives, whenever it changes
    if (p.path !== lastPath || p.path.length !== lastPathLength) {
      lastPath = p.path;
      lastPathLength = p.path.length;
      trace.events.push({ kind: 'path', t: now(), frame: clock.loopFrame, points: p.path.map((q) => [+q.x.toFixed(1), +q.z.toFixed(1)]) });
    }
    const k = `${keys.forward ? 'W' : ''}${keys.backward ? 'S' : ''}${keys.left ? 'A' : ''}${keys.right ? 'D' : ''}${keys.handbrake ? 'H' : ''}`;
    trace.frames.push({
      f: clock.loopFrame, t: now(), dt: +dt.toFixed(5), wall: Date.now(),
      phase: show.phase, dp: show.donut?.phase ?? null, laps: show.donut ? +show.donut.laps.toFixed(3) : null,
      x: +c.position.x.toFixed(3), z: +c.position.z.toFixed(3), h: +c.heading.toFixed(4), v: +c.speed.toFixed(3),
      vx: +c.vx.toFixed(3), vz: +c.vz.toFixed(3), w: +c.angularVel.toFixed(3), st: +c.steerAngle.toFixed(3),
      slip: +(c.drift?.slipAngle ?? 0).toFixed(4), spin: +(c.drift?.wheelspin ?? 0).toFixed(3), gear: c.gear,
      k, thr: +(input.throttle ?? 0).toFixed(2), brk: +(input.brake ?? 0).toFixed(2), hb: +(input.handbrake ?? 0).toFixed(2),
      cx: cruiser.state === 'hidden' ? null : +cop.position.x.toFixed(2), cz: cruiser.state === 'hidden' ? null : +cop.position.z.toFixed(2),
      ch: +cop.heading.toFixed(3), cs: cruiser.state, copGap: copGap === null ? null : +copGap.toFixed(3),
      tGap: Number.isFinite(trafficGap) ? +trafficGap.toFixed(3) : null, tHit: overlapping,
      bHit: acc.building, copHit: acc.cop,
      seg: p.segment, rev: show.reversing > 0 ? 1 : 0, queued: p.queued ? 1 : 0, cam: c.cameraYawOverride === null || c.cameraYawOverride === undefined ? 0 : 1
    });
    acc.building = acc.buildingDepth = acc.cop = acc.copDepth = acc.traffic = acc.trafficSpeed = 0;
  }
  // (the show's own fixed points, which the checker judges by: where the cop parks, where the car starts, the run)
  const route = (showModule.ESCAPE_ROUTE ?? []).map((q) => ({ x: q.x, z: q.z }));
  return { ok: true, fixedClock, cop: showModule.COP_SPOT, showSpot: showModule.SHOW_SPOT, radius: showModule.DRIFT_RADIUS, route: route.length ? route : null };
}

// ---------------------------------------------------------------------------------------------------------------------
function dumpMap(region) {
  const world = globalThis.__evalWorld;
  const inside = (r) => r.maxX >= region.minX && r.minX <= region.maxX && r.maxZ >= region.minZ && r.minZ <= region.maxZ;
  const round = (v) => Math.round(v * 100) / 100;
  const ring = (pts) => pts.map((p) => [round(p.x), round(p.z)]);
  const colliders = [];
  for (const c of world.allColliders) {
    // (the swim car's body runs 0..~1.5 m: an elevated section it passes under is no wall to it)
    if (!inside(c) || (c.minY ?? 0) > 1.5 || c.maxY <= 0) continue;
    const out = { minX: round(c.minX), maxX: round(c.maxX), minZ: round(c.minZ), maxZ: round(c.maxZ) };
    if (c.polygon) out.polygon = { outer: ring(c.polygon.outer), holes: (c.polygon.holes ?? []).map(ring) };
    else if (c.obb) out.obb = { cx: c.obb.cx, cz: c.obb.cz, hx: c.obb.hx, hz: c.obb.hz, cs: c.obb.cs, sn: c.obb.sn };
    colliders.push(out);
  }
  const footprints = [];
  for (const [source, list] of [['cityGrid', world.cityGrid.footprints], ['streetDetails', world.streetDetails.footprints ?? []]]) {
    for (const r of list) {
      if (!inside(r)) continue;
      footprints.push({ source, minX: round(r.minX), maxX: round(r.maxX), minZ: round(r.minZ), maxZ: round(r.maxZ), pedestrianOnly: !!r.pedestrianOnly, polygon: r.polygon ? ring(r.polygon.outer ?? r.polygon) : undefined });
    }
  }
  const edges = [];
  for (const e of world.trafficSystem.network.edges) {
    const x1 = e.x0 + e.dx * e.span, z1 = e.z0 + e.dz * e.span;
    if (!inside({ minX: Math.min(e.x0, x1), maxX: Math.max(e.x0, x1), minZ: Math.min(e.z0, z1), maxZ: Math.max(e.z0, z1) })) continue;
    edges.push({ id: e.id, x0: round(e.x0), z0: round(e.z0), dx: e.dx, dz: e.dz, span: round(e.span), half: e.half, lanes: e.lanes, axis: e.axis ?? null });
  }
  return { region, colliders, footprints, edges, sidewalks: world.cityGrid.sidewalks.filter(inside).length };
}

// ---------------------------------------------------------------------------------------------------------------------
async function injectState(state) {
  const { DonutDriver, COP_SPOT, DRIFT_RADIUS } = await import('/js/swim-show.js');
  const { KeyboardDriver } = await import('/js/drift-physics.js');
  const d = globalThis.__swim;
  const cm = globalThis.__evalControllers;
  const car = d.car;
  const show = d.show;
  car.position.x = car.prevX = state.x;
  car.position.z = car.prevZ = state.z;
  car.heading = state.heading;
  car.cameraYaw = state.heading;
  for (const key of ['speed', 'vx', 'vz', 'angularVel', 'steerAngle', 'longAccel', 'gear', 'rpm', 'wheelSlip', 'limiterTime']) {
    if (Number.isFinite(state[key])) car[key] = state[key];
  }
  car.drift.slipAngle = state.slipAngle ?? 0;
  car.drift.wheelspin = state.wheelspin ?? 0;
  if (car.mesh) {
    car.mesh.position.set(car.position.x, car.position.y, car.position.z);
    car.mesh.rotation.y = car.heading;
  }
  // The keyboard driver as the player's frame left it (the session's snapshot), else as a fresh show leaves it
  const driver = cm.swimDriver ??= new KeyboardDriver();
  driver.reset();
  if (state.driver) {
    for (const [key, value] of Object.entries(state.driver)) {
      if (typeof value === 'number' || typeof value === 'boolean') driver[key] = value;
    }
  }
  // The show's hands and donut driver as the show has them mid-beat: fresh hands, a donut driver in its drift
  show.hands.reset();
  if (state.showPhase === 'donuts') {
    const donut = new DonutDriver(COP_SPOT, DRIFT_RADIUS, -Math.PI / 2, {}, show.hands);
    donut.phase = state.donutPhase ?? 'drift';
    donut.time = 0;
    donut.swept = state.swept ?? 0;
    show.donut = donut;
    show.setPhase('donuts');
  }
  return { x: car.position.x, z: car.position.z, heading: car.heading, speed: car.speed, phase: show.phase, donut: show.donut?.phase };
}

// ---------------------------------------------------------------------------------------------------------------------
function readTrace({ from, count }) {
  const trace = globalThis.__trace;
  if (from === 0 && count === 0) return { frames: trace.frames.length, events: trace.events };
  return trace.frames.slice(from, from + count);
}

export { clockInit, dumpMap, injectState, installProbe, readTrace };
