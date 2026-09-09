import {describe,it,expect} from 'vitest';
import {createExpression} from '@maplibre/maplibre-gl-style-spec';
import {BUILDING_FACADE_PATTERN_EXPRESSION} from '../buildingSource';
import {canonicalFacadeVariant,CANONICAL_FACADE_VARIANT_EXPRESSION} from '../buildingFacadePolicy';

describe('native canonical facade grammar',()=>{
  it('varies unobserved apartment facade grammar by stable identity while respecting explicit materials',()=>{
    const parsed=createExpression(BUILDING_FACADE_PATTERN_EXPRESSION,'layers[0].paint.fill-extrusion-pattern');
    expect(parsed.result).toBe('success');if(parsed.result!=='success')return;
    const evaluate=(id:number,props:Record<string,unknown>={})=>parsed.value.evaluate({zoom:17},{id,type:'Polygon',properties:{building:'apartments',height:24,...props}} as never);
    const variants=Array.from({length:12},(_,i)=>evaluate(100+i));
    expect(new Set(variants).size).toBeGreaterThanOrEqual(3);
    for(let i=0;i<12;i++)expect(evaluate(100+i,{canonical_id:`openmaptiles_buildings:${100+i}`})).toBe(variants[i]);
    expect(evaluate(101,{'building:material':'brick'})).toBe('omnitwin:facade-brick');
    expect(evaluate(102,{'building:material':'concrete'})).toBe('omnitwin:facade-concrete');
    expect(evaluate(103,{building:'industrial'})).toBe('omnitwin:facade-industrial');
    expect(evaluate(103,{building:'school'})).toBe('omnitwin:facade-civic');
  });
  it('keeps canonical GeoJSON identity authoritative despite a nonnumeric promoted tile ID',()=>{
    const parsed=createExpression(CANONICAL_FACADE_VARIANT_EXPRESSION,'variant');
    if(parsed.result!=='success')throw Error('Invalid canonical finish expression');
    for(const id of ['openmaptiles_buildings:10','openmaptiles_buildings:853220400','openmaptiles_buildings:159526353']){
      expect(parsed.value.evaluate({zoom:17},{id:NaN,type:'Polygon',properties:{canonical_id:id}} as never)).toBe(canonicalFacadeVariant(id));
    }
    expect(new Set(Array.from({length:16},(_,i)=>canonicalFacadeVariant(`openmaptiles_buildings:${10000+i*10}`))).size).toBe(4);
  });
});
