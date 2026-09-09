export type MineralFacadeFamily='panel'|'plaster'|'civic'|'neutral';
export type FacadeRGB=readonly [number,number,number];
/** Shared art direction. These finishes are visual synthesis, not source colours. */
export const MINERAL_FACADE_PALETTES:Record<MineralFacadeFamily,readonly FacadeRGB[]>={
  panel:[[.86,.86,.80],[.49,.65,.72],[.88,.72,.50],[.53,.64,.54]],
  plaster:[[.92,.82,.65],[.78,.53,.37],[.53,.68,.62],[.88,.87,.81]],
  civic:[[.94,.87,.72],[.83,.67,.46],[.84,.86,.82],[.55,.67,.70]],
  neutral:[[.78,.78,.69],[.83,.63,.43],[.49,.64,.72],[.57,.68,.53]],
};
/** Include both the terminal marker and preceding digits: source IDs often end
 * in the same marker. This is never used to infer identity or OSM ownership. */
export function canonicalFacadeVariant(id:string):number{
  const digits=id.match(/\d+$/)?.[0];if(!digits)return 0;
  const suffix=Number(digits.slice(-6));return(suffix+Math.floor(suffix/10))%4;
}
export const CANONICAL_FACADE_VARIANT_EXPRESSION:readonly unknown[]=[
  'let','facadeIdentity',['to-string',['coalesce',['get','canonical_id'],['id'],['get','id'],'0']],
  ['let','facadeSuffix',['to-number',['slice',['slice',['var','facadeIdentity'],['+',['index-of',':',['var','facadeIdentity']],1]],-6],0],
    ['%',['+',['var','facadeSuffix'],['floor',['/',['var','facadeSuffix'],10]]],4]],
];
export const FACADE_SYNTHESIS_POLICY=Object.freeze({version:'canonical-facade-grammar-v2',representation:'visual_synthesis',
  sourceMaterialPrecedence:true,identityPolicy:'stable_canonical_suffix_art_variant_only',sourceGeometryUnchanged:true});
