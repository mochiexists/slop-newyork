import * as THREE from 'three/webgpu';
import { BODY_SPECS, carLayout } from './cars.js';
import { CARELESS_WHISPER } from './swim-mode.js';

// The M5's cabin for the first-person camera: the body and glasshouse are single-sided lofts, so from the driver's
// seat they vanish and leave the hood floating in front of the road. This builds what the driver sees instead (a G90
// interior in red leather: A-pillars, headliner, dash with the curved display, door cards, seats, centre console and
// the M wheel), the driver's arms in a grey hoodie with the hands on the wheel, and F's raised middle finger. It all
// rides the swim car's chassisPivot (car frame: +z forward, +x the car's LEFT, so the driver sits at +x), hidden
// unless swimming in the cockpit camera, so the chase view pays nothing for it; only the raised arm shows outside.

const RAD = Math.PI / 180;

// The driver's eye in the car frame; cameras.js reads it as entity.povEye, and povPitch tips the view down a little so
// the wheel and the hands sit in the lower third of the frame and the road above it
const EYE = new THREE.Vector3(0.38, 1.18, -0.45);
const POV_PITCH = 0.1;

// The M steering wheel: hub position, column rake (top tipped forward), rim size; the drawn wheel turns ten times the
// front wheels' angle, up to 240° either way
const WHEEL_CENTER = new THREE.Vector3(0.38, 0.88, 0.08);
const WHEEL_TILT = 24 * RAD;
const WHEEL_RADIUS = 0.185;
const WHEEL_RIM = 0.019;
const WHEEL_RATIO = 10;
const WHEEL_MAX_TURN = 240 * RAD;
// Hands stay on the rim to this angle, then the wheel slides through them (hand-over-hand is not modelled)
const HAND_MAX_TURN = 55 * RAD;

// Arms: shoulder sockets either side of the eye, bone lengths
const SHOULDER_DROP = 0.22;
const SHOULDER_WIDTH = 0.2;
const SHOULDER_BACK = 0.05;
const UPPER_ARM = 0.3;
const FOREARM = 0.28;

// The bird (F): the left hand leaves the wheel in BIRD_TIME seconds and goes out of the driver's window. From the
// driver's seat it is the BMW short's shot: the driver looks out to the left and the arm is out at shoulder height;
// seen from outside the hand comes up above the roof line.
const BIRD_TIME = 0.35;
const BIRD_POV = new THREE.Vector3(1.02, 1.2, -0.12);
const BIRD_GLANCE = 45 * RAD; // how far the driver's look turns to the window with it
// seen from the chase camera 7 m back a life-size hand is a few pixels; it grows by this much out there
const BIRD_OUTSIDE_SCALE = 1.5;
const BIRD_WINDOW = new THREE.Vector3(1.0, 1.42, -0.4);
const BIRD_LEAN = new THREE.Vector3(0.09, 0.05, 0.02); // the shoulder, leaning into the window to get the hand high
// where the elbow bends: down and out, onto the door sill for the window
const BIRD_POLE_POV = new THREE.Vector3(1, -1, -0.2);
const BIRD_POLE_WINDOW = new THREE.Vector3(1, -1, 0.1);

// The curved display: an arc around a point behind the driver (so it bends toward them), cluster at the left end
const DISPLAY_PIVOT = new THREE.Vector3(0.38, 0, -0.78);
const DISPLAY_RADIUS = 1.21;
const DISPLAY_ARC = [15 * RAD, -26 * RAD]; // left (cluster) and right (centre screen) ends, from straight ahead
const DISPLAY_Y = [0.975, 1.095];
const DISPLAY_SIZE = [1536, 224]; // canvas pixels
const DISPLAY_REFRESH = 0.2; // s between redraws
const MPH = 2.23694;
const MAP_SCALE = 1 / 0.6; // centre-screen map, px per metre

const COLORS = {
  leather: 0x8e1712, // BMW M Fiona Red
  leatherDark: 0x5c0e0b,
  dash: 0x121214,
  trim: 0x1d1e21,
  headliner: 0x4c4c52, // M anthracite (it only ever sees the sky light: the roof shades it)
  pillar: 0x232326, // Alcantara A-pillars, in the sun
  carpet: 0x0c0c0d,
  metal: 0x8f9298,
  hoodie: 0x707072,
  cuff: 0x55575b,
  skin: 0xb77a58,
  mRed: 0xd4101e
};

function material(color, roughness = 0.7, metalness = 0) {
  return new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });
}

// A box stretched from a to b (both in the car frame), its wide face turned toward the eye
function beam(a, b, width, depth, mat) {
  const along = new THREE.Vector3().subVectors(b, a);
  const length = along.length();
  along.divideScalar(length);
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const toEye = new THREE.Vector3().subVectors(EYE, mid);
  const facing = toEye.sub(along.clone().multiplyScalar(toEye.dot(along))).normalize();
  const across = new THREE.Vector3().crossVectors(along, facing);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, length, depth), mat);
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, along, facing));
  mesh.position.copy(mid);
  return mesh;
}

function box(w, h, d, x, y, z, mat) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  return mesh;
}

// A profile in the side view ([z, y] points) extruded across the car from x0 to x1
function crossExtrusion(profile, x0, x1, mat) {
  const shape = new THREE.Shape();
  shape.moveTo(profile[0][0], profile[0][1]);
  shape.splineThru(profile.slice(1).map(([z, y]) => new THREE.Vector2(z, y)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: x1 - x0, bevelEnabled: false, curveSegments: 16 });
  // shape (u, v) and depth w -> car (x = x1 - w, y = v, z = u)
  geo.rotateY(-Math.PI / 2).translate(x1, 0, 0);
  return new THREE.Mesh(geo, mat);
}

// The body loft is closed across its top at the belt line (the glasshouse hides it from outside), which from the
// driver's seat is a painted floor at elbow height over the whole cabin. The cockpit swaps in a copy of the body without
// the upward-facing triangles inside the belt between the windshield's foot and the rear deck.
function openCabinGeometry(geometry) {
  const spec = BODY_SPECS.m5;
  const layout = carLayout(spec);
  const pos = geometry.getAttribute('position');
  const source = geometry.index ? geometry.index.array : Array.from({ length: pos.count }, (_, i) => i);
  const kept = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let i = 0; i < source.length; i += 3) {
    a.fromBufferAttribute(pos, source[i]);
    b.fromBufferAttribute(pos, source[i + 1]);
    c.fromBufferAttribute(pos, source[i + 2]);
    const z = (a.z + b.z + c.z) / 3;
    let cut = false;
    if (z < spec.cabin.cowl && z > spec.cabin.deck) {
      const x = Math.abs(a.x + b.x + c.x) / 3;
      const y = (a.y + b.y + c.y) / 3;
      const normal = ab.subVectors(b, a).cross(ac.subVectors(c, a)).normalize();
      const s = layout.body(z);
      cut = x < s.xE - 0.004 && y > s.yE - 0.12 && y < s.yT + 0.02 && Math.abs(normal.y) > 0.3;
    }
    if (!cut) kept.push(source[i], source[i + 1], source[i + 2]);
  }
  const open = geometry.clone();
  open.setIndex(kept);
  return open;
}

// The headliner: a grid hugging the inside of the roof, from the windshield header back over the front seats
function buildHeadliner(layout, mat) {
  const cab = BODY_SPECS.m5.cabin;
  const nz = 6, nx = 12;
  const positions = [];
  const index = [];
  for (let i = 0; i <= nz; i++) {
    const c = layout.cabin(THREE.MathUtils.lerp(cab.roofFront + 0.02, cab.roofRear, i / nz));
    for (let j = 0; j <= nx; j++) {
      const x = THREE.MathUtils.lerp(-c.railX, c.railX, j / nx) * 0.98;
      positions.push(x, layout.cabinTop(c, x) - 0.03, c.z);
    }
  }
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < nx; j++) {
      const a = i * (nx + 1) + j, b = a + nx + 1;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

// The display glass: an arc strip around DISPLAY_PIVOT, u = 0 at the left (cluster) end; `grow` pads it for the bezel
function buildDisplayArc(grow = 0, back = 0) {
  const segments = 24;
  const positions = [];
  const uvs = [];
  const index = [];
  const [a0, a1] = [DISPLAY_ARC[0] + grow / DISPLAY_RADIUS, DISPLAY_ARC[1] - grow / DISPLAY_RADIUS];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const angle = THREE.MathUtils.lerp(a0, a1, t);
    for (const [k, y] of [[0, DISPLAY_Y[0] - grow], [1, DISPLAY_Y[1] + grow]]) {
      // the panel leans back 8° like the real one, its top a little further away than its foot
      const r = DISPLAY_RADIUS + back + (y - DISPLAY_Y[0]) * 0.14;
      positions.push(DISPLAY_PIVOT.x + Math.sin(angle) * r, y, DISPLAY_PIVOT.z + Math.cos(angle) * r);
      uvs.push(t, k);
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

function roundelTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0d0d0f';
  ctx.beginPath();
  ctx.arc(64, 64, 63, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#b9bcc2';
  ctx.lineWidth = 3;
  ctx.stroke();
  for (let q = 0; q < 4; q++) {
    ctx.fillStyle = q % 2 ? '#f2f3f5' : '#1c69d4';
    ctx.beginPath();
    ctx.moveTo(64, 64);
    ctx.arc(64, 64, 40, -Math.PI / 2 + q * Math.PI / 2, q * Math.PI / 2);
    ctx.fill();
  }
  ctx.fillStyle = '#f2f3f5';
  ctx.font = 'bold 17px Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('B', 64, 18);
  ctx.fillText('W', 115, 70);
  ctx.fillText('M', 64, 122);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A finger bone: a capsule of total length `length` from its base along +y, or along +z / -y when `axis` says so
function phalanx(length, radius, skin, axis = 'y') {
  const geo = new THREE.CapsuleGeometry(radius, Math.max(0.001, length - radius * 2), 3, 8).translate(0, length / 2, 0);
  if (axis === 'z') geo.rotateX(Math.PI / 2);
  else if (axis === '-y') geo.rotateX(Math.PI);
  return new THREE.Mesh(geo, skin);
}

// A fist in its own frame: wrist at the origin, +y toward the knuckles, +z out of the palm, x across the knuckles.
// The middle finger has two joints that curl it into the fist (curl = 1) or stand it straight up (curl = 0).
function buildHand(skin) {
  const hand = new THREE.Group();
  hand.add(box(0.078, 0.084, 0.03, 0, 0.046, 0, skin)); // palm & back of the hand
  const knuckleY = 0.088;
  // index, ring and little finger rolled into the palm: first bones toward the palm, the rest folded down onto it
  for (const [x, scale] of [[0.027, 1], [-0.01, 0.96], [-0.029, 0.84]]) {
    const first = phalanx(0.04 * scale, 0.0105, skin, 'z');
    first.position.set(x, knuckleY, -0.004);
    const rest = phalanx(0.036 * scale, 0.0098, skin, '-y');
    rest.position.set(x, knuckleY + 0.002, 0.03 * scale);
    hand.add(first, rest);
  }
  // the thumb from the heel of the hand across the folded fingers
  const thumbBase = phalanx(0.045, 0.0125, skin);
  thumbBase.position.set(0.034, 0.012, 0.012);
  thumbBase.rotation.set(0.7, 0, 0.35);
  const thumbTip = phalanx(0.042, 0.0115, skin);
  thumbTip.position.set(0.03, 0.05, 0.043);
  thumbTip.rotation.z = Math.PI / 2;
  hand.add(thumbBase, thumbTip);

  const knuckle = new THREE.Group();
  knuckle.position.set(0.009, knuckleY, -0.002);
  knuckle.add(phalanx(0.05, 0.011, skin));
  const middle = new THREE.Group();
  middle.position.y = 0.046;
  middle.add(phalanx(0.05, 0.0102, skin));
  knuckle.add(middle);
  hand.add(knuckle);
  hand.userData.setCurl = (curl) => {
    knuckle.rotation.x = curl * Math.PI / 2;
    middle.rotation.x = curl * Math.PI / 2;
  };
  hand.userData.setCurl(1);
  return hand;
}

// Unit cylinder along +y from its base, aimed and stretched between two points every frame
function limbGeometry(radiusEnd, radiusStart) {
  return new THREE.CylinderGeometry(radiusEnd, radiusStart, 1, 10, 1).translate(0, 0.5, 0);
}

const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _bend = new THREE.Vector3();

function placeLimb(mesh, from, to) {
  _dir.subVectors(to, from);
  const length = _dir.length();
  mesh.position.copy(from);
  mesh.quaternion.setFromUnitVectors(UP, _dir.divideScalar(length || 1));
  mesh.scale.set(1, length, 1);
}

// Two-bone IK: the elbow for a shoulder and a wrist target (pulled in to the arm's reach), bent toward `pole`
function solveElbow(shoulder, target, pole, elbow) {
  _dir.subVectors(target, shoulder);
  const d = THREE.MathUtils.clamp(_dir.length(), Math.abs(UPPER_ARM - FOREARM) + 0.01, UPPER_ARM + FOREARM - 0.002);
  _dir.normalize();
  const a = (UPPER_ARM * UPPER_ARM - FOREARM * FOREARM + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - a * a));
  _bend.copy(pole).addScaledVector(_dir, -pole.dot(_dir)).normalize();
  elbow.copy(shoulder).addScaledVector(_dir, a).addScaledVector(_bend, h);
  target.copy(shoulder).addScaledVector(_dir, d);
}

class DriverArm {
  constructor(side, mats) {
    this.side = side; // +1 the driver's left arm (car +x), -1 the right
    this.group = new THREE.Group();
    this.rest = new THREE.Vector3(EYE.x + side * SHOULDER_WIDTH, EYE.y - SHOULDER_DROP, EYE.z - SHOULDER_BACK);
    this.shoulder = this.rest.clone();
    this.elbow = new THREE.Vector3();
    this.wrist = new THREE.Vector3();
    this.upper = new THREE.Mesh(limbGeometry(0.047, 0.056), mats.hoodie);
    this.fore = new THREE.Mesh(limbGeometry(0.041, 0.047), mats.hoodie);
    this.cuff = new THREE.Mesh(limbGeometry(0.043, 0.043), mats.cuff);
    this.joint = new THREE.Mesh(new THREE.SphereGeometry(0.047, 10, 8), mats.hoodie);
    this.hand = buildHand(mats.skin);
    this.group.add(this.upper, this.fore, this.cuff, this.joint, this.hand);
    this._cuffStart = new THREE.Vector3();
  }

  // Reach the wrist for `target` from the shoulder moved by `lean`, then hold the hand in `orientation` (a quaternion
  // in the car frame)
  pose(target, pole, orientation, lean) {
    this.shoulder.copy(this.rest).add(lean);
    this.wrist.copy(target);
    solveElbow(this.shoulder, this.wrist, pole, this.elbow);
    placeLimb(this.upper, this.shoulder, this.elbow);
    placeLimb(this.fore, this.elbow, this.wrist);
    this._cuffStart.lerpVectors(this.elbow, this.wrist, 0.86);
    placeLimb(this.cuff, this._cuffStart, this.wrist);
    this.joint.position.copy(this.elbow);
    this.hand.position.copy(this.wrist);
    this.hand.quaternion.copy(orientation);
  }
}

class M5Cockpit {
  constructor(entity, radio) {
    this.entity = entity;
    this.radio = radio;
    this.bird = false;
    this.birdAmount = 0;
    this.redrawTimer = 0;
    // useModelCabin() moves these onto the full build's M3 model
    this.modelCabin = false;
    this.wheelRadius = WHEEL_RADIUS;
    this.birdPov = BIRD_POV.clone();
    this.birdWindow = BIRD_WINDOW.clone();

    // cameras.js puts the cockpit camera here (in the chassis frame) instead of on the car's centre line
    entity.povEye = EYE.clone();
    entity.povPitch = POV_PITCH;

    const mats = {
      leather: material(COLORS.leather, 0.52),
      leatherDark: material(COLORS.leatherDark, 0.6),
      dash: material(COLORS.dash, 0.82),
      trim: material(COLORS.trim, 0.35, 0.35),
      headliner: material(COLORS.headliner, 0.95),
      pillar: material(COLORS.pillar, 0.95),
      carpet: material(COLORS.carpet, 1),
      metal: material(COLORS.metal, 0.3, 0.9),
      hoodie: material(COLORS.hoodie, 0.95),
      cuff: material(COLORS.cuff, 0.95),
      skin: material(COLORS.skin, 0.6),
      mRed: new THREE.MeshStandardNodeMaterial({ color: COLORS.mRed, emissive: 0x5a0006, roughness: 0.4 }),
      glossBlack: material(0x050506, 0.12, 0.2)
    };
    mats.headliner.side = THREE.DoubleSide;

    this.interior = new THREE.Group();
    this.interior.name = 'M5Cockpit';
    this.interior.visible = false;
    this.buildCabin(mats);
    this.buildWheel(mats);
    this.buildDisplay();

    this.arms = new THREE.Group();
    this.arms.name = 'M5DriverArms';
    this.arms.visible = false;
    this.leftArm = new DriverArm(1, mats);
    this.rightArm = new DriverArm(-1, mats);
    this.arms.add(this.leftArm.group, this.rightArm.group);

    // The cabin takes the roof's shadow; the arms don't (the thin sleeves shimmer with shadow acne)
    this.interior.traverse((o) => {
      if (o.isMesh) o.receiveShadow = true;
    });
    entity.chassisPivot.add(this.interior, this.arms);

    // The painted body (the mesh lit by the car's carState) and its open-topped twin for the cockpit view
    this.body = entity.chassisPivot.children.find((o) => o.isMesh && o.material?.userData?.carState === entity.carState);
    if (this.body) {
      this.shell = new THREE.Mesh(openCabinGeometry(this.body.geometry), this.body.material);
      this.shell.castShadow = this.shell.receiveShadow = true;
      this.shell.visible = false;
      entity.chassisPivot.add(this.shell);
    }

    // scratch for update()
    this._grip = new THREE.Vector3();
    this._radial = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._pole = new THREE.Vector3();
    this._lean = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._birdQuat = new THREE.Quaternion();
    this._basis = new THREE.Matrix4();
    this._axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  }

  buildCabin(mats) {
    const spec = BODY_SPECS.m5;
    const cab = spec.cabin;
    const layout = carLayout(spec);
    const g = this.interior;
    const cowl = layout.cabin(cab.cowl);
    const header = layout.cabin(cab.roofFront);

    // A-pillars along the windshield's edges, a touch inside the glass
    for (const side of [-1, 1]) {
      const foot = new THREE.Vector3(side * (cowl.beltX - 0.05), cowl.beltY - 0.01, cab.cowl - 0.04);
      const top = new THREE.Vector3(side * (header.railX - 0.04), header.railY + 0.01, cab.roofFront - 0.02);
      g.add(beam(foot, top, 0.095, 0.05, mats.pillar));
    }

    // Headliner, the windshield header and the rear-view mirror on its stalk
    g.add(buildHeadliner(layout, mats.headliner));
    const headerY = layout.cabinTop(header, 0) - 0.07;
    g.add(box(header.railX * 2 - 0.06, 0.055, 0.11, 0, headerY, cab.roofFront - 0.05, mats.headliner));
    for (const side of [-1, 1]) {
      // sun visors folded up against the headliner
      g.add(box(0.34, 0.025, 0.17, side * 0.36, headerY - 0.03, cab.roofFront - 0.14, mats.headliner));
    }
    g.add(box(0.03, 0.06, 0.03, 0, headerY - 0.05, cab.roofFront - 0.03, mats.trim));
    const mirror = box(0.27, 0.075, 0.03, 0, headerY - 0.1, cab.roofFront - 0.05, mats.glossBlack);
    mirror.rotation.y = -8 * RAD; // turned toward the driver
    g.add(mirror);

    // Dashboard: side profile from the windshield's foot, over the top, down the face to the knee bolster
    const dash = crossExtrusion([
      [0.78, 0.9], [0.66, 0.965], [0.5, 0.982], [0.42, 0.968], [0.37, 0.93], [0.345, 0.84], [0.35, 0.68],
      [0.43, 0.5], [0.78, 0.5]
    ], -0.86, 0.86, mats.dash);
    g.add(dash);
    // the light bar across the dash face and the trim strip under it
    const glow = new THREE.MeshBasicNodeMaterial({ color: 0x8a2a1c });
    g.add(box(1.5, 0.003, 0.004, 0, 0.882, 0.349, glow));
    g.add(box(1.62, 0.03, 0.02, 0, 0.86, 0.352, mats.trim));
    g.add(box(0.62, 0.012, 0.012, -0.5, 0.842, 0.352, mats.metal));
    // the red leather lower dash either side of the centre stack, under the trim
    g.add(box(0.67, 0.13, 0.014, -0.525, 0.765, 0.342, mats.leather));
    g.add(box(0.71, 0.13, 0.014, 0.505, 0.765, 0.342, mats.leather));

    // Centre stack under the screen: the slim vents and the climate strip
    g.add(box(0.32, 0.22, 0.08, -0.02, 0.79, 0.31, mats.dash));
    g.add(box(0.3, 0.2, 0.006, -0.02, 0.79, 0.268, mats.glossBlack));
    for (const y of [0.87, 0.85]) g.add(box(0.26, 0.006, 0.006, -0.02, y, 0.263, mats.trim));
    g.add(box(0.24, 0.028, 0.006, -0.02, 0.77, 0.263, mats.metal));
    // vents either end of the dash
    for (const x of [0.74, -0.74]) g.add(box(0.14, 0.04, 0.012, x, 0.9, 0.36, mats.glossBlack));

    // Centre console with the gear selector and the iDrive controller, running back between the seats
    g.add(box(0.26, 0.2, 1.05, 0, 0.5, -0.2, mats.dash));
    g.add(box(0.22, 0.02, 0.9, 0, 0.61, -0.2, mats.trim));
    g.add(box(0.26, 0.08, 0.4, 0, 0.64, -0.6, mats.leather)); // armrest
    g.add(box(0.04, 0.05, 0.07, 0, 0.645, 0.0, mats.glossBlack)); // selector
    g.add(box(0.012, 0.012, 0.03, 0, 0.675, 0.005, mats.mRed));
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.032, 0.025, 20), mats.metal);
    knob.position.set(0, 0.63, -0.14);
    g.add(knob);

    // Floor, firewall
    g.add(box(1.7, 0.02, 2.4, 0, 0.3, -0.4, mats.carpet));
    g.add(box(1.7, 0.22, 0.02, 0, 0.4, 0.8, mats.carpet));

    // Door cards: black upper, red leather insert and armrest, the window sill on top
    for (const side of [-1, 1]) {
      const x = side * 0.86;
      g.add(box(0.03, 0.5, 1.3, x, 0.69, 0.08, mats.dash));
      g.add(box(0.02, 0.26, 1.0, x - side * 0.02, 0.77, 0.08, mats.leather));
      g.add(box(0.08, 0.05, 0.6, x - side * 0.05, 0.66, -0.12, mats.leather));
      g.add(box(0.085, 0.03, 1.3, x - side * 0.035, 0.935, 0.08, mats.dash));
      g.add(box(0.006, 0.008, 1.2, x - side * 0.075, 0.92, 0.08, mats.metal));
      g.add(box(0.01, 0.03, 0.1, x - side * 0.03, 0.82, 0.42, mats.metal)); // door pull
    }

    // Front seats: red bolsters, darker centres, headrests (mostly seen from outside and in the mirrors)
    for (const x of [EYE.x, -EYE.x]) {
      const seat = new THREE.Group();
      seat.position.set(x, 0.42, -0.62);
      seat.add(box(0.52, 0.12, 0.52, 0, 0.06, 0, mats.leather));
      const back = new THREE.Group();
      back.position.set(0, 0.1, -0.24);
      back.rotation.x = -14 * RAD;
      back.add(box(0.54, 0.66, 0.12, 0, 0.33, 0, mats.leather));
      back.add(box(0.3, 0.56, 0.02, 0, 0.3, 0.065, mats.leatherDark));
      back.add(box(0.27, 0.2, 0.11, 0, 0.8, -0.01, mats.leather));
      seat.add(back);
      g.add(seat);
    }
  }

  buildWheel(mats) {
    const mount = new THREE.Group();
    mount.position.copy(WHEEL_CENTER);
    mount.rotation.x = WHEEL_TILT;
    this.interior.add(mount);
    // the column into the dash
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.32, 14).rotateX(Math.PI / 2), mats.dash);
    column.position.z = 0.19;
    mount.add(column);

    // The rim, hub and spokes turn; the wheel's face looks back at the driver (-z)
    const spin = new THREE.Group();
    mount.add(spin);
    const rimMat = material(0x101012, 0.85);
    spin.add(new THREE.Mesh(new THREE.TorusGeometry(WHEEL_RADIUS, WHEEL_RIM, 12, 56), rimMat));
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.078, 0.055, 28).rotateX(Math.PI / 2), mats.dash);
    spin.add(hub);
    const roundel = new THREE.Mesh(new THREE.CircleGeometry(0.022, 28), new THREE.MeshStandardNodeMaterial({ map: roundelTexture(), roughness: 0.3 }));
    roundel.position.z = -0.029;
    roundel.rotation.y = Math.PI;
    spin.add(roundel);
    const spokeMat = material(0x242529, 0.45, 0.3);
    for (const side of [-1, 1]) {
      // side spokes with their button pads, an M1 / M2 key in M red at the top outer corner, a silver lower edge
      spin.add(box(0.12, 0.052, 0.024, side * 0.118, -0.01, -0.004, spokeMat));
      spin.add(box(0.115, 0.005, 0.026, side * 0.118, -0.037, -0.004, mats.metal));
      spin.add(box(0.022, 0.013, 0.01, side * 0.122, 0.022, -0.017, mats.mRed));
      // the split lower spoke
      const lower = box(0.018, 0.12, 0.02, side * 0.026, -0.12, -0.002, spokeMat);
      lower.rotation.z = side * 12 * RAD;
      spin.add(lower);
      // shift paddles behind the rim
      spin.add(box(0.05, 0.075, 0.008, side * 0.165, 0.035, 0.035, mats.trim));
    }
    this.wheelMount = mount;
    this.wheelSpin = spin;
  }

  buildDisplay() {
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = DISPLAY_SIZE;
    this.ctx = canvas.getContext('2d');
    this.screenTexture = new THREE.CanvasTexture(canvas);
    this.screenTexture.colorSpace = THREE.SRGBColorSpace;
    this.screenTexture.anisotropy = 8;
    // unlit: the screen glows the same at noon and at midnight
    const screen = new THREE.Mesh(buildDisplayArc(), new THREE.MeshBasicNodeMaterial({ map: this.screenTexture, side: THREE.DoubleSide }));
    const bezel = new THREE.Mesh(buildDisplayArc(0.01, 0.006), new THREE.MeshStandardNodeMaterial({ color: 0x050506, roughness: 0.2, side: THREE.DoubleSide }));
    this.interior.add(screen, bezel);
    this.drawDisplay();
  }

  // The full build's M3 model (m3-model.js) brings its own interior and steering wheel: the procedural cabin stays
  // hidden, the model's wheel turns in a new mount at its own hub and rake, and the driver (eye, shoulders, the bird's
  // targets) moves by the same offset as the wheel, so the hands still grip the rim
  useModelCabin({ steeringWheel, wheelCenter, wheelTilt, wheelRadius }) {
    const offset = new THREE.Vector3().subVectors(wheelCenter, WHEEL_CENTER);
    this.entity.povEye.copy(EYE).add(offset);
    for (const arm of [this.leftArm, this.rightArm]) arm.rest.add(offset);
    this.birdPov.add(offset);
    this.birdWindow.add(offset);

    const mount = new THREE.Group();
    mount.name = 'M3SteeringMount';
    mount.position.copy(wheelCenter);
    mount.rotation.x = wheelTilt;
    const spin = new THREE.Group();
    mount.add(spin);
    this.entity.chassisPivot.add(mount);
    mount.updateWorldMatrix(true, true);
    spin.attach(steeringWheel);
    this.wheelMount = mount;
    this.wheelSpin = spin;
    this.wheelRadius = wheelRadius;

    // the model's body is closed and has a real cabin: no open-topped shell to swap in
    if (this.shell) this.shell.visible = false;
    this.shell = null;
    this.body = null;
    this.modelCabin = true;
  }

  toggleBird() {
    this.bird = !this.bird;
  }

  // swimming: the swim mode is active; cockpit: the camera is the first-person preset
  update(dt, swimming, cockpit) {
    const inside = swimming && cockpit;
    this.interior.visible = inside && !this.modelCabin;
    if (this.shell) {
      this.shell.visible = inside;
      this.body.visible = !inside;
    }
    if (!swimming) this.bird = false;
    // F, or the AI show giving the cop the bird (swim-show.js)
    const raising = this.bird || Boolean(this.entity.showBird);
    this.birdAmount = THREE.MathUtils.clamp(this.birdAmount + (raising ? dt : -dt) / BIRD_TIME, 0, 1);
    if (!swimming) this.birdAmount = 0;
    // From the seat the driver looks out of the window at whoever it's for (less if already looking that way)
    const eased = this.birdAmount * this.birdAmount * (3 - 2 * this.birdAmount);
    this.entity.povGlance = inside ? eased * Math.max(0, BIRD_GLANCE - (this.entity.povYaw ?? 0)) : 0;
    // From outside only the raised arm shows (out of the window); the hands on the wheel are under the roof
    this.arms.visible = inside || (swimming && this.birdAmount > 0);
    this.rightArm.group.visible = inside;
    if (!this.arms.visible) return;

    const c = this.entity;
    const turn = THREE.MathUtils.clamp(c.steerAngle * WHEEL_RATIO, -WHEEL_MAX_TURN, WHEEL_MAX_TURN);
    // + steerAngle turns left: counter-clockwise as the driver sees it, which is -z about the wheel's axis here
    this.wheelSpin.rotation.z = -turn;
    this.wheelMount.updateMatrix();
    const handTurn = THREE.MathUtils.clamp(turn, -HAND_MAX_TURN, HAND_MAX_TURN);
    this.poseArm(this.rightArm, handTurn, 0, inside);
    const amount = this.birdAmount;
    this.poseArm(this.leftArm, handTurn, amount * amount * (3 - 2 * amount), inside);

    if (inside) {
      this.redrawTimer -= dt;
      if (this.redrawTimer <= 0) {
        this.redrawTimer = DISPLAY_REFRESH;
        this.drawDisplay();
      }
    }
  }

  // Hands grip the rim at 9 (left arm) and 3 o'clock, turned with the wheel; `lift` (0-1) takes the left one up to
  // the bird, at the windshield from the cockpit camera or out of the window from outside
  poseArm(arm, handTurn, lift, inside) {
    const [x, y, z] = this._axes;
    // grip point and hand frame in the wheel's own frame, then into the car's
    const angle = (arm.side > 0 ? 0 : Math.PI) - handTurn;
    const radial = this._radial.set(Math.cos(angle), Math.sin(angle), 0);
    this._grip.copy(radial).multiplyScalar(this.wheelRadius).applyMatrix4(this.wheelMount.matrix);
    const toCar = this.wheelMount.quaternion;
    y.set(0, 0, 1).applyQuaternion(toCar); // knuckles point along the column, away from the driver
    z.copy(radial).negate().applyQuaternion(toCar); // palm toward the hub
    x.crossVectors(y, z);
    this._quat.setFromRotationMatrix(this._basis.makeBasis(x, y, z));
    // the fist closes around the rim a little ahead of the wrist
    this._target.copy(this._grip).addScaledVector(y, -0.07).addScaledVector(z, -0.028);
    this._pole.set(arm.side * 0.7, -1, -0.2);
    this._lean.set(0, 0, 0);
    let curl = 1;

    if (lift > 0) {
      const raised = inside ? this.birdPov : this.birdWindow;
      // finger up, the back of the hand to whoever it's for: out to the left from the seat (the driver sees the
      // palm), or (from outside) the car behind
      y.set(0, 1, 0);
      if (inside) z.set(-1, 0, 0);
      else z.set(0, 0, 1);
      x.crossVectors(y, z);
      this._birdQuat.setFromRotationMatrix(this._basis.makeBasis(x, y, z));
      this._quat.slerp(this._birdQuat, lift);
      this._target.lerp(raised, lift);
      this._target.y += Math.sin(lift * Math.PI) * 0.05;
      this._pole.lerp(inside ? BIRD_POLE_POV : BIRD_POLE_WINDOW, lift);
      this._lean.copy(BIRD_LEAN).multiplyScalar(lift);
      curl = 1 - THREE.MathUtils.smoothstep(lift, 0.5, 1);
    }
    arm.pose(this._target, this._pole, this._quat, this._lean);
    arm.hand.userData.setCurl(curl);
    arm.hand.scale.setScalar(inside ? 1 : 1 + (BIRD_OUTSIDE_SCALE - 1) * lift);
  }

  drawDisplay() {
    const ctx = this.ctx;
    const [W, H] = DISPLAY_SIZE;
    const split = Math.round(W * 0.43); // cluster | centre screen
    const c = this.entity;
    ctx.fillStyle = '#04060a';
    ctx.fillRect(0, 0, W, H);

    // --- Instrument cluster: tach bar along the top, speed in the middle, gear and the M drive mode beside it
    const mph = Math.abs(c.speed) * MPH;
    const stopped = Math.abs(c.speed) < 0.3;
    let gear = `M${Math.min(8, 1 + Math.floor(mph / 22))}`;
    if (c.speed < -0.2) gear = 'R';
    else if (stopped) gear = 'N';
    // no gearbox is simulated: the revs climb through 22 mph bands, and wheelspin flares them
    const spin = Math.min(1, (c.drift?.wheelspin ?? 0) * 0.08);
    const rpm = stopped ? 0.11 + spin * 0.6 : Math.min(1, 0.28 + ((mph % 22) / 22) * 0.62 + spin * 0.4);
    const barX = 70, barY = 34, barW = split - 140, barH = 16;
    ctx.fillStyle = '#151a22';
    ctx.fillRect(barX, barY, barW, barH);
    const fill = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    fill.addColorStop(0, '#2f7cf6');
    fill.addColorStop(0.72, '#9cc2ff');
    fill.addColorStop(0.86, '#ff3b30');
    ctx.fillStyle = fill;
    ctx.fillRect(barX, barY, barW * rpm, barH);
    ctx.fillStyle = 'rgba(255,59,48,0.5)';
    ctx.fillRect(barX + barW * 0.86, barY + barH + 4, barW * 0.14, 3);
    ctx.fillStyle = '#7d8796';
    ctx.font = '600 15px Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    for (let i = 0; i <= 7; i++) ctx.fillText(String(i), barX + (barW * i) / 7, barY + barH + 22);

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 92px Helvetica, Arial, sans-serif';
    ctx.fillText(String(Math.round(mph)), split * 0.5, 172);
    ctx.fillStyle = '#9aa4b2';
    ctx.font = '500 20px Helvetica, Arial, sans-serif';
    ctx.fillText('mph', split * 0.5, 202);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 44px Helvetica, Arial, sans-serif';
    ctx.fillText(gear, 70, 168);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ff3b30';
    ctx.font = 'italic 700 26px Helvetica, Arial, sans-serif';
    ctx.fillText('M', split - 70, 140);
    ctx.fillStyle = '#9aa4b2';
    ctx.font = '600 16px Helvetica, Arial, sans-serif';
    ctx.fillText('SPORT PLUS', split - 70, 166);
    // the M colours along the cluster's foot
    for (const [i, color] of ['#2f7cf6', '#1b2a8a', '#e32219'].entries()) {
      ctx.fillStyle = color;
      ctx.fillRect(split - 160 + i * 30, 186, 26, 5);
    }

    // a hairline seam between the two halves
    ctx.fillStyle = '#10141c';
    ctx.fillRect(split, 0, 3, H);

    // --- Centre screen: the clock, then what's playing or the map
    const x0 = split + 26, x1 = W - 26;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#c9d1dc';
    ctx.font = '500 18px Helvetica, Arial, sans-serif';
    const now = new Date();
    ctx.fillText(`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`, x1, 30);
    ctx.textAlign = 'left';
    if (this.radio?.card?.dataset.status === 'playing') this.drawNowPlaying(ctx, x0, x1, H);
    else this.drawMap(ctx, x0, x1, H);
    this.screenTexture.needsUpdate = true;
  }

  drawNowPlaying(ctx, x0, x1, H) {
    const art = 150;
    const top = (H - art) / 2 + 6;
    // cover art: an 80s dusk gradient with a sax-gold sun
    const grad = ctx.createLinearGradient(0, top, 0, top + art);
    grad.addColorStop(0, '#2a1b5e');
    grad.addColorStop(0.55, '#c2357a');
    grad.addColorStop(1, '#f7a541');
    ctx.fillStyle = grad;
    ctx.fillRect(x0, top, art, art);
    ctx.fillStyle = 'rgba(255,226,140,0.9)';
    ctx.beginPath();
    ctx.arc(x0 + art / 2, top + art * 0.66, art * 0.22, Math.PI, 0);
    ctx.fill();

    const tx = x0 + art + 30;
    ctx.fillStyle = '#7fb2ff';
    ctx.font = '600 18px Helvetica, Arial, sans-serif';
    ctx.fillText('NOW PLAYING', tx, top + 22);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 44px Helvetica, Arial, sans-serif';
    ctx.fillText(CARELESS_WHISPER.title, tx, top + 72);
    ctx.fillStyle = '#b8c2d0';
    ctx.font = '500 26px Helvetica, Arial, sans-serif';
    ctx.fillText(CARELESS_WHISPER.artist, tx, top + 106);

    const player = this.radio.player;
    const time = Number(player?.getCurrentTime?.()) || 0;
    const duration = Number(player?.getDuration?.()) || 0;
    const barW = x1 - tx;
    const by = top + 130;
    ctx.fillStyle = '#2a313c';
    ctx.fillRect(tx, by, barW, 6);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(tx, by, duration > 0 ? barW * Math.min(1, time / duration) : 0, 6);
    const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    ctx.fillStyle = '#8b95a3';
    ctx.font = '500 16px Helvetica, Arial, sans-serif';
    ctx.fillText(clock(time), tx, by + 26);
    ctx.textAlign = 'right';
    ctx.fillText(duration > 0 ? `-${clock(duration - time)}` : '', x1, by + 26);
    ctx.textAlign = 'left';
  }

  // A minimal map: the street grid turning with the car, the route straight on, the car's arrow
  drawMap(ctx, x0, x1, H) {
    const c = this.entity;
    const w = x1 - x0;
    const cx = x0 + w * 0.62, cy = H * 0.66;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 8, w, H - 16);
    ctx.clip();
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(x0, 8, w, H - 16);
    ctx.translate(cx, cy);
    ctx.rotate(c.heading);
    // Manhattan's blocks, ~80 m between streets and ~260 m between avenues, at MAP_SCALE px per metre
    const px = c.position.x * MAP_SCALE, pz = c.position.z * MAP_SCALE;
    const streetStep = 80 * MAP_SCALE, aveStep = 260 * MAP_SCALE;
    ctx.strokeStyle = '#1e2a3d';
    ctx.lineWidth = 10;
    for (let k = -8; k <= 8; k++) {
      const z = Math.round(pz / streetStep) * streetStep + k * streetStep - pz;
      ctx.beginPath();
      ctx.moveTo(-1200, z);
      ctx.lineTo(1200, z);
      ctx.stroke();
    }
    ctx.lineWidth = 16;
    for (let k = -4; k <= 4; k++) {
      const x = Math.round(px / aveStep) * aveStep + k * aveStep - px;
      ctx.beginPath();
      ctx.moveTo(-x, -1200);
      ctx.lineTo(-x, 1200);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = '#3d8bff';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, 10);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 16);
    ctx.lineTo(cx + 11, cy + 12);
    ctx.lineTo(cx, cy + 6);
    ctx.lineTo(cx - 11, cy + 12);
    ctx.closePath();
    ctx.fill();
    // next-turn card
    ctx.fillStyle = 'rgba(12,18,30,0.92)';
    ctx.fillRect(x0 + 16, 22, 300, 92);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 40px Helvetica, Arial, sans-serif';
    ctx.fillText('↑', x0 + 32, 82);
    ctx.font = '600 28px Helvetica, Arial, sans-serif';
    ctx.fillText('Straight on', x0 + 80, 64);
    ctx.fillStyle = '#9aa4b2';
    ctx.font = '500 20px Helvetica, Arial, sans-serif';
    ctx.fillText('Manhattan · no destination', x0 + 80, 94);
  }
}

export { M5Cockpit };
