// Turns the Sketchfab glTF of "BMW m3 competition | Hassan Visuals 3D" (CC BY 4.0) into assets/models/m3.glb for
// js/m3-model.js. Run through tools/prepare-m3-model.sh, which installs the gltf-transform libraries next to a copy of
// this file. Usage: node build-m3-model.mjs <scene.gltf> <out.glb>
//
// The download is a game-ripped car: every part is a skinned mesh rigidly bound to a bone (doors, seats, lamps,
// steering wheel), the right-hand wheels are a mirrored copy of the left ones and there are ~660k triangles. This bakes
// the bones into plain static meshes, groups them by what the game needs to drive (wheels, steering wheel, lamps), then
// joins, simplifies and compresses: meshopt geometry (EXT_meshopt_compression) and WebP textures.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, join, meshopt, prune, simplifyPrimitive, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node build-m3-model.mjs <scene.gltf> <out.glb>');
  process.exit(2);
}

// Bone (or wheel node) name -> group in the output. Bones not listed land in 'body'.
const BONE_GROUPS = {
  steeringwheel: 'steering_wheel',
  brakelight_l: 'brake_lights',
  brakelight_r: 'brake_lights',
  brakelight_m: 'brake_lights',
  reversinglight_l: 'reverse_lights',
  reversinglight_r: 'reverse_lights',
  indicator_lr: 'indicators',
  indicator_rr: 'indicators',
  taillight_l: 'tail_lights',
  taillight_r: 'tail_lights'
};
// The game mirrors the left wheels for the right side: the copy under 'pbbmwm3.001' is the right-hand pair
const WHEEL_NODES = {
  'wheel_lf.child': 'wheel_lf',
  'wheel_lr.child': 'wheel_lr',
  'wheel_lf.child.001': 'wheel_rf',
  'wheel_lr.child.001': 'wheel_rr'
};
// Lamp groups get their own copies of the (shared) lamp materials so the runtime can switch them on and off
const LAMP_GROUPS = new Set(['brake_lights', 'reverse_lights', 'indicators', 'tail_lights']);
// Fraction of triangles kept per group, and the simplifier's error bound (relative to the mesh's size)
const SIMPLIFY = {
  body: { ratio: 0.22, error: 0.003 },
  steering_wheel: { ratio: 0.25, error: 0.002 },
  wheel: { ratio: 0.14, error: 0.004 },
  lamp: { ratio: 0.5, error: 0.001 }
};
const TEXTURE_SIZE = 1024;
const WEBP_QUALITY = 72;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder
});
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;

const document = await io.read(input);
const root = document.getRoot();

// --- small column-major 4x4 helpers (glTF's layout)
function multiply(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}
function determinant3(m) {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
}
function transformPoint(m, p, out) {
  out[0] = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  out[1] = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  out[2] = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
}
// Normals by the matrix's linear part, renormalised (the bones only rotate, scale uniformly and mirror)
function transformNormal(m, n, out) {
  const x = m[0] * n[0] + m[4] * n[1] + m[8] * n[2];
  const y = m[1] * n[0] + m[5] * n[1] + m[9] * n[2];
  const z = m[2] * n[0] + m[6] * n[1] + m[10] * n[2];
  const length = Math.hypot(x, y, z) || 1;
  out[0] = x / length;
  out[1] = y / length;
  out[2] = z / length;
}

function boneKey(name) {
  return name.replace(/_\d+_\d+$/, '');
}

function wheelGroupOf(node) {
  for (let n = node; n; n = n.getParentNode()) {
    const group = WHEEL_NODES[boneKey(n.getName())];
    if (group) return { group, hub: n };
  }
  return null;
}

// The vertex -> world matrix of a primitive: the node's world matrix, or for a skinned mesh the weighted bones
function vertexMatrices(node, prim) {
  const skin = node.getSkin();
  const count = prim.getAttribute('POSITION').getCount();
  if (!skin) {
    const world = node.getWorldMatrix();
    return { at: () => world, dominantBone: null, count };
  }
  const joints = skin.listJoints();
  const inverseBind = skin.getInverseBindMatrices();
  const boneMatrices = joints.map((joint, i) => multiply(joint.getWorldMatrix(), inverseBind.getElement(i, new Array(16))));
  const J = prim.getAttribute('JOINTS_0');
  const W = prim.getAttribute('WEIGHTS_0');
  const j = [0, 0, 0, 0];
  const w = [0, 0, 0, 0];
  const weightByBone = new Map();
  const blended = new Array(16);
  const at = (i) => {
    J.getElement(i, j);
    W.getElement(i, w);
    blended.fill(0);
    for (let k = 0; k < 4; k++) {
      if (w[k] === 0) continue;
      const m = boneMatrices[j[k]];
      for (let e = 0; e < 16; e++) blended[e] += m[e] * w[k];
    }
    return blended;
  };
  for (let i = 0; i < count; i++) {
    J.getElement(i, j);
    W.getElement(i, w);
    for (let k = 0; k < 4; k++) {
      if (w[k] > 0) weightByBone.set(j[k], (weightByBone.get(j[k]) || 0) + w[k]);
    }
  }
  const top = [...weightByBone.entries()].sort((a, b) => b[1] - a[1])[0];
  return { at, dominantBone: top ? boneKey(joints[top[0]].getName()) : null, count };
}

// Texture coordinate sets a material reads; the rest (the game's lightmap and damage channels) are dropped
function usedTexCoords(material) {
  const used = new Set([0]);
  if (!material) return used;
  for (const info of [
    material.getBaseColorTextureInfo(), material.getEmissiveTextureInfo(), material.getNormalTextureInfo(),
    material.getMetallicRoughnessTextureInfo(), material.getOcclusionTextureInfo()
  ]) {
    if (info) used.add(info.getTexCoord());
  }
  return used;
}

const lampMaterials = new Map();
function lampMaterial(material, group) {
  const key = `${material.getName()}@${group}`;
  if (!lampMaterials.has(key)) lampMaterials.set(key, material.clone().setName(key));
  return lampMaterials.get(key);
}

// --- 1. Bake every mesh into the scene's world frame, one output node per source mesh node, grouped
const meshNodes = root.listNodes().filter((node) => node.getMesh());
const car = document.createNode('M3');
const groups = new Map();
function groupNode(name, translation = [0, 0, 0]) {
  if (!groups.has(name)) {
    const node = document.createNode(name).setTranslation(translation);
    car.addChild(node);
    groups.set(name, node);
  }
  return groups.get(name);
}

const counts = new Map();
for (const node of meshNodes) {
  const wheel = wheelGroupOf(node);
  const hubCentre = wheel ? wheel.hub.getWorldTranslation() : [0, 0, 0];
  const bakedMesh = document.createMesh(node.getMesh().getName());
  let group = null;
  for (const prim of node.getMesh().listPrimitives()) {
    const matrices = vertexMatrices(node, prim);
    group = wheel ? wheel.group : BONE_GROUPS[matrices.dominantBone] || 'body';

    const baked = prim.clone();
    for (const semantic of baked.listSemantics()) {
      const keep = semantic === 'POSITION' || semantic === 'NORMAL' ||
        (semantic.startsWith('TEXCOORD_') && usedTexCoords(prim.getMaterial()).has(Number(semantic.slice(9))));
      if (!keep) baked.setAttribute(semantic, null);
    }
    const position = prim.getAttribute('POSITION').clone();
    const normal = prim.getAttribute('NORMAL')?.clone();
    const p = [0, 0, 0], n = [0, 0, 0], out = [0, 0, 0];
    let mirrored = false;
    for (let i = 0; i < matrices.count; i++) {
      const m = matrices.at(i);
      if (i === 0) mirrored = determinant3(m) < 0;
      position.getElement(i, p);
      transformPoint(m, p, out);
      out[0] -= hubCentre[0];
      out[1] -= hubCentre[1];
      out[2] -= hubCentre[2];
      position.setElement(i, out);
      if (normal) {
        normal.getElement(i, n);
        transformNormal(m, n, out);
        normal.setElement(i, out);
      }
    }
    baked.setAttribute('POSITION', position);
    if (normal) baked.setAttribute('NORMAL', normal);
    if (mirrored) {
      // a mirroring matrix turns the triangles inside out: swap two corners of each
      const indices = prim.getIndices().clone();
      const array = indices.getArray();
      for (let t = 0; t < array.length; t += 3) [array[t + 1], array[t + 2]] = [array[t + 2], array[t + 1]];
      indices.setArray(array);
      baked.setIndices(indices);
    }
    if (LAMP_GROUPS.has(group) && prim.getMaterial()) baked.setMaterial(lampMaterial(prim.getMaterial(), group));
    bakedMesh.addPrimitive(baked);
    counts.set(group, (counts.get(group) || 0) + (prim.getIndices().getCount() / 3));
  }
  if (!bakedMesh.listPrimitives().length) {
    bakedMesh.dispose();
    continue;
  }
  groupNode(group, wheel ? hubCentre : [0, 0, 0]).addChild(document.createNode(node.getName()).setMesh(bakedMesh));
}

// The specular extension only carries flat single-colour maps here: drop it and its textures
for (const extension of root.listExtensionsUsed()) {
  if (extension.extensionName === 'KHR_materials_specular') extension.dispose();
}

// Replace the game's scene (bones, skins, mod-kit dummies) with the baked car
const scene = document.createScene('M3').addChild(car);
for (const old of root.listScenes()) if (old !== scene) old.dispose();
root.setDefaultScene(scene);
for (const skin of root.listSkins()) skin.dispose();
const kept = new Set([car, ...car.listChildren(), ...car.listChildren().flatMap((g) => g.listChildren())]);
for (const node of root.listNodes()) if (!kept.has(node)) node.dispose();
console.log('baked triangles by group:', Object.fromEntries([...counts].map(([k, v]) => [k, Math.round(v)])));

// --- 2. Merge, simplify, compress
await document.transform(dedup({ keepUniqueNames: true }), prune(), join({ keepNamed: false }), weld());

let before = 0, after = 0;
for (const group of car.listChildren()) {
  const name = group.getName();
  let settings = SIMPLIFY.body;
  if (name.startsWith('wheel_')) settings = SIMPLIFY.wheel;
  else if (name === 'steering_wheel') settings = SIMPLIFY.steering_wheel;
  else if (LAMP_GROUPS.has(name)) settings = SIMPLIFY.lamp;
  for (const child of group.listChildren()) {
    for (const prim of child.getMesh()?.listPrimitives() ?? []) {
      const triangles = prim.getIndices().getCount() / 3;
      before += triangles;
      // tiny parts (badges, bolts, lamp lenses) keep their shape
      if (triangles > 200) simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ...settings });
      after += prim.getIndices().getCount() / 3;
    }
  }
}
console.log(`simplified ${Math.round(before)} -> ${Math.round(after)} triangles`);

await document.transform(
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', quality: WEBP_QUALITY, resize: [TEXTURE_SIZE, TEXTURE_SIZE] }),
  meshopt({ encoder: MeshoptEncoder, level: 'high' })
);

// Credit travels with the file
document.getRoot().getAsset().extras = {
  title: 'BMW M3 Competition | Hassan Visuals 3D',
  author: 'Hassan Visuals 3D (https://sketchfab.com/HassanVisuals3D)',
  license: 'CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)',
  source: 'https://sketchfab.com/3d-models/bmw-m3-competition-hassan-visuals-3d-5fd8bc8cc7394f959e21086624fbc66b',
  modified: 'baked, simplified and compressed by tools/prepare-m3-model.sh'
};

await io.write(output, document);
const groupsOut = car.listChildren().map((g) => `${g.getName()}(${g.listChildren().reduce((s, c) => s + (c.getMesh()?.listPrimitives().length ?? 0), 0)})`);
console.log(`wrote ${output}: groups ${groupsOut.join(' ')}; ${root.listMaterials().length} materials, ${root.listTextures().length} textures`);
