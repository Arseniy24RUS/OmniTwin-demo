import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeGlb, parseGlb } from './glb.mjs';
import { mesh,quad } from './geometry.mjs';
import { compressGlb } from './compression.mjs';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { batchMeshes } from './batching.mjs';
test('real binary glTF has aligned bounded attributes and canonical metadata',()=>{
  const mesh={name:'source:roof',canonicalId:'source',material:'concrete',positions:[0,2,0,10,2,0,0,2,10],normals:[0,1,0,0,1,0,0,1,0],uvs:[0,0,1,0,0,1],indices:[0,2,1]};
  const bytes=encodeGlb([mesh],{origin:[61,55,0]}),{json,bin}=parseGlb(bytes);
  assert.equal(json.asset.version,'2.0');assert.equal(json.nodes[0].extras.canonicalId,'source');assert.equal(json.accessors[0].count,3);assert.ok(bin.length>0);assert.ok(json.bufferViews.every(v=>v.byteOffset%4===0));assert.deepEqual(encodeGlb([mesh],{origin:[61,55,0]}),bytes);
});
test('metric family textures repeat at metre scale and retain canonical geometry',()=>{
  const wall=mesh('source:shell','brick','source');
  quad(wall,[[0,0,0],[12,0,0],[12,9,0],[0,9,0]]);
  const materialTextures={brick:{baseColorUri:'../materials/brick.jpg',normalUri:'../materials/brick-normal.jpg',ormUri:'../materials/brick-arm.jpg',repeatMeters:[1.5,1.5],sourceId:'brick_wall_001',license:'CC0-1.0'}};
  const {json,bin}=parseGlb(encodeGlb([wall],{origin:[61,55,0],materialTextures}));
  assert.equal(json.images.length,3);
  assert.equal(json.samplers[0].wrapS,10497);
  assert.equal(json.samplers[0].wrapT,10497);
  const primitive=json.meshes[0].primitives[0],acc=json.accessors[primitive.attributes.TEXCOORD_0],view=json.bufferViews[acc.bufferView];
  const uv=Array.from({length:acc.count*2},(_,i)=>bin.readFloatLE(view.byteOffset+i*4));
  assert.equal(Math.max(...uv.filter((_,i)=>i%2===0))-Math.min(...uv.filter((_,i)=>i%2===0)),8);
  assert.equal(Math.max(...uv.filter((_,i)=>i%2===1)),6);
  assert.equal(json.nodes[0].extras.canonicalId,'source');
  assert.equal(json.materials[0].extras.textureScaleRepresentation,'visual_synthesis');
  assert.deepEqual(json.materials[0].pbrMetallicRoughness.baseColorFactor,[1,1,1,1]);
  assert.equal(json.materials[0].pbrMetallicRoughness.metallicFactor,1);
  assert.equal(json.materials[0].pbrMetallicRoughness.roughnessFactor,1);
});
test('repeated material images deduplicate and reject unsupported scales or remote URIs',()=>{
  const make=(family)=>{const out=mesh(`id:${family}`,family,'id');quad(out,[[0,0,0],[3,0,0],[3,3,0],[0,3,0]]);return out;};
  const texture={baseColorUri:'../materials/plaster.jpg',repeatMeters:[2,2]};
  const {json}=parseGlb(encodeGlb([make('panel'),make('plaster')],{materialTextures:{panel:texture,plaster:texture}}));
  assert.equal(json.images.length,1);
  assert.throws(()=>encodeGlb([make('panel')],{materialTextures:{panel:{...texture,repeatMeters:[0,2]}}}),/scale/i);
  assert.throws(()=>encodeGlb([make('panel')],{materialTextures:{panel:{...texture,baseColorUri:'https://example.com/x.jpg'}}}),/relative/i);
});
test('compressed metric surfaces retain byte-identical geometry, UV and canonical ranges',async()=>{
  const first=mesh('source-a:shell','brick','source-a'),second=mesh('source-b:shell','brick','source-b');
  quad(first,[[0,0,0],[4,0,0],[4,6,0],[0,6,0]]);quad(second,[[12,0,0],[20,0,0],[20,6,0],[12,6,0]]);
  const raw=encodeGlb(batchMeshes([first,second]),{materialTextures:{brick:{baseColorUri:'../materials/brick.jpg',repeatMeters:[1.5,1.5]}}});
  const before=parseGlb(raw),after=parseGlb(await compressGlb(raw));await MeshoptDecoder.ready;
  for(let i=0;i<after.json.bufferViews.length;i++){
    const view=after.json.bufferViews[i],extension=view.extensions.EXT_meshopt_compression,target=new Uint8Array(view.byteLength);
    MeshoptDecoder.decodeGltfBuffer(target,extension.count,extension.byteStride,after.bin.subarray(extension.byteOffset,extension.byteOffset+extension.byteLength),extension.mode,extension.filter);
    const old=before.json.bufferViews[i];assert.deepEqual(Buffer.from(target),before.bin.subarray(old.byteOffset,old.byteOffset+old.byteLength));
  }
  assert.deepEqual(after.json.meshes[0].extras.featureRanges,[{firstTriangle:0,triangleCount:2,canonicalId:'source-a'},{firstTriangle:2,triangleCount:2,canonicalId:'source-b'}]);
});
test('legacy atlas uses clamp UVs and keeps a relative texture path',()=>{
  const wall=mesh('id:shell','panel','id');quad(wall,[[0,0,0],[9,0,0],[9,6,0],[0,6,0]]);
  const {json}=parseGlb(encodeGlb([wall],{atlasUri:'../atlas.png'}));
  assert.equal(json.images[0].uri,'../atlas.png');assert.equal(json.samplers[0].wrapS,33071);
  assert.equal(json.materials[0].extras.textureScaleRepresentation,undefined);
});
