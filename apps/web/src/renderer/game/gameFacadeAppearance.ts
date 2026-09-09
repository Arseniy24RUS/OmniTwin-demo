import {BufferAttribute,type Mesh,type MeshStandardMaterial} from 'three';
import {MINERAL_FACADE_PALETTES,canonicalFacadeVariant} from '../buildingFacadePolicy';
import {applyGameFacadeGrammar} from './gameFacadeGrammar';

type RGB=readonly [number,number,number];
type Family='panel'|'plaster'|'civic'|'neutral';
interface Range {firstTriangle:number;triangleCount:number;canonicalId:string}
export const GAME_FACADE_APPEARANCE_VERSION='canonical-mineral-facades-v2';
// Linear albedo multipliers. These are authored finishes, not surveyed colours.
const PALETTES=MINERAL_FACADE_PALETTES;
// The pinned compiler's muted-facades-v1 tint is removed before the new finish.
// This preserves its independent floor, entrance and recess shading exactly.
const COMPILED_TINTS:readonly RGB[]=[[1,.95,.86],[.84,.91,1],[.88,1,.90],[1,.83,.73],[.94,.87,.96],[1,1,1]];
function hash(value:string){let h=2166136261;for(const char of value)h=Math.imul(h^char.charCodeAt(0),16777619);return h>>>0;}
const owner=(id:unknown):id is string=>typeof id==='string'&&/^openmaptiles_buildings:[0-9]+$/.test(id);
export function gameFacadePalette(id:string,family:Family):RGB{
  if(!owner(id)||!Object.hasOwn(PALETTES,family))throw Error('Invalid canonical facade identity');
  return PALETTES[family][canonicalFacadeVariant(id)]!;
}

/** Recolour only the pinned compiler's owned mineral wall batches, before first draw.
 * No geometry clones, new attributes, textures, materials, timers or draw calls.
 * Lossless compiled triangle corners are independent. Other index layouts retain
 * their original appearance instead of recolouring a shared/ambiguous vertex. */
export function applyGameFacadeAppearance(mesh:Mesh):boolean{
  const material=mesh.material as MeshStandardMaterial,geometry=mesh.geometry;
  if(Array.isArray(mesh.material)||!material.isMeshStandardMaterial||!material.map||!material.vertexColors
    ||!Object.hasOwn(PALETTES,material.name)||material.userData.sourceId!=='plastered_wall_02'
    ||mesh.userData.surfaceKind!=='building'||geometry.userData.facadeAppearance?.version===GAME_FACADE_APPEARANCE_VERSION)return false;
  const colors=geometry.getAttribute('color'),positions=geometry.getAttribute('position'),index=geometry.getIndex();
  const retain=(reason:string)=>{geometry.userData.facadeAppearance={version:GAME_FACADE_APPEARANCE_VERSION,state:'original_retained',reason,representation:'visual_synthesis'};return false;};
  if(!(colors instanceof BufferAttribute)||!(colors.array instanceof Float32Array)||colors.itemSize!==3
    ||!positions||colors.count!==positions.count||colors.count>2_000_000||colors.count%3
    ||index&&index.count!==colors.count)return retain('unsupported_attribute_layout');
  const ranges:readonly Range[]=Array.isArray(mesh.userData.featureRanges)&&mesh.userData.featureRanges.length
    ?mesh.userData.featureRanges:owner(mesh.userData.canonicalId)?[{firstTriangle:0,triangleCount:colors.count/3,canonicalId:mesh.userData.canonicalId}]:[];
  if(!ranges.length||ranges.length>65536)return retain('missing_or_excessive_ownership');
  let end=0;
  for(const range of ranges){
    if(!owner(range.canonicalId)||!Number.isSafeInteger(range.firstTriangle)||!Number.isSafeInteger(range.triangleCount)
      ||range.triangleCount<1||range.firstTriangle!==end||range.firstTriangle+range.triangleCount>colors.count/3)return retain('ambiguous_ownership');
    end=range.firstTriangle+range.triangleCount;
  }
  if(end!==colors.count/3)return retain('incomplete_ownership');
  // Complete validation precedes mutation, including a damaged late vertex.
  for(let i=0;i<colors.count;i++){
    const r=colors.getX(i),g=colors.getY(i),b=colors.getZ(i);
    if(index&&index.getX(i)!==i||!Number.isFinite(r)||!Number.isFinite(g)||!Number.isFinite(b)
      ||r<0||r>1||g<0||g>1||b<0||b>1)return retain('unsupported_compiled_corners');
  }
  let changed=0;
  for(const range of ranges){
    const old=COMPILED_TINTS[hash(`facade:${range.canonicalId}`)%COMPILED_TINTS.length]!,next=gameFacadePalette(range.canonicalId,material.name as Family);
    for(let i=range.firstTriangle*3;i<(range.firstTriangle+range.triangleCount)*3;i++){
      const shade=colors.getX(i)/old[0];
      // Preserve colours that do not match the compiler's canonical tint. The
      // neutral [1,1,1] bucket also includes indistinguishable gray balcony parts:
      // those deliberately follow this material's finish, with shading intact.
      if(Math.abs(colors.getY(i)/old[1]-shade)>2e-6||Math.abs(colors.getZ(i)/old[2]-shade)>2e-6||shade>1+2e-6)continue;
      colors.setXYZ(i,shade*next[0],shade*next[1],shade*next[2]);changed++;
    }
  }
  if(changed)colors.needsUpdate=true;
  applyGameFacadeGrammar(material);
  geometry.userData.facadeAppearance={version:GAME_FACADE_APPEARANCE_VERSION,state:'applied',representation:'visual_synthesis',family:material.name,
    canonicalRanges:ranges.length,verticesChanged:changed,extraRetainedBytes:0,sourceGeometryUnchanged:true,sourceUvUnchanged:true,
    neutralTintParts:'matching_gray_balcony_parts_follow_material_finish'};
  return changed>0;
}
