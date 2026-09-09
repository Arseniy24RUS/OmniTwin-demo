import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshoptDecoder } from 'meshoptimizer/decoder';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { encodeGlb,parseGlb } from './glb.mjs';
import { compressGlb } from './compression.mjs';
const m={name:'source:roof',canonicalId:'source',material:'concrete',positions:[0,2,0,10,2,0,0,2,10],normals:[0,1,0,0,1,0,0,1,0],uvs:[0,0,1,0,0,1],indices:[0,2,1]};
test('meshopt decoded buffers are byte-identical including native picking triangle order',async()=>{
  await MeshoptDecoder.ready;const raw=encodeGlb([m],{origin:[61,55,0]}),compressed=await compressGlb(raw),old=parseGlb(raw),next=parseGlb(compressed);
  for(let i=0;i<next.json.bufferViews.length;i++){const v=next.json.bufferViews[i],e=v.extensions.EXT_meshopt_compression,target=new Uint8Array(v.byteLength);MeshoptDecoder.decodeGltfBuffer(target,e.count,e.byteStride,next.bin.subarray(e.byteOffset,e.byteOffset+e.byteLength),e.mode,e.filter);const original=old.json.bufferViews[i];assert.deepEqual(Buffer.from(target),old.bin.subarray(original.byteOffset,original.byteOffset+original.byteLength));}
  assert.deepEqual(await compressGlb(raw),compressed);
});
test('actual installed Three GLTFLoader loads compressed GLB and source metadata without browser',async()=>{
  const bytes=await compressGlb(encodeGlb([m],{origin:[61,55,0]}));const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);const result=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
  const mesh=result.scene.children[0];assert.equal(mesh.userData.canonicalId,'source');assert.deepEqual([...mesh.geometry.index.array],[0,2,1]);assert.equal(mesh.geometry.attributes.position.count,3);assert.equal(mesh.material.roughness,.95);
});
