import { materialDefinition,atlasUV } from './materials.mjs';

/** Deterministic binary glTF writer: no DOM, exporter globals, network, or image conversion. */
export function encodeGlb(meshes,{origin,atlasUri=null,normalUri=null,ormUri=null,materialTextures=null,lod=0}={}){
  const chunks=[],bufferViews=[],accessors=[],materials=[],materialIds=new Map(),nodes=[],gltfMeshes=[];let offset=0;
  const append=(buffer,target)=>{const padding=(4-offset%4)%4;if(padding){chunks.push(Buffer.alloc(padding));offset+=padding;}const id=bufferViews.length;bufferViews.push({buffer:0,byteOffset:offset,byteLength:buffer.length,...(target?{target}:{})});chunks.push(buffer);offset+=buffer.length;return id;};
  const attribute=(values,size,type='FLOAT')=>{if(values.length%size||values.some(v=>!Number.isFinite(v)))throw new Error('Invalid geometry attribute');const array=type==='UINT'?new Uint32Array(values):new Float32Array(values),view=append(Buffer.from(array.buffer),type==='UINT'?34963:34962);const item={bufferView:view,componentType:type==='UINT'?5125:5126,count:array.length/size,type:size===1?'SCALAR':`VEC${size}`};
    if(type!=='UINT'){item.min=Array.from({length:size},(_,c)=>{let m=Infinity;for(let i=c;i<array.length;i+=size)m=Math.min(m,array[i]);return m;});item.max=Array.from({length:size},(_,c)=>{let m=-Infinity;for(let i=c;i<array.length;i+=size)m=Math.max(m,array[i]);return m;});}
    accessors.push(item);return accessors.length-1;
  };
  const images=[],textures=[],samplers=[],imageIds=new Map(),textureIds=new Map();
  const addTexture=(uri,repeating=false)=>{
    if(typeof uri!=='string'||uri.includes('://')||uri.startsWith('/')||uri.includes('\\')||uri.includes('?')||uri.includes('#')||!/\.(png|jpg|jpeg)$/i.test(uri))throw new Error('Texture must be a local relative pack URI');
    let image=imageIds.get(uri);if(image===undefined){image=images.length;images.push({uri});imageIds.set(uri,image);}
    const wrap=repeating?10497:33071;let sampler=samplers.findIndex(s=>s.wrapS===wrap);if(sampler<0){sampler=samplers.length;samplers.push({magFilter:9729,minFilter:9987,wrapS:wrap,wrapT:wrap});}
    const key=`${image}:${sampler}`;let texture=textureIds.get(key);if(texture===undefined){texture=textures.length;textures.push({source:image,sampler});textureIds.set(key,texture);}return texture;
  };
  for(const uri of [atlasUri,normalUri,ormUri])if(uri)addTexture(uri);
  for(const mesh of meshes){if(!mesh.indices.length)continue;const count=mesh.positions.length/3;if(count>2_000_000||mesh.normals.length!==mesh.positions.length||mesh.uvs.length!==count*2||mesh.indices.some(i=>i<0||i>=count||!Number.isInteger(i)))throw new Error('Invalid geometry bounds');
    const surface=materialTextures?.[mesh.material];
    if(surface&&(!Array.isArray(surface.repeatMeters)||surface.repeatMeters.length!==2||surface.repeatMeters.some(v=>!Number.isFinite(v)||v<.1||v>64)))throw new Error('Invalid metric texture scale');
    let material=materialIds.get(mesh.material);if(material===undefined){material=materials.length;materialIds.set(mesh.material,material);const def=materialDefinition(mesh.material,Boolean(atlasUri)&&!surface);
      if(surface){
        Object.assign(def.pbrMetallicRoughness,{baseColorFactor:surface.tint??[1,1,1,1],baseColorTexture:{index:addTexture(surface.baseColorUri,true)}});
        if(surface.normalUri)def.normalTexture={index:addTexture(surface.normalUri,true),scale:surface.normalScale??.5};
        if(surface.ormUri){const index=addTexture(surface.ormUri,true);def.occlusionTexture={index,strength:.6};Object.assign(def.pbrMetallicRoughness,{metallicRoughnessTexture:{index},roughnessFactor:1,metallicFactor:1});}
        Object.assign(def.extras,{repeatMeters:surface.repeatMeters,textureScaleRepresentation:'visual_synthesis',sourceId:surface.sourceId??null,license:surface.license??null});
      }else if(def.pbrMetallicRoughness.baseColorTexture){if(normalUri)def.normalTexture={index:1,scale:.45};if(ormUri){const index=normalUri?2:1;def.occlusionTexture={index,strength:.55};def.pbrMetallicRoughness.metallicRoughnessTexture={index};}}materials.push(def);}
    const uv=surface?metricUVs(mesh,surface.repeatMeters):atlasUri?mesh.uvs.flatMap((_,i,a)=>i%2?[]:atlasUV(mesh.material,a[i],a[i+1])):mesh.uvs;
    const attributes={POSITION:attribute(mesh.positions,3),NORMAL:attribute(mesh.normals,3),TEXCOORD_0:attribute(uv,2)};
    if(mesh.colors?.length===mesh.positions.length)attributes.COLOR_0=attribute(mesh.colors,3);
    const owner=mesh.canonicalId??null,extras={canonicalId:owner,sourceIds:mesh.sourceIds??(owner?[owner]:[]),featureRanges:mesh.featureRanges??[],surfaceKind:owner||mesh.featureRanges?.length?'building':['leaves','trunk'].includes(mesh.material)?'tree':mesh.material==='grass'?'ground':'road',representation:mesh.provenance??(owner?'source_geometry_with_visual_synthesis':'visual_synthesis'),part:mesh.name.split(':').at(-1)};
    gltfMeshes.push({name:mesh.name,primitives:[{attributes,indices:attribute(mesh.indices,1,'UINT'),material,mode:4}],extras});nodes.push({name:mesh.name,mesh:gltfMeshes.length-1,extras});
  }
  const bin=Buffer.concat(chunks),json={asset:{version:'2.0',generator:'OmniTwin source-backed visual compiler 1',extras:{representation:'source_geometry_with_visual_synthesis'}},scene:0,scenes:[{nodes:nodes.map((_,i)=>i)}],nodes,meshes:gltfMeshes,materials,buffers:[{byteLength:bin.length}],bufferViews,accessors,...(images.length?{images,textures,samplers}:{}),extras:{origin,coordinateSystem:'east-up-south',units:'metres',lod,populationGeometryContract:'No population state or assignment is modified'}};
  const raw=Buffer.from(JSON.stringify(json)),jp=(4-raw.length%4)%4,bp=(4-bin.length%4)%4,header=Buffer.alloc(12),jh=Buffer.alloc(8),bh=Buffer.alloc(8);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(12+8+raw.length+jp+8+bin.length+bp,8);jh.writeUInt32LE(raw.length+jp);jh.writeUInt32LE(0x4e4f534a,4);bh.writeUInt32LE(bin.length+bp);bh.writeUInt32LE(0x004e4942,4);return Buffer.concat([header,jh,raw,Buffer.alloc(jp,32),bh,bin,Buffer.alloc(bp)]);
}
/** Plane-aligned metric coordinates survive batching and keep the same texture
 * density on a 3 m wall, a 90 m wall, and all triangles of a flat roof. */
export function metricUVs(mesh,[scaleU,scaleV]){
  const out=[];
  for(let i=0;i<mesh.positions.length;i+=3){
    const [x,y,z]=mesh.positions.slice(i,i+3),[nx,ny,nz]=mesh.normals.slice(i,i+3),horizontal=Math.hypot(nx,nz);
    if(horizontal<.01){out.push(x/scaleU,-z/scaleV);continue;}
    const ux=nz/horizontal,uz=-nx/horizontal;
    const vx=ny*uz,vy=nz*ux-nx*uz,vz=-ny*ux;
    out.push((x*ux+z*uz)/scaleU,(x*vx+y*vy+z*vz)/scaleV);
  }
  return out;
}
export function parseGlb(bytes){if(bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(8)!==bytes.length)throw new Error('Invalid GLB');const size=bytes.readUInt32LE(12),json=JSON.parse(bytes.subarray(20,20+size).toString()),start=20+size;return {json,bin:bytes.subarray(start+8,start+8+bytes.readUInt32LE(start))};}
