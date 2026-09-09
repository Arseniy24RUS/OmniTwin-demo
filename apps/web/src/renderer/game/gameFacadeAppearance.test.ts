import {describe,it,expect} from 'vitest';
import {BufferAttribute,BufferGeometry,Mesh,MeshStandardMaterial,Texture} from 'three';
import {applyGameFacadeAppearance,gameFacadePalette,GAME_FACADE_APPEARANCE_VERSION} from './gameFacadeAppearance';

const tints=[[1,.95,.86],[.84,.91,1],[.88,1,.90],[1,.83,.73],[.94,.87,.96],[1,1,1]];
function hash(value:string){let h=2166136261;for(const c of value)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;}
const id=(n:number)=>`openmaptiles_buildings:${n}`;
function fixture(ids=[id(1),id(2)],family='panel'){
  const geometry=new BufferGeometry(),colors=ids.flatMap(owner=>[.82,.98,1].flatMap(shade=>tints[hash(`facade:${owner}`)%6]!.map(v=>v*shade)));
  geometry.setAttribute('position',new BufferAttribute(new Float32Array(ids.length*9),3));
  geometry.setAttribute('color',new BufferAttribute(new Float32Array(colors),3));
  geometry.setAttribute('uv',new BufferAttribute(new Float32Array(ids.length*6),2));
  geometry.setIndex(Array.from({length:ids.length*3},(_,i)=>i));
  const material=new MeshStandardMaterial({map:new Texture(),vertexColors:true});material.name=family;material.userData.sourceId='plastered_wall_02';
  const mesh=new Mesh(geometry,material);mesh.userData={surfaceKind:'building',featureRanges:ids.map((canonicalId,i)=>({canonicalId,firstTriangle:i,triangleCount:1}))};return mesh;
}
describe('canonical mineral facade finishes',()=>{
  it('gives neighbouring canonical shells distinct subdued value and temperature without independent window noise',()=>{
    const palette=Array.from({length:32},(_,i)=>gameFacadePalette(id(i),'panel'));
    expect(new Set(palette.map(JSON.stringify)).size).toBe(4);
    const values=palette.map(c=>c[0]*.2126+c[1]*.7152+c[2]*.0722);
    expect(Math.max(...values)-Math.min(...values)).toBeGreaterThan(.1);
    expect(palette.flat().every(v=>v>=.4&&v<=.95)).toBe(true);
  });
  it('preserves compiled floor shading, canonical owners and exact texture/geometry arrays at every LOD',()=>{
    const near=fixture(),far=fixture([id(2),id(1)]),original={position:near.geometry.getAttribute('position').array,uv:near.geometry.getAttribute('uv').array,index:near.geometry.index!.array,
      color:near.geometry.getAttribute('color').array,material:near.material,map:near.material.map,ranges:JSON.stringify(near.userData.featureRanges)};
    expect(applyGameFacadeAppearance(near)).toBe(true);expect(applyGameFacadeAppearance(far)).toBe(true);
    const nc=near.geometry.getAttribute('color'),fc=far.geometry.getAttribute('color');
    for(let v=0;v<3;v++)for(const [get,c]of [[nc.getX.bind(nc),0],[nc.getY.bind(nc),1],[nc.getZ.bind(nc),2]] as const)
      expect(get(v)).toBeCloseTo([.82,.98,1][v]!*gameFacadePalette(id(1),'panel')[c]!,6);
    expect(nc.getX(0)).toBeCloseTo(fc.getX(3),7);
    expect(near.geometry.getAttribute('position').array).toBe(original.position);expect(near.geometry.getAttribute('uv').array).toBe(original.uv);
    expect(near.geometry.index!.array).toBe(original.index);expect(nc.array).toBe(original.color);expect(near.material).toBe(original.material);expect(near.material.map).toBe(original.map);
    expect(JSON.stringify(near.userData.featureRanges)).toBe(original.ranges);expect(near.geometry.userData.facadeAppearance.extraRetainedBytes).toBe(0);
    const first=[...nc.array];expect(applyGameFacadeAppearance(near)).toBe(false);expect([...nc.array]).toEqual(first);
  });
  it('retains nonmatching balcony colours in a shared plaster material batch',()=>{
    const tinted=Array.from({length:12},(_,i)=>id(i)).find(owner=>hash(`facade:${owner}`)%6!==5)!;
    const mesh=fixture([tinted]),color=mesh.geometry.getAttribute('color');color.setXYZ(1,.8,.8,.8);
    expect(applyGameFacadeAppearance(mesh)).toBe(true);expect([color.getX(1),color.getY(1),color.getZ(1)]).toEqual([Math.fround(.8),Math.fround(.8),Math.fround(.8)]);
  });
  it('lets indistinguishable gray parts in the neutral tint bucket follow the material finish without changing their shade',()=>{
    const neutral=Array.from({length:12},(_,i)=>id(i)).find(owner=>hash(`facade:${owner}`)%6===5)!,mesh=fixture([neutral],'plaster');
    const color=mesh.geometry.getAttribute('color');color.setXYZ(1,.8,.8,.8);expect(applyGameFacadeAppearance(mesh)).toBe(true);
    expect(color.getX(1)).toBeCloseTo(.8*gameFacadePalette(neutral,'plaster')[0],6);
    expect(mesh.geometry.userData.facadeAppearance.neutralTintParts).toContain('balcony');
  });
  it('does not partially recolour malformed, shared or incomplete owner geometry',()=>{
    for(const damage of [(m:Mesh)=>m.geometry.index!.setX(4,0),(m:Mesh)=>m.userData.featureRanges[1].firstTriangle=0,
      (m:Mesh)=>m.userData.featureRanges.pop(),(m:Mesh)=>m.geometry.getAttribute('color').setX(5,NaN)]){
      const mesh=fixture();damage(mesh);const before=[...mesh.geometry.getAttribute('color').array];
      expect(applyGameFacadeAppearance(mesh)).toBe(false);expect([...mesh.geometry.getAttribute('color').array]).toEqual(before);
      expect(mesh.geometry.userData.facadeAppearance.state).toBe('original_retained');
    }
  });
  it('leaves original brick, timber, glass, roof and legacy atlas materials untouched',()=>{
    for(const family of ['brick','timber','windows','metal','industrial']){const mesh=fixture(undefined,family),before=[...mesh.geometry.getAttribute('color').array];
      expect(applyGameFacadeAppearance(mesh)).toBe(false);expect([...mesh.geometry.getAttribute('color').array]).toEqual(before);}
    const mesh=fixture();delete mesh.material.userData.sourceId;expect(applyGameFacadeAppearance(mesh)).toBe(false);
    expect(()=>gameFacadePalette('invented-id','panel')).toThrow();expect(GAME_FACADE_APPEARANCE_VERSION).toBeTruthy();
  });
});
