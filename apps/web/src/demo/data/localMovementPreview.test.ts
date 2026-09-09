import {describe,it,expect} from 'vitest';
import {acceptsLocalMovementPreview,parseLocalMovementPreview} from './localMovementPreview';
const local='http://127.0.0.1:5178/OmniTwin-demo/#/world?graphics=tiled_game&dataset=omnitwin-fictional-city-v2';
describe('local movement preview isolation',()=>{
  it('requires localhost, development and the explicit new backend/dataset',()=>{
    expect(acceptsLocalMovementPreview(true,local)).toBe(true);
    for(const [dev,url] of [[false,local],[true,local.replace('127.0.0.1:5178','arseniy24rus.github.io')],[true,local.replace('tiled_game','native_map')],[true,local.replace('fictional-city-v2','public-fictional-chelyabinsk-v1')]] as const)expect(acceptsLocalMovementPreview(dev,url)).toBe(false);
  });
  it('accepts the clean local V2 deployment default without overriding explicit native or legacy links',()=>{
    const clean='http://127.0.0.1:5178/OmniTwin-demo/';
    expect(acceptsLocalMovementPreview(true,clean,'omnitwin-fictional-city-v2')).toBe(true);
    for(const href of [clean+'#/world?graphics=native_map',clean+'#/world?dataset=omnitwin-public-fictional-chelyabinsk-v1',clean+'#/world?selected=person:demo-p-0001',clean+'#/world?dataset=omnitwin-fictional-city-v2'])expect(acceptsLocalMovementPreview(true,href,'omnitwin-fictional-city-v2')).toBe(false);
    expect(acceptsLocalMovementPreview(false,clean,'omnitwin-fictional-city-v2')).toBe(false);
    expect(acceptsLocalMovementPreview(true,clean,'omnitwin-public-fictional-chelyabinsk-v1')).toBe(false);
  });
  it('accepts only a pinned manifest in its own namespace',()=>{
    const base='http://localhost:5178/OmniTwin-demo/',pin={manifestUrl:'manifest.json',manifestSha256:'a'.repeat(64)};
    expect(parseLocalMovementPreview(pin,base).manifestUrl).toBe(base+'movement-preview-v2/manifest.json');
    for(const manifestUrl of ['../city-v2/manifest.json','https://foreign.test/manifest.json','manifest.json?key=x'])expect(()=>parseLocalMovementPreview({...pin,manifestUrl},base)).toThrow('namespace');
    expect(()=>parseLocalMovementPreview({...pin,manifestSha256:'bad'},base)).toThrow('pinned');
  });
});
