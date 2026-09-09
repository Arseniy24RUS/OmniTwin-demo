import type { StyleSpecification } from 'maplibre-gl';

export type CityGraphicsBackend = 'native_map' | 'tiled_game';
export type CityBounds = readonly [number, number, number, number];
export const NATIVE_GAME_FALLBACK_ID = 'game-native-building-fallback';

/** Schematic flow is an overview only; it never masquerades as an individual car. */
export function gameOverviewOpacity(zoom: number): number {
  return Number.isFinite(zoom) ? Math.max(0, Math.min(1, (15.5 - zoom) / 0.5)) : 0;
}

/** Source coverage is independent of the extent of any detailed mesh package. */
export function canReplaceNativeCity(ready: boolean, pack: CityBounds | null, viewport: CityBounds | null): boolean {
  return Boolean(ready && pack && viewport && viewport[0] >= pack[0] && viewport[1] >= pack[1]
    && viewport[2] <= pack[2] && viewport[3] <= pack[3]);
}

/** Keep geographic materials available while canonical detail is prepared. */
export function tiledGameBasemapStyle(input: StyleSpecification): StyleSpecification {
  const building = input.layers.find(layer => 'source-layer' in layer && layer['source-layer'] === 'building');
  const hasBuildingVolumes = input.layers.some(layer => layer.type === 'fill-extrusion' && 'source-layer' in layer && layer['source-layer'] === 'building');
  const layers = input.layers.filter(layer => hasBuildingVolumes || !('source-layer' in layer && layer['source-layer'] === 'building'))
    .map(layer => {
      if (layer.type === 'background') return {...layer, paint:{...layer.paint,'background-color':'#a0a28b'}};
      if (layer.type === 'symbol' && 'source-layer' in layer && /transportation|road/i.test(layer['source-layer'] ?? '')) return {...layer,maxzoom:16};
      if (layer.type === 'fill') {
        const id=layer.id.toLowerCase();
        if (/water/.test(id) && !layer.paint?.['fill-pattern']) return {...layer,paint:{...layer.paint,'fill-color':'#587e88','fill-opacity':1}};
        if (/park|grass|wood|forest/.test(id)) {
          const paint={...layer.paint};delete paint['fill-pattern'];
          return {...layer,paint:{...paint,'fill-color':'#819366','fill-opacity':0.75}};
        }
        if (/residential/.test(id)) return {...layer,paint:{...layer.paint,'fill-color':'#b0ae98','fill-opacity':0.48}};
      }
      return layer;
    }) as StyleSpecification['layers'];
  if (!hasBuildingVolumes && building && 'source' in building) {
    const index=layers.findIndex(layer=>layer.type==='symbol');
    layers.splice(index<0?layers.length:index,0,{
      id:NATIVE_GAME_FALLBACK_ID,type:'fill-extrusion',source:building.source,'source-layer':'building',minzoom:13,
      paint:{'fill-extrusion-color':'#bbb39e','fill-extrusion-height':['coalesce',['get','render_height'],['get','height'],6],
        'fill-extrusion-base':['coalesce',['get','render_min_height'],0],'fill-extrusion-vertical-gradient':true},
    });
  }
  return {...input,layers,light:{anchor:'map',position:[1.5,205,38],color:'#fff0cf',intensity:0.5}};
}
