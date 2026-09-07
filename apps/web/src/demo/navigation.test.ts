import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT, decodeLocation, encodeLocation } from './navigation';

describe('public demo navigation', () => {
  it('restores observed year separately from fictional scenarios and visual clock', () => {
    const context = {...DEFAULT_CONTEXT, observedYear:2023, year:2033, scenario:'ageing' as const, presentationMinutes:300};
    const restored = decodeLocation(encodeLocation('analytics', context));
    expect(restored.context.observedYear).toBe(2023);
    expect(restored.context.year).toBe(2033);
    expect(restored.context.analyticsSource).toBe('observed');
    expect(decodeLocation('#/world').context.analyticsSource).toBe('observed');
    expect(decodeLocation('#/analytics?stats=fictional').context.analyticsSource).toBe('fictional');
  });
  it('keeps demographic and presentation clocks separate through reload', () => {
    const context = {...DEFAULT_CONTEXT, year:2034, presentationMinutes:1110, scenario:'inflow' as const, cohort:{sex:'female' as const}};
    const restored=decodeLocation(encodeLocation('analytics',context,'person:demo-person-12'));
    expect(restored.context).toEqual(context);
    expect(restored.route).toBe('analytics');
    expect(restored.selection).toBe('person:demo-person-12');
  });
  it('bounds untrusted URL values without scientific fallback claims', () => {
    const value=decodeLocation('#/world?year=9999&zoom=999&pitch=99&scenario=bogus&minutes=nan');
    expect(value.context.year).toBe(2036);
    expect(value.context.camera.pitch).toBe(60);
    expect(value.context.camera.zoom).toBe(20);
    expect(value.context.scenario).toBe('baseline');
    expect(value.context.presentationMinutes).toBe(1100);
  });
  it('preserves comparison, search and pagination through map and reload',()=>{
    const context={...DEFAULT_CONTEXT,comparisonScenario:'ageing' as const,scenario:'inflow' as const,agentQuery:'Мария',agentOffset:50};
    expect(decodeLocation(encodeLocation('world',context)).context).toEqual(context);
  });
  it('preserves explicit dataset versions and delegates an omitted dataset to the loader', () => {
    const context = {...DEFAULT_CONTEXT, datasetId:'omnitwin-public-fictional-chelyabinsk-v2'};
    expect(decodeLocation(encodeLocation('agents', context)).context.datasetId).toBe(context.datasetId);
    expect(decodeLocation('#/world').context.datasetId).toBe('');
    expect(new URLSearchParams(encodeLocation('world', {...context, datasetId:''}).split('?')[1]).has('dataset')).toBe(false);
  });
  it('keeps old resident links on their original dataset unless explicitly overridden', () => {
    expect(decodeLocation('#/world?selected=person:demo-p-000001').context.datasetId).toBe('omnitwin-public-fictional-chelyabinsk-v1');
    expect(decodeLocation('#/world?dataset=city-v2&selected=person:demo-p-000001').context.datasetId).toBe('city-v2');
    expect(decodeLocation('#/world?selected=person:city-p-000001').context.datasetId).toBe('');
  });
  it('supports bounded city-scale page offsets and employment cohorts', () => {
    const context = {...DEFAULT_CONTEXT, agentOffset:750000, cohort:{employment:'retired' as const}};
    expect(decodeLocation(encodeLocation('agents', context)).context).toEqual(context);
    expect(decodeLocation('#/agents?offset=999999999').context.agentOffset).toBe(10000000);
  });
  it('round-trips close camera detail and late city-scale scenario pages', () => {
    const context = {...DEFAULT_CONTEXT, scenario:'inflow' as const, year:2036, agentOffset:1422000, camera:{...DEFAULT_CONTEXT.camera,zoom:18.335}};
    expect(decodeLocation(encodeLocation('world',context)).context).toEqual(context);
    expect(decodeLocation(encodeLocation('agents',{...context,agentOffset:9999950})).context.agentOffset).toBe(9999950);
    expect(decodeLocation('#/world?zoom=20').context.camera.zoom).toBe(20);
  });
});
