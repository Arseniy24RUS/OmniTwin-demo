import { describe, expect, it } from 'vitest';
import { decodeLocation, encodeLocation } from './navigation';
import { canReplaceNativeCity, gameOverviewOpacity, tiledGameBasemapStyle } from '../renderer/game/tiledGamePolicy';

describe('opt-in tiled city', () => {
  it('uses restrained land color instead of the old oversized pebble pattern', () => {
    const style=tiledGameBasemapStyle({version:8,sources:{},layers:[
      {id:'park',type:'fill',source:'omt','source-layer':'landuse',paint:{'fill-pattern':'old-grass','fill-opacity':1}},
    ]});
    expect(style.layers[0]?.paint).not.toHaveProperty('fill-pattern');
    expect(style.layers[0]?.paint).toMatchObject({'fill-color':'#819366'});
  });
  it('keeps the existing material building passes and translucent water gloss', () => {
    const style = tiledGameBasemapStyle({version:8,sources:{},layers:[
      {id:'water',type:'fill',source:'omt','source-layer':'water',paint:{'fill-color':'#579'}},
      {id:'water-gloss',type:'fill',source:'omt','source-layer':'water',paint:{'fill-pattern':'ripples','fill-opacity':0.26}},
      {id:'building-3d',type:'fill-extrusion',source:'omt','source-layer':'building',paint:{'fill-extrusion-color':'#aaa'}},
      {id:'facade',type:'fill-extrusion',source:'omt','source-layer':'building',paint:{'fill-extrusion-pattern':'facade-texture'}},
    ]});
    expect(style.layers.find(l=>l.id==='water-gloss')?.paint).toMatchObject({'fill-opacity':0.26,'fill-pattern':'ripples'});
    expect(style.layers.find(l=>l.id==='facade')?.paint).toMatchObject({'fill-extrusion-pattern':'facade-texture'});
    expect(style.layers.some(l=>l.id==='game-native-building-fallback')).toBe(false);
  });
  it('removes schematic traffic at close zoom regardless of city geometry coverage', () => {
    expect(gameOverviewOpacity(14)).toBe(1);
    expect(gameOverviewOpacity(15.25)).toBeCloseTo(0.5);
    expect(gameOverviewOpacity(15.5)).toBe(0);
    expect(gameOverviewOpacity(20)).toBe(0);
  });
  it('preserves backend through camera/selection URL updates without changing dataset', () => {
    const route = decodeLocation('#/world?graphics=tiled_game&dataset=legacy');
    expect(decodeLocation(encodeLocation('world', route.context, 'person:abc')).context.cityGraphicsBackend).toBe('tiled_game');
    expect(route.context.datasetId).toBe('legacy');
    expect(decodeLocation('#/world').context.cityGraphicsBackend).toBe('native_map');
  });
  it('never removes native city before prepared coverage contains the actual viewport', () => {
    expect(canReplaceNativeCity(false,[0,0,2,2],[0.5,0.5,1,1])).toBe(false);
    expect(canReplaceNativeCity(true,[0,0,2,2],[-1,0,1,1])).toBe(false);
    expect(canReplaceNativeCity(true,[0,0,2,2],[0.5,0.5,1,1])).toBe(true);
  });
  it('makes a lightweight fallback without duplicated extrusions or crossing street labels', () => {
    const style = tiledGameBasemapStyle({version:8,sources:{},layers:[
      {id:'background',type:'background'}, {id:'building',type:'fill',source:'omt','source-layer':'building'},
      {id:'street',type:'symbol',source:'omt','source-layer':'transportation_name'},
      {id:'city',type:'symbol',source:'omt','source-layer':'place'},
    ]});
    expect(style.layers.filter(layer=>layer.type==='fill-extrusion')).toHaveLength(1);
    expect(style.layers.find(layer=>layer.id==='street')?.maxzoom).toBe(16);
    expect(style.layers.find(layer=>layer.id==='city')).toBeDefined();
  });
});
