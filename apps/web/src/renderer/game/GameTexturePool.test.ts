import {describe,expect,it,vi} from 'vitest';
import {Texture,Group,Mesh,BoxGeometry,MeshBasicMaterial} from 'three';
import {GameTexturePool,geometryResidentBytes} from './GameTexturePool';

describe('shared city texture ownership',()=>{
  it('decodes one shared texture, survives individual tile disposal and releases on city disposal',async()=>{
    const dispose=vi.fn(),texture=new Texture({width:512,height:512} as unknown as HTMLImageElement);
    texture.addEventListener('dispose',dispose);
    const load=vi.fn(async()=>texture),pool=new GameTexturePool({maxBytes:4*1024*1024});
    const [a,b]=await Promise.all([pool.acquire('same',load),pool.acquire('same',load)]);
    expect(a).toBe(b);expect(load).toHaveBeenCalledTimes(1);
    a.dispose();b.dispose();expect(dispose).not.toHaveBeenCalled();
    expect(pool.bytes).toBe(Math.ceil(512*512*4*(1+4/3)));
    pool.dispose();pool.dispose();expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('rejects failed/oversized decoding without retaining an unusable entry',async()=>{
    const pool=new GameTexturePool({maxBytes:100});
    const texture=new Texture({width:512,height:512} as unknown as HTMLImageElement),dispose=vi.fn();texture.addEventListener('dispose',dispose);
    await expect(pool.acquire('large',async()=>texture)).rejects.toThrow(/budget/);
    expect(dispose).toHaveBeenCalledOnce();expect(pool.bytes).toBe(0);
    await expect(pool.acquire('broken',async()=>{throw Error('decode');})).rejects.toThrow('decode');
    expect(pool.count).toBe(0);pool.dispose();
  });
  it('counts geometry once per tile without charging shared textures for every material',()=>{
    const group=new Group(),geometry=new BoxGeometry(),material=new MeshBasicMaterial({map:new Texture()});
    group.add(new Mesh(geometry,material),new Mesh(geometry,material));
    const attributes=Object.values(geometry.attributes).reduce((sum,a)=>sum+a.array.byteLength,0)+geometry.index!.array.byteLength;
    expect(geometryResidentBytes(group)).toBe(attributes*2);
    geometry.dispose();material.dispose();
  });
});
