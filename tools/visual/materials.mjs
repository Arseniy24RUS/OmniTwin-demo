export const ATLAS_KEYS=['panel','brick','plaster','glass','industrial','civic','timber','neutral','bitumen','metal','tile','concrete','asphalt','paving','grass','trim'];
const rgba=(hex)=>[...hex.matchAll(/../g)].map(v=>parseInt(v[0],16)/255).concat(1);
// glTF baseColorFactor is linear, unlike the authored sRGB atlas image.
const linearRgba=hex=>rgba(hex).map((v,i)=>i===3?v:v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
export const MATERIALS=Object.freeze({
  panel:{color:rgba('d5d0bc'),roughness:.88},brick:{color:rgba('b57250'),roughness:.92},plaster:{color:rgba('e0c994'),roughness:.9},glass:{color:rgba('739bab'),roughness:.3,metallic:.12},
  industrial:{color:rgba('adb5a8'),roughness:.8},civic:{color:rgba('ddd4b4'),roughness:.9},timber:{color:rgba('a08255'),roughness:.94},neutral:{color:rgba('c8bca8'),roughness:.9},
  bitumen:{color:rgba('666760'),roughness:.98},metal:{color:rgba('8b9891'),roughness:.5,metallic:.22},tile:{color:rgba('a6573e'),roughness:.85},concrete:{color:rgba('b1b0a1'),roughness:.95},
  asphalt:{color:rgba('697170'),roughness:.95},paving:{color:rgba('b7baa6'),roughness:.96},grass:{color:linearRgba('75805d'),roughness:1},trim:{color:rgba('ede3cb'),roughness:.8},
  windows:{color:linearRgba('4d6570'),roughness:.24,metallic:.12},doors:{color:linearRgba('394751'),roughness:.42,metallic:.15},windowLight:{color:rgba('d7b37b'),roughness:.5,emissive:[.2,.13,.06]},marking:{color:rgba('ded8bb'),roughness:.94},curb:{color:rgba('c3c5b5'),roughness:.94},trunk:{color:linearRgba('514332'),roughness:1},leaves:{color:linearRgba('6f8250'),roughness:1},
});
export function materialDefinition(key,atlas=false){const value=MATERIALS[key]??MATERIALS.neutral;const slot=ATLAS_KEYS.indexOf(key),textured=atlas&&slot>=0&&key!=='grass';return {name:key,pbrMetallicRoughness:{baseColorFactor:textured?[1,1,1,1]:value.color,metallicFactor:value.metallic??0,roughnessFactor:value.roughness,...(textured?{baseColorTexture:{index:0}}:{})},...(value.emissive?{emissiveFactor:value.emissive}:{}),doubleSided:false,extras:{representation:'visual_synthesis',atlasSlot:slot,...(key==='grass'?{albedoFallback:'solid_muted_green_with_analytic_vertex_variation_until_metric_tiling'}:{})}};}
export function atlasUV(key,u,v){const slot=ATLAS_KEYS.indexOf(key);if(slot<0)return[u,v];const x=slot%4,y=Math.floor(slot/4),g=.016;return[(x+g+(1-2*g)*Math.min(1,Math.max(0,u)))/4,(y+g+(1-2*g)*Math.min(1,Math.max(0,v)))/4];}
