import { describe, expect, it } from 'vitest';
import { actorBuildingOcclusion, type ActorOccluderFeature } from './actorOcclusion';
const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
const building: ActorOccluderFeature = { layer: { type: 'fill-extrusion' }, properties: { height: 5 }, geometry: { type: 'Polygon', coordinates: [square] } };
const project = ([x, y, z]: readonly [number, number, number]) => [x, y, -z] as const;
describe('bounded click-only source-building occlusion', () => {
  it('rejects an actor behind a roof but keeps an actor in front and an open-road target', () => {
    const common = { features: [building], zoom: 17, project };
    expect(actorBuildingOcclusion({ ...common, point: [5, 5], actorNearestDepth: 0 })).toBe('occluded');
    expect(actorBuildingOcclusion({ ...common, point: [5, 5], actorNearestDepth: -6 })).toBe('clear');
    expect(actorBuildingOcclusion({ ...common, point: [15, 5], actorNearestDepth: 0 })).toBe('clear');
  });
  it('preserves courtyard holes and tests extruded side walls', () => {
    const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
    const courtyard = { ...building, geometry: { type: 'Polygon', coordinates: [square, hole] } };
    expect(actorBuildingOcclusion({ features: [courtyard], zoom: 17, project, point: [5, 5], actorNearestDepth: 0 })).toBe('clear');
    expect(actorBuildingOcclusion({ features: [building], zoom: 17, project: ([x, y, z]) => [x, y - z, -z], point: [5, -2], actorNearestDepth: 0 })).toBe('occluded');
  });
  it('fails closed on invalid geometry or exceeded click budget', () => {
    expect(actorBuildingOcclusion({ features: Array(65).fill(building), zoom: 17, project, point: [5, 5], actorNearestDepth: 0 })).toBe('unavailable');
    expect(actorBuildingOcclusion({ features: [{ geometry: null }], zoom: 17, project, point: [5, 5], actorNearestDepth: 0 })).toBe('unavailable');
  });
});
