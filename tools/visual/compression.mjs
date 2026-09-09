import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { parseGlb } from './glb.mjs';

/** Lossless buffer compression. INDICES mode preserves triangle order and corner order. */
export async function compressGlb(raw){
  await MeshoptEncoder.ready;
  const {json,bin}=parseGlb(raw),chunks=[];let offset=0;
  for(let index=0;index<json.bufferViews.length;index++){
    const view=json.bufferViews[index],accessor=json.accessors.find(a=>a.bufferView===index);if(!accessor)throw new Error('Unexpected non-attribute GLB bufferView');
    const component=accessor.componentType===5126||accessor.componentType===5125?4:accessor.componentType===5123?2:1,components=accessor.type==='SCALAR'?1:Number(accessor.type.slice(3)),stride=view.byteStride??component*components;
    const source=bin.subarray(view.byteOffset??0,(view.byteOffset??0)+view.byteLength),encoded=MeshoptEncoder.encodeGltfBuffer(source,accessor.count,stride,view.target===34963?'INDICES':'ATTRIBUTES');
    const pad=(4-offset%4)%4;if(pad){chunks.push(Buffer.alloc(pad));offset+=pad;}
    view.buffer=1;view.extensions={EXT_meshopt_compression:{buffer:0,byteOffset:offset,byteLength:encoded.length,byteStride:stride,count:accessor.count,mode:view.target===34963?'INDICES':'ATTRIBUTES',filter:'NONE'}};chunks.push(Buffer.from(encoded));offset+=encoded.length;
  }
  const compressed=Buffer.concat(chunks);json.buffers=[{byteLength:compressed.length},{byteLength:bin.length,extensions:{EXT_meshopt_compression:{fallback:true}}}];json.extensionsUsed=[...(json.extensionsUsed??[]),'EXT_meshopt_compression'];json.extensionsRequired=[...(json.extensionsRequired??[]),'EXT_meshopt_compression'];
  const body=Buffer.from(JSON.stringify(json)),jp=(4-body.length%4)%4,bp=(4-compressed.length%4)%4,head=Buffer.alloc(12),jhead=Buffer.alloc(8),bhead=Buffer.alloc(8);head.writeUInt32LE(0x46546c67);head.writeUInt32LE(2,4);head.writeUInt32LE(28+body.length+jp+compressed.length+bp,8);jhead.writeUInt32LE(body.length+jp);jhead.writeUInt32LE(0x4e4f534a,4);bhead.writeUInt32LE(compressed.length+bp);bhead.writeUInt32LE(0x004e4942,4);return Buffer.concat([head,jhead,body,Buffer.alloc(jp,32),bhead,compressed,Buffer.alloc(bp)]);
}
