/** Merge material batches without losing raycast triangle-to-canonical identity. */
export function batchMeshes(meshes){
  const batches=new Map();
  for(const m of meshes){if(!m.indices.length)continue;let out=batches.get(m.material);if(!out){out={name:`batch:${m.material}`,material:m.material,positions:[],normals:[],uvs:[],colors:[],indices:[],sourceIds:[],featureRanges:[],provenance:'source_geometry_with_visual_synthesis'};batches.set(m.material,out);}const first=out.positions.length/3;
    if(m.canonicalId)out.featureRanges.push({firstTriangle:out.indices.length/3,triangleCount:m.indices.length/3,canonicalId:m.canonicalId});
    for(const key of ['positions','normals','uvs'])for(const value of m[key])out[key].push(value);
    if(m.colors?.length===m.positions.length){for(const value of m.colors)out.colors.push(value);}else for(let i=0;i<m.positions.length;i++)out.colors.push(1);
    for(const i of m.indices)out.indices.push(first+i);for(const id of m.sourceIds??(m.canonicalId?[m.canonicalId]:[]))if(!out.sourceIds.includes(id))out.sourceIds.push(id);
  }
  return [...batches.values()];
}
