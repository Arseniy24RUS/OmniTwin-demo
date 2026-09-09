/** Reproducible CC0 actor import. No local model run or commercial API is used. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
import { inflateSync } from 'node:zlib';
import { normalizeActorFrames } from './normalize.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cache = resolve(root, '.cache/game-actor-sources-v1');
const output = resolve(root, 'apps/web/public/assets/game-actors-v1');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
globalThis.ProgressEvent ??= class ProgressEvent { constructor(type, props) { this.type = type; Object.assign(this, props); } };
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
await MeshoptSimplifier.ready;
const sources = [];
async function download(name, url, sourcePage) {
  const path = resolve(cache, name);
  let bytes;
  try { bytes = await readFile(path); }
  catch { const response = await fetch(url); if (!response.ok) throw Error(`Download ${name}: ${response.status}`); bytes = Buffer.from(await response.arrayBuffer()); await writeFile(path, bytes); }
  sources.push({ name, url, sourcePage, sha256: sha(bytes), bytes: bytes.length, license: 'CC0-1.0' });
  return bytes;
}
const people = [
  ['casual-man', '1Jn7kULNmrtqP8BUUL19h8MhbdOnwPFhv', 'ultimatemodularcharacters'],
  ['casual-woman', '18b3WwlrwrFYWAM7BcnjWeIxKJyxAQiGh', 'ultimatemodularwomen'],
  ['suit-man', '1NhXHnGU0zK9hBrT5FoZp8nTz_EmvTPg5', 'ultimatemodularcharacters'],
  ['worker-woman', '1iwF_fqDErPH9uyol6NmS-MnzGgsZ5ejV', 'ultimatemodularwomen'],
];
const loader = new GLTFLoader();
const models = [];
const chunks = [];
let byteOffset = 0;
function append(array) {
  const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const entry = { byteOffset, byteLength: bytes.length, count: array.length, type: array.constructor.name };
  chunks.push(bytes); byteOffset += bytes.length;
  if (byteOffset % 4) { const padding = Buffer.alloc(4 - byteOffset % 4); chunks.push(padding); byteOffset += padding.length; }
  return entry;
}
const point = new THREE.Vector3();
function captureMeshes(scene) {
  const meshes = [];
  scene.updateMatrixWorld(true);
  scene.traverse((object) => { if (object.isMesh) meshes.push(object); });
  return meshes;
}
function vertexPositions(meshes) {
  const result = [];
  for (const mesh of meshes) {
    mesh.skeleton?.update();
    const count = mesh.geometry.getAttribute('position').count;
    for (let i = 0; i < count; i++) { mesh.getVertexPosition(i, point); point.applyMatrix4(mesh.matrixWorld); result.push(point.x, point.y, point.z); }
  }
  return Float32Array.from(result);
}
function indicesAndColors(meshes) {
  const indices = [], colors = [];
  let offset = 0;
  for (const mesh of meshes) {
    const geometry = mesh.geometry, count = geometry.getAttribute('position').count;
    const index = geometry.index?.array ?? Uint32Array.from({ length: count }, (_, i) => i);
    indices.push(...Array.from(index, (value) => value + offset));
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const vertexColors = new Float32Array(count * 3);
    const attribute = geometry.getAttribute('color');
    for (const group of geometry.groups.length ? geometry.groups : [{ start: 0, count: index.length, materialIndex: 0 }]) {
      const material = materials[group.materialIndex ?? 0] ?? materials[0];
      const color = material.color ?? new THREE.Color(0xffffff);
      for (let cursor = group.start; cursor < Math.min(index.length, group.start + group.count); cursor++) {
        const vertex = index[cursor];
        for (let axis = 0; axis < 3; axis++) vertexColors[vertex * 3 + axis] = color.toArray()[axis] * (attribute ? attribute.array[vertex * attribute.itemSize + axis] : 1);
      }
    }
    colors.push(...vertexColors); offset += count;
  }
  return { indices: Uint32Array.from(indices), colors: Float32Array.from(colors) };
}
function recordModel(name, kind, meshes, frames, animation) {
  let { indices, colors } = indicesAndColors(meshes);
  const vehicleDimensions = {'car-sedan': {height: 1.6, width: 1.85, length: 4.5}, 'car-suv': {height: 1.8, width: 1.95, length: 4.5}, 'car-van': {height: 2, width: 2, length: 4.5}};
  const dimensions = normalizeActorFrames(frames, kind === 'vehicle' ? vehicleDimensions[name] : {height: 1.8});
  // Weld only vertices whose complete animated trajectories and colors agree.
  // Static-position welding would tear animated elbows/knees after simplification.
  const weld = new Map(), remap = new Uint32Array(frames[0].length / 3), keep = [];
  for (let v = 0; v < remap.length; v++) {
    const key = [...colors.subarray(v * 3, v * 3 + 3), ...frames.flatMap((frame) => Array.from(frame.subarray(v * 3, v * 3 + 3)))].map((n) => Math.round(n * 1e5)).join(',');
    if (!weld.has(key)) { weld.set(key, keep.length); keep.push(v); } remap[v] = weld.get(key);
  }
  const copy = (source, ids) => Float32Array.from(ids.flatMap((v) => Array.from(source.subarray(v * 3, v * 3 + 3))));
  frames = frames.map((frame) => copy(frame, keep)); colors = copy(colors, keep);
  indices = Uint32Array.from(indices, (v) => remap[v]);
  const target = kind === 'person' ? 1400 : 1000;
  const [simplified, error] = MeshoptSimplifier.simplifyWithAttributes(indices, frames[0], 3, colors, 3, [0.15, 0.15, 0.15], null, Math.min(indices.length, target * 3), 0.012, ['Permissive']);
  indices = simplified;
  const used = [...new Set(indices)], compact = new Map(used.map((v, i) => [v, i]));
  frames = frames.map((frame) => copy(frame, used)); colors = copy(colors, used); indices = Uint32Array.from(indices, (v) => compact.get(v));
  const vertexCount = frames[0].length / 3;
  const positions = new Float32Array(frames.length * vertexCount * 4);
  const normals = new Float32Array(positions.length);
  // Normals are baked from each deformed pose; no per-person CPU skinning at runtime.
  for (let f = 0; f < frames.length; f++) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(frames[f], 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1)); geometry.computeVertexNormals();
    const normal = geometry.getAttribute('normal').array;
    for (let v = 0; v < vertexCount; v++) for (let axis = 0; axis < 3; axis++) {
      positions[(f * vertexCount + v) * 4 + axis] = frames[f][v * 3 + axis];
      normals[(f * vertexCount + v) * 4 + axis] = normal[v * 3 + axis];
    }
    geometry.dispose();
  }
  models.push({ name, kind, vertexCount, triangleCount: indices.length / 3, frameCount: frames.length, dimensions, animation, simplification: { targetTriangles: target, relativeError: error, poseSafeWeld: true },
    positions: append(positions), normals: append(normals), colors: append(colors), indices: append(indices) });
  console.log(`${name}: ${vertexCount} vertices, ${indices.length / 3} triangles, ${frames.length} frames`);
}
for (const [name, id, pack] of people) {
  const raw = await download(`${name}.gltf`, `https://drive.google.com/uc?export=download&id=${id}`, `https://quaternius.com/packs/${pack}.html`);
  const gltf = await loader.parseAsync(raw.toString('utf8'), '');
  const mixer = new THREE.AnimationMixer(gltf.scene), meshes = captureMeshes(gltf.scene), frames = [], animation = {};
  for (const [key, clipName, count] of [['idle', 'Idle', 8], ['walk', 'Walk', 16]]) {
    const clip = gltf.animations.find((clip) => clip.name === clipName);
    if (!clip) throw Error(`Missing authored ${clipName} in ${name}`);
    mixer.stopAllAction(); const action = mixer.clipAction(clip).play();
    animation[key] = { offset: frames.length, count, duration: clip.duration, sourceClip: clipName };
    for (let i = 0; i < count; i++) { mixer.setTime(i * clip.duration / count); gltf.scene.updateMatrixWorld(true); frames.push(vertexPositions(meshes)); }
    action.stop();
  }
  recordModel(name, 'person', meshes, frames, animation);
}
const carUrl = 'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip';
const zip = unzipSync(await download('kenney-car-kit.zip', carUrl, 'https://kenney.nl/assets/car-kit'));
if (process.argv.includes('--list-cars')) { console.log(Object.keys(zip).filter((name) => /\.(glb|gltf)$/i.test(name))); process.exit(0); }
for (const car of ['sedan', 'suv', 'van']) {
  const entry = Object.keys(zip).find((name) => new RegExp(`/${car}\\.glb$`, 'i').test(name));
  if (!entry) throw Error(`Missing Kenney ${car}.glb; inspect --list-cars`);
  const bytes = zip[entry];
  // Decode the author's palette to per-vertex linear colors; no per-car textures.
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = header.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binStart = 20 + jsonLength; const bin = bytes.subarray(binStart + 8, binStart + 8 + header.getUint32(binStart, true));
  const pngs = (json.images ?? []).map((image) => { if (image.uri) return decodePng(zip[`Models/GLB format/${image.uri}`]); const view = json.bufferViews[image.bufferView]; return decodePng(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)); });
  const paletteByMaterial = (json.materials ?? []).map((material) => pngs[json.textures?.[material.pbrMetallicRoughness?.baseColorTexture?.index]?.source]);
  for (const material of json.materials ?? []) { if (material.pbrMetallicRoughness) delete material.pbrMetallicRoughness.baseColorTexture; }
  delete json.images; delete json.textures; delete json.samplers;
  json.buffers[0].uri = `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`;
  const gltf = await loader.parseAsync(JSON.stringify(json), ''); const meshes = captureMeshes(gltf.scene);
  for (const mesh of meshes) {
    const uv = mesh.geometry.getAttribute('uv'); if (!uv) continue;
    const palette = paletteByMaterial[0]; if (!palette) continue;
    const colors = new Float32Array(uv.count * 3);
    for (let v = 0; v < uv.count; v++) {
      const x = Math.max(0, Math.min(palette.width - 1, Math.floor(uv.getX(v) * palette.width)));
      const y = Math.max(0, Math.min(palette.height - 1, Math.floor(uv.getY(v) * palette.height)));
      const color = new THREE.Color().setRGB(...palette.pixels.subarray((y * palette.width + x) * 4, (y * palette.width + x) * 4 + 3).map((v) => v / 255), THREE.SRGBColorSpace);
      color.toArray(colors, v * 3);
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  recordModel(`car-${car}`, 'vehicle', meshes, [vertexPositions(meshes)], { idle: { offset: 0, count: 1, duration: 1 }, walk: { offset: 0, count: 1, duration: 1 } });
}
const binary = Buffer.concat(chunks);
const binaryHash = sha(binary), binaryName = `actors-${binaryHash.slice(0, 16)}.bin`;
try { await writeFile(resolve(output, binaryName), binary, {flag: 'wx'}); }
catch (error) { if (error.code !== 'EEXIST' || sha(await readFile(resolve(output, binaryName))) !== binaryHash) throw error; }
for (const [name, id] of [['quaternius-men-license.txt', '1TTvylHa1CsiJuHFWWiv6PFGhLM-aAH5z'], ['quaternius-women-license.txt', '1lIFL16xEpoPbr0j_HUATgmcEnAmYoIK2']]) {
  await writeFile(resolve(output, name), await download(name, `https://drive.google.com/uc?export=download&id=${id}`, 'https://quaternius.com/license.html'));
}
const carLicense = Object.keys(zip).find((name) => /(^|\/)License\.txt$/i.test(name));
if (!carLicense) throw Error('Kenney license missing');
await writeFile(resolve(output, 'kenney-license.txt'), zip[carLicense]);
const manifestPath = resolve(output, 'manifest.json');
const manifest = { contractVersion: 1, version: 'game-actors-v1', representation: 'visual_synthesis', coordinateSystem: 'east-up-south', forward: '+z', dimensionPolicy: 'uniform_person_height_authored_vehicle_width_height_length_visual_synthesis', binary: {url: binaryName, sha256: binaryHash, bytes: binary.length}, models, sources, licenses: [] };
for (const file of ['quaternius-men-license.txt', 'quaternius-women-license.txt', 'kenney-license.txt']) {
  const bytes = await readFile(resolve(output, file)); manifest.licenses.push({ url: file, sha256: sha(bytes), bytes: bytes.length, spdx: 'CC0-1.0' });
}
const stagedManifest = `${manifestPath}.${process.pid}.tmp`;
await writeFile(stagedManifest, JSON.stringify(manifest, null, 2) + '\n');
await rename(stagedManifest, manifestPath);
console.log(`Wrote ${models.length} templates, ${(binary.length / 1024 / 1024).toFixed(2)} MiB`);

function decodePng(bytes) {
  const buffer = Buffer.from(bytes), compressed = []; let width, height, channels;
  for (let cursor = 8; cursor < buffer.length;) {
    const length = buffer.readUInt32BE(cursor), type = buffer.toString('ascii', cursor + 4, cursor + 8), data = buffer.subarray(cursor + 8, cursor + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0; if (data[8] !== 8 || !channels || data[12]) throw Error('Unsupported source PNG encoding'); }
    if (type === 'IDAT') compressed.push(data); cursor += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(compressed)), stride = width * channels, rows = Buffer.alloc(height * stride), pixels = new Float32Array(width * height * 4);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) for (let x = 0; x < stride; x++) {
    const filter = raw[y * (stride + 1)], value = raw[y * (stride + 1) + 1 + x], a = x >= channels ? rows[y * stride + x - channels] : 0, b = y ? rows[(y - 1) * stride + x] : 0, c = y && x >= channels ? rows[(y - 1) * stride + x - channels] : 0;
    rows[y * stride + x] = (value + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : 0)) & 255;
  }
  for (let i = 0; i < width * height; i++) for (let c = 0; c < 4; c++) pixels[i * 4 + c] = c === 3 && channels === 3 ? 255 : rows[i * channels + c];
  return { width, height, pixels };
}
