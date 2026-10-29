import * as THREE from 'three/webgpu';
import { color, materialEmissive, mix, vec3 } from 'three/tsl';

// The full build's swimming car: "BMW m3 competition | Hassan Visuals 3D" (Sketchfab, CC BY 4.0), prepared into
// assets/models/m3.glb by tools/prepare-m3-model.sh. The file is never committed; when it isn't there (the minimal
// build) a HEAD request answers 404 and the procedural car stays. When it is, the model takes the procedural body's
// place under the chassis pivot (so pitch, roll and heave still move it), its four wheels go on the existing steer
// pivots, its lamps follow the car's carState uniform, and the first-person cockpit moves onto its interior.

const MODEL_URL = 'assets/models/m3.glb';
// Only fetched when the model is there (through the page's import map, like the rest of three)
const LOADER_MODULES = ['three/addons/loaders/GLTFLoader.js', 'three/addons/libs/meshopt_decoder.module.js'];
// The real G80 M3's wheelbase; the model is scaled so its axles sit this far apart
const WHEELBASE = 2.86;
const WHEEL_KEYS = ['lf', 'rf', 'lr', 'rr'];
// Body paint: the procedural car's colour replaces the model's red, so both builds drive the same car
const PAINT_MATERIAL = 'Material.032';
// Glass: the model asks for transmission (an extra full-screen pass in three.js); plain alpha blending reads the same
// at driving distance
const GLASS_OPACITY = 0.32;
// Lamp groups baked by tools/build-m3-model.mjs and their emissive from the carState uniform (x brake, w reverse).
// The model's lamp textures are drawn lit; the brake lamps sit dim until the brake is on, then glow solid red.
const BRAKE_RED = 0xff1a10;
const LAMP_EMISSIVE = {
  tail_lights: () => materialEmissive.mul(0.7),
  brake_lights: (state) => mix(materialEmissive.mul(0.15), color(BRAKE_RED).mul(6), state.x),
  reverse_lights: (state) => materialEmissive.mul(state.w.mul(2.5)),
  indicators: () => vec3(0)
};
// Steering wheel: points beyond this fraction of the half-width are the rim's sides, within it its top; the rim's
// thickness (m) puts the hands on its centre line
const RIM_SIDE_BAND = 0.9;
const RIM_TOP_BAND = 0.15;
const RIM_THICKNESS = 0.03;
const STANDARD_KEYS = [
  'name', 'color', 'roughness', 'metalness', 'map', 'aoMap', 'aoMapIntensity', 'emissive', 'emissiveIntensity',
  'emissiveMap', 'normalMap', 'normalMapType', 'normalScale', 'roughnessMap', 'metalnessMap', 'alphaMap', 'opacity',
  'transparent', 'alphaTest', 'side', 'depthWrite', 'vertexColors', 'envMapIntensity'
];
const PHYSICAL_KEYS = ['clearcoat', 'clearcoatMap', 'clearcoatRoughness', 'clearcoatRoughnessMap', 'clearcoatNormalMap', 'clearcoatNormalScale', 'ior'];

// The car frame the swim car lives in: heading 0 faces +z, +x is the car's left, y = 0 is the road, and the origin is
// halfway between the axles. From the model's four wheel centres (model units, y up) and its wheel radius this returns
// the uniform scale, the yaw (about y) and the position that put the model there: car = position + R(yaw) * scale * p.
function carFrameFromWheels(wheels, wheelRadius, wheelbase = WHEELBASE) {
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
  const front = mid(wheels.lf, wheels.rf);
  const rear = mid(wheels.lr, wheels.rr);
  const forwardX = front.x - rear.x;
  const forwardZ = front.z - rear.z;
  const scale = wheelbase / Math.hypot(forwardX, forwardZ);
  // the model's forward direction is atan2(x, z) from +z; turning by its negative points it down +z
  const yaw = -Math.atan2(forwardX, forwardZ);
  const centre = mid(front, rear);
  const groundY = (front.y + rear.y) / 2 - wheelRadius;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const position = {
    x: -scale * (centre.x * cos + centre.z * sin),
    y: -scale * groundY,
    z: -scale * (-centre.x * sin + centre.z * cos)
  };
  return { scale, yaw, position };
}

// A model-space point in the car frame (three.js order: scale, then rotate about y, then translate)
function toCarFrame(frame, p) {
  const cos = Math.cos(frame.yaw), sin = Math.sin(frame.yaw);
  const x = p.x * frame.scale, y = p.y * frame.scale, z = p.z * frame.scale;
  return { x: frame.position.x + x * cos + z * sin, y: frame.position.y + y, z: frame.position.z - x * sin + z * cos };
}

// The model wheel for one of the swim car's wheels: its side (+x is the car's left) and axle
function modelWheelKey(isLeft, isFront) {
  return `${isLeft ? 'l' : 'r'}${isFront ? 'f' : 'r'}`;
}

// Whether the full build's model is there: one HEAD request, and any failure (404, offline, file://) means no
async function modelAvailable(url = MODEL_URL, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return false;
  try {
    const response = await fetchImpl(url, { method: 'HEAD', cache: 'no-store' });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

function toNodeMaterial(source) {
  const physical = Boolean(source.isMeshPhysicalMaterial);
  const target = physical ? new THREE.MeshPhysicalNodeMaterial() : new THREE.MeshStandardNodeMaterial();
  for (const key of physical ? [...STANDARD_KEYS, ...PHYSICAL_KEYS] : STANDARD_KEYS) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  return target;
}

// Every mesh in the model gets a node material; glass loses its transmission, the paint takes `paint`, lamps glow
// from carState. Materials shared between meshes stay shared.
function convertMaterials(car, carState, paint) {
  const converted = new Map();
  car.traverse((object) => {
    if (!object.isMesh) return;
    const group = object.parent?.name ?? '';
    const lamp = LAMP_EMISSIVE[group];
    const key = `${object.material.uuid}|${lamp ? group : ''}|${group.startsWith('wheel_') ? 'wheel' : ''}`;
    if (!converted.has(key)) {
      const material = toNodeMaterial(object.material);
      if (object.material.transmission > 0 || (material.transparent && material.opacity < 0.5 && !material.map)) {
        material.transparent = true;
        material.opacity = Math.min(material.opacity, GLASS_OPACITY);
        material.depthWrite = false;
      }
      // the brake calipers share the paint: they stay the model's red
      if (material.name === PAINT_MATERIAL && paint !== undefined && !group.startsWith('wheel_')) material.color.setHex(paint);
      if (lamp && carState) material.emissiveNode = lamp(carState);
      converted.set(key, material);
    }
    object.material = converted.get(key);
    const opaque = !object.material.transparent;
    object.castShadow = opaque;
    object.receiveShadow = opaque;
  });
}

// The steering wheel's grip circle from its vertices in the car frame (flat [x, y, z, ...]): the rim is the widest
// part across the car, so the points at its far left and right (9 and 3 o'clock) give the hub's height and depth and
// the radius; the highest point near the middle is 12 o'clock, and its lean from the hub is the column's rake (the
// top tipped forward, toward +z). The column and stalks hang below and in front, so they don't pull any of it.
function steeringWheelPose(points) {
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
  }
  const halfWidth = (maxX - minX) / 2;
  const centreX = (minX + maxX) / 2;
  let y = 0, z = 0, sides = 0;
  let top = null;
  for (let i = 0; i < points.length; i += 3) {
    const across = Math.abs(points[i] - centreX);
    if (across > halfWidth * RIM_SIDE_BAND) {
      y += points[i + 1];
      z += points[i + 2];
      sides++;
    } else if (across < halfWidth * RIM_TOP_BAND && (!top || points[i + 1] > top.y)) {
      top = { y: points[i + 1], z: points[i + 2] };
    }
  }
  const centre = { x: centreX, y: y / sides, z: z / sides };
  const tilt = top ? Math.atan2(top.z - centre.z, top.y - centre.y) : 0;
  return { centre, tilt, radius: halfWidth - RIM_THICKNESS / 2 };
}

// An object's vertices in its top ancestor's frame, as a flat array
function vertexPoints(object) {
  const v = new THREE.Vector3();
  const points = [];
  object.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      points.push(v.x, v.y, v.z);
    }
  });
  return points;
}

// Puts a loaded model (the glTF scene) on the swim entity. Returns the model's root, or null when it isn't a car this
// knows how to drive (no wheel or steering wheel groups from tools/build-m3-model.mjs): then the procedural car stays.
function attachSwimCarModel(entity, cockpit, gltfScene) {
  const car = gltfScene.getObjectByName('M3') ?? gltfScene;
  car.updateWorldMatrix(true, true);
  const wheels = {};
  for (const key of WHEEL_KEYS) wheels[key] = car.getObjectByName(`wheel_${key}`);
  const steering = car.getObjectByName('steering_wheel');
  if (!steering || WHEEL_KEYS.some((key) => !wheels[key])) return null;

  const box = new THREE.Box3().setFromObject(wheels.lf);
  const wheelRadius = (box.max.y - box.min.y) / 2;
  const frame = carFrameFromWheels(Object.fromEntries(WHEEL_KEYS.map((key) => [key, wheels[key].position])), wheelRadius);

  // The body: everything but the wheels, under the chassis pivot in the car frame
  const model = new THREE.Group();
  model.name = 'M3Competition';
  model.scale.setScalar(frame.scale);
  model.rotation.y = frame.yaw;
  model.position.set(frame.position.x, frame.position.y, frame.position.z);
  model.add(car);
  model.updateWorldMatrix(true, true);
  const steeringPose = steeringWheelPose(vertexPoints(steering));
  convertMaterials(car, entity.carState, entity.paint);

  // The procedural body, plates and tailpipes go; the headlight spots and the cockpit's groups stay
  for (const child of entity.chassisPivot.children) if (child.isMesh) child.visible = false;
  entity.chassisPivot.add(model);

  // Wheels: each model wheel spins inside a new tire group on the steer pivot, which moves to the model's hub
  for (const wheel of entity.wheels) {
    const key = modelWheelKey(wheel.steerPivot.position.x > 0, wheel.isFront);
    const modelWheel = wheels[key];
    const hub = toCarFrame(frame, modelWheel.position);
    const tire = new THREE.Group();
    tire.name = `M3Wheel_${key}`;
    tire.rotation.x = wheel.tire.rotation.x;
    modelWheel.position.set(0, 0, 0);
    modelWheel.rotation.y = frame.yaw;
    modelWheel.scale.setScalar(frame.scale);
    tire.add(modelWheel);
    wheel.steerPivot.remove(wheel.tire);
    wheel.steerPivot.position.set(hub.x, hub.y, hub.z);
    wheel.steerPivot.add(tire);
    wheel.tire = tire;
  }

  // First person: the cockpit's arms and camera move onto the model's own steering wheel and interior
  if (cockpit) {
    entity.mesh.updateWorldMatrix(true, true);
    const { centre, tilt, radius } = steeringPose;
    const wheelCenter = new THREE.Vector3(centre.x, centre.y, centre.z);
    cockpit.useModelCabin({ steeringWheel: steering, wheelCenter, wheelTilt: tilt, wheelRadius: radius });
  }
  return model;
}

// Loads assets/models/m3.glb when it is there and swaps it in; resolves to the model's root or null. The glTF loader
// and the meshopt decoder are only fetched in the full build.
async function loadSwimCarModel(entity, cockpit, { url = MODEL_URL, fetchImpl = globalThis.fetch } = {}) {
  if (!(await modelAvailable(url, fetchImpl))) return null;
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all(LOADER_MODULES.map((specifier) => import(specifier)));
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
  return attachSwimCarModel(entity, cockpit, gltf.scene);
}

export { MODEL_URL, WHEELBASE, carFrameFromWheels, toCarFrame, modelWheelKey, steeringWheelPose, modelAvailable, attachSwimCarModel, loadSwimCarModel };
