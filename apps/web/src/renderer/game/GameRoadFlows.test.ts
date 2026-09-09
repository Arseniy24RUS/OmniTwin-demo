import { describe, it, expect } from 'vitest';
import { MercatorCoordinate } from 'maplibre-gl';
import * as THREE from 'three';
import { createPresentationMeterBridge } from '../presentationMeterBridge';
import type { AggregateRoadFlowSnapshot } from '../aggregateRoadFlow';
import { createGameFlowCoordinateConverter, GameRoadFlows, GAME_ROAD_FLOW_CAP } from './GameRoadFlows';

describe('game schematic road flow', () => {
  it('inverts already bridged Deck offsets into the exact native city Mercator frame', () => {
    const source = [61.42, 55.18] as const, target = [61.39466, 55.1654] as const;
    const bridge = createPresentationMeterBridge(source), convert = createGameFlowCoordinateConverter(source, target);
    const origin = MercatorCoordinate.fromLngLat([...target]), unit = origin.meterInMercatorCoordinateUnits();
    for (const [lon, lat] of [[61.1, 55.0], [61.42, 55.18], [61.6, 55.35]]) {
      const point = convert(bridge.fromGeographic(lon!, lat!, 0.12));
      const expected = MercatorCoordinate.fromLngLat([lon!, lat!], 0.12);
      expect(point.x).toBeCloseTo((expected.x - origin.x) / unit, 5);
      expect(point.z).toBeCloseTo((expected.y - origin.y) / unit, 5);
      expect(point.y).toBeCloseTo(expected.z / unit, 7);
    }
  });
  it('has a single unpickable draw and retains buffers during clock/camera updates', () => {
    const flows = new GameRoadFlows({ origin: [61.4, 55.17] });
    expect(flows.object.children).toHaveLength(1);
    const mesh = flows.object.children[0] as THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
    const before = mesh.geometry.getAttribute('flowStart'); const version = before.version;
    for (let t = 0; t < 100; t++) { flows.setTime(1000 + t); flows.updateCamera(new THREE.Camera(), 1920, 1080); }
    expect(mesh.geometry.getAttribute('flowStart')).toBe(before); expect(before.version).toBe(version);
    expect(mesh.material.depthTest).toBe(true); expect(mesh.material.depthWrite).toBe(false);
    expect(mesh.userData.pickable).toBe(false); expect(flows.telemetry.pickable).toBe(false);
    expect(() => flows.setTime(1.7e9)).toThrow('elapsed');
    flows.dispose(); expect(flows.object.children).toHaveLength(0);
  });
  it('updates membership only on a new signature and clears atomically', () => {
    const flows = new GameRoadFlows({ origin: [61.4, 55.17] });
    const snapshot: AggregateRoadFlowSnapshot = {
      representation: 'schematic_road_flow', sourceLabel: 'OSM source road', signature: 'source-version/cell-a', origin: [61.4, 55.17], timeOriginSeconds: Date.UTC(2026, 0, 1) / 1000,
      segments: [{ id: 'flow-road-a', sourceRoadId: 'road-a', start: [0, 0, 0.12], end: [100, 0, 0.12], phase: 0.2, speedMps: 8, lengthMeters: 100 }],
      diagnostics: { inputRoads: 1, invalidRoads: 0, excludedNonDrivableRoads: 0, scannedSegments: 1, invalidSegments: 0, skippedShortSegments: 0, outsideDistanceSegments: 0, withinDistanceSegments: 1, peakRetainedCandidates: 1 },
    };
    flows.setSnapshot(snapshot); expect(flows.telemetry.segments).toBe(1); const version = flows.telemetry.bufferUpdates;
    flows.setSnapshot(snapshot); expect(flows.telemetry.bufferUpdates).toBe(version);
    expect(() => flows.setSnapshot({ ...snapshot, signature: 'overflow', segments: Array.from({ length: GAME_ROAD_FLOW_CAP + 1 }, () => snapshot.segments[0]!) })).toThrow('cap');
    expect(flows.telemetry.segments).toBe(1);
    flows.setSnapshot(null); expect(flows.telemetry.segments).toBe(0);
    flows.dispose();
  });
});
