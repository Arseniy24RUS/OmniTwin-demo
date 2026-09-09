/** Select already globally bounded trees exactly once; never allocate a new per-tile tree cap. */
export function treeQuadrant(point){return [point[0]<0?0:1,point[1]<0?0:1];}
export function selectTreeMeshes(green,x,y){
  const ids=new Set(green.treePlacements.filter(p=>{const q=treeQuadrant(p.point);return q[0]===x&&q[1]===y;}).map(p=>p.id));
  return green.meshes.filter(m=>m.treeId&&ids.has(m.treeId));
}
