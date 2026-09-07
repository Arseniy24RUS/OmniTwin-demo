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
    expect(value.context.camera.zoom).toBe(18);
    expect(value.context.scenario).toBe('baseline');
    expect(value.context.presentationMinutes).toBe(1100);
  });
  it('preserves comparison, search and pagination through map and reload',()=>{
    const context={...DEFAULT_CONTEXT,comparisonScenario:'ageing' as const,scenario:'inflow' as const,agentQuery:'Мария',agentOffset:50};
    expect(decodeLocation(encodeLocation('world',context)).context).toEqual(context);
  });
});
