/** Stable ownership inventory from the same ranges consumed by native picking. */
export function canonicalBuildingIds(meshes){
  return [...new Set(meshes.flatMap(m=>(m.featureRanges??[]).map(r=>r.canonicalId)))].sort();
}

export function materialLibraryFromKit(kit,sourceCatalogSha256){
  return {contract:'CityMaterialLibraryV2',version:2,mode:'metric_repeat',representation:'visual_synthesis',
    provider:'Poly Haven',license:'CC0-1.0',licenseUrl:'https://polyhaven.com/license',sourceCatalogSha256,
    assets:kit.assets,materials:kit.materialTextures};
}
export function detailGridCell(point,size,divisions){
  return point.map(v=>Math.max(0,Math.min(divisions-1,Math.floor((v+size/2)/(size/divisions)))));
}
