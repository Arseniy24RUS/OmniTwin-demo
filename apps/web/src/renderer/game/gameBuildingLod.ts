/** The published grammar keeps identical source walls/eaves/roof in both LODs.
 * Its omitted roof fixtures rise <=1.76m; canopy projection <=0.875m, balconies
 * <=0.75m, parapets <=0.39m, and recessed glass <=0.24m. Two metres is a
 * conservative geometric omission bound, unlike the historical 32m placeholder.
 * Only this audited immutable catalog is eligible. A new grammar/catalog must
 * retain its declared errors until its omission envelope has been reviewed. */
export const GAME_BUILDING_LOD_CATALOG='bca4ff81f5a4c1a8c3517f0b1faeceddd6042cf20d811c70661993ecec72a819';
export const GAME_BUILDING_DETAIL_ERROR_METERS=2;

interface BuildingLodNode {
  geometricError:number;
  refine?:string;
  content?:{uri?:string};
  extras?:Record<string,unknown>;
  children?:readonly {geometricError:number}[];
}
export interface GameBuildingLodDiagnostics {
  policy:'metric-authored-detail-bound-v1';
  declaredCoarseErrorMeters:number;
  detailErrorMeters:number;
  adjustedCoarseTiles:number;
  screenSpace:'css_pixels';
}

/** Supported TilesRenderer preprocessing changes only the runtime traversal
 * estimate after metadata verification. Source IDs, transforms, bounds, content
 * URLs, authored geometry and retained-frontier transactions are untouched. */
export function createGameBuildingLodPolicy(catalogSha256:string|undefined){
  if(catalogSha256!==GAME_BUILDING_LOD_CATALOG)return null;
  const diagnostics:GameBuildingLodDiagnostics={policy:'metric-authored-detail-bound-v1',declaredCoarseErrorMeters:32,
    detailErrorMeters:GAME_BUILDING_DETAIL_ERROR_METERS,adjustedCoarseTiles:0,screenSpace:'css_pixels'};
  return {name:'omnitwin-metric-building-detail-lod',diagnostics,
    preprocessNode(tile:BuildingLodNode):void{
      if(tile.geometricError!==32||tile.refine!=='REPLACE'||!/(?:^|\/)coarse-[a-f0-9]{16}\.glb$/.test(tile.content?.uri??'')
        ||tile.extras?.units!=='metres'||tile.extras.coordinateSystem!=='east-up-south'||tile.extras.coverage!=='bounded_quarter'
        ||!tile.children?.length||!tile.children.every(child=>child.geometricError===0))return;
      tile.geometricError=GAME_BUILDING_DETAIL_ERROR_METERS;
      diagnostics.adjustedCoarseTiles++;
    },
  };
}

/** SSE describes visible geometric size, not framebuffer oversampling. A DPR
 * change must not independently multiply the requested architecture detail. */
export function gameLodResolution(canvas:Pick<HTMLCanvasElement,'clientWidth'|'clientHeight'>){
  const dimension=(value:number)=>Number.isFinite(value)&&value>0?value:1;
  return {width:dimension(canvas.clientWidth),height:dimension(canvas.clientHeight)};
}
