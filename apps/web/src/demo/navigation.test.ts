import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT, decodeLocation, encodeLocation } from './navigation';

describe('public demo navigation', () => {
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
    expect(value.context.camera.zoom).toBe(18);
    expect(value.context.scenario).toBe('baseline');
    expect(value.context.presentationMinutes).toBe(1100);
  });
  it('preserves comparison, search and pagination through map and reload',()=>{
    const context={...DEFAULT_CONTEXT,comparisonScenario:'ageing' as const,scenario:'inflow' as const,agentQuery:'Мария',agentOffset:50};
    expect(decodeLocation(encodeLocation('world',context)).context).toEqual(context);
  });
});
