import { describe, expect, it } from 'vitest';
import { ActorColumnsBridge } from './actorColumnsBridge';
import { buildActorRoadHints, createActorFootprintClearance } from './actorFootprintClearance';
import { LaneTraffic } from './laneTraffic';
import { GameMotionWorkerCore } from './GameMotionWorkerCore';
import { gameMotionTransferables, type GameMotionSource, type GameMotionResponse } from './gameMotionProtocol';

const origin = { longitude: 61.4, latitude: 55.16 }, epochSeconds = Date.UTC(2026, 0, 1) / 1000;
function sourceAt(seconds = 0): GameMotionSource {
  const ids = ['car', 'walker'], kinds = ['vehicle', 'person'] as const;
  const rows = ids.map((id, index) => {
    const speed = index ? 1.4 : 7, start = index ? [61.4, 55.159] : [61.399, 55.16];
    const degrees = speed * seconds / (111195 * (index ? 1 : Math.cos(55.16 * Math.PI / 180)));
    return { id, kind: kinds[index]!, longitude: start[0]! + (index ? 0 : .0008 + degrees),
      latitude: start[1]! + (index ? .0008 + degrees : 0), speed };
  });
  return {
    origin, epochSeconds,
    entities: rows.map(row => ({ ...row, representation: 'focus_person_1to1', representedCount: 1, heading: 90,
      activity: 'walk', color: '#dddddd', seed: 15 })),
    presentationMovement: { nodes: [], edges: ids.map((id, index) => ({ edgeId: id,
      fromNodeId: `presence:${id}:start`, toNodeId: `presence:${id}:end`, edgeKind: index ? 'sidewalk' : 'lane',
      crossesRoad: false, direction: 'bidirectional', allowedModes: [index ? 'pedestrian' : 'car'],
      geometry: index ? [[61.4, 55.159], [61.4, 55.161]] : [[61.399, 55.16], [61.401, 55.16]],
      visualSpeedMetersPerSecond: { pedestrian: index ? 1.4 : null, car: index ? null : 7, bicycle: null, transit: null } })),
      routes: ids.map((id, index) => ({ routeId: id, mode: index ? 'pedestrian' : 'car', edgeIds: [id], traversal: 'once' })) },
    mobilityPresentationMovement: rows.map(row => ({ id: row.id, entityKind: row.kind,
      presentationTime: new Date((epochSeconds + seconds) * 1000).toISOString(),
      motion: { mode: 'network_edge', edgeId: row.id, routeId: row.id, progress: .4, speedMps: row.speed, direction: 'forward' } })),
    verifiedCityBuildings: { datasetVersion: 'fixture', signature: 'fixture', coverage: 'complete_viewport',
      canonicalIds: new Set(['building']), cells: ['fixture'], omittedBuildings: 0, invalidBuildings: 0, vertexCount: 5,
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'building', properties: {},
        geometry: { type: 'Polygon', coordinates: [[[61.4004,55.1604],[61.4005,55.1604],[61.4005,55.1605],[61.4004,55.1605],[61.4004,55.1604]]] } }] } },
    verifiedCityBuildingBounds: [61.39, 55.15, 61.41, 55.17],
    gameSourceRoads: ids.map((id, index) => ({ id, coordinates: [], nodeIds: [], oneway: false, walkable: true,
      drivable: !index, className: index ? 'footway' : 'residential', startNodeId: 'a', endNodeId: 'b', lanes: index ? null : 2,
      maxspeed: null, bridge: false, tunnel: false, layer: 0 })), gameSourceCorridors: [],
  };
}
function synchronous(source: GameMotionSource, laneTraffic: LaneTraffic) {
  const clearance = source.verifiedCityBuildingBounds ? createActorFootprintClearance({ snapshot: source.verifiedCityBuildings,
    origin: source.origin, viewportBounds: source.verifiedCityBuildingBounds }) : null;
  return new ActorColumnsBridge(source.entities, source.presentationMovement, source.mobilityPresentationMovement,
    source.origin, source.epochSeconds, { laneTraffic, sourceMetric: 'provider_equirectangular_111195', onceEndpointFadeMeters: 15,
      derivePairedSidewalks: Boolean(clearance), isPointClear: clearance?.isPointClear,
      roadHintsByEdgeId: buildActorRoadHints(source.presentationMovement, source.gameSourceRoads, source.gameSourceCorridors) });
}
function frame(response: GameMotionResponse) {
  expect(response.type).toBe('sample'); if (response.type !== 'sample') throw Error(JSON.stringify(response)); return response;
}

describe('persistent motion worker core', () => {
  it('matches synchronous columns, signals and traffic across ordinary source refresh and explicit reset', () => {
    const core = new GameMotionWorkerCore(), lane = new LaneTraffic(); let bridge = synchronous(sourceAt(), lane);
    const configured = core.handle({ type: 'configure', requestId: 1, generation: 1, sourceRevision: 1, source: sourceAt() });
    expect(configured.type).toBe('configured');
    if (configured.type === 'configured') expect(configured.diagnostics.sidewalk.guard?.polygons).toBe(1);
    for (const time of [0, .2, .4, 5]) {
      const reply = frame(core.handle({ type: 'sample', requestId: 2, generation: 1, sourceRevision: 1, timeSeconds: time, horizonSeconds: .25 }));
      expect(reply.columns).toEqual(bridge.sample(time, .25));
      expect(reply.signals).toEqual(lane.readSignals()); expect(reply.trafficProbe).toEqual(lane.readProbe());
    }
    bridge = synchronous(sourceAt(5), lane);
    expect(core.handle({ type: 'configure', requestId: 3, generation: 1, sourceRevision: 2, source: sourceAt(5) }).type).toBe('configured');
    const refreshed = frame(core.handle({ type: 'sample', requestId: 4, generation: 1, sourceRevision: 2, timeSeconds: 5.2, horizonSeconds: .25 }));
    expect(refreshed.columns).toEqual(bridge.sample(5.2, .25)); expect(refreshed.trafficProbe).toEqual(lane.readProbe());
    expect(core.handle({ type: 'configure', requestId: 5, generation: 2, sourceRevision: 1, source: sourceAt() }).type).toBe('configured');
    const resetLane = new LaneTraffic(), resetBridge = synchronous(sourceAt(), resetLane);
    const reset = frame(core.handle({ type: 'sample', requestId: 6, generation: 2, sourceRevision: 1, timeSeconds: 0, horizonSeconds: .25 }));
    expect(reset.columns).toEqual(resetBridge.sample(0, .25)); expect(reset.trafficProbe).toEqual(resetLane.readProbe());
  });

  it('transfers output copies without detaching retained bridge arrays or later snapshots', () => {
    const core = new GameMotionWorkerCore(); core.handle({ type: 'configure', requestId: 1, generation: 1, sourceRevision: 1, source: sourceAt() });
    const first = frame(core.handle({ type: 'sample', requestId: 2, generation: 1, sourceRevision: 1, timeSeconds: 0, horizonSeconds: .25 }));
    const delivered = structuredClone(first, { transfer: gameMotionTransferables(first) });
    expect(first.columns.previousPositions.byteLength).toBe(0);
    const preserved = delivered.columns.previousPositions.slice(), signals = structuredClone(delivered.signals);
    const second = frame(core.handle({ type: 'sample', requestId: 3, generation: 1, sourceRevision: 1, timeSeconds: .2, horizonSeconds: .25 }));
    expect(second.columns.previousPositions.byteLength).toBe(24);
    expect(delivered.columns.previousPositions).toEqual(preserved); expect(delivered.signals).toEqual(signals);
  });

  it('rejects stale generations/revisions and invalid samples without advancing current state', () => {
    const core = new GameMotionWorkerCore(); core.handle({ type: 'configure', requestId: 1, generation: 2, sourceRevision: 3, source: sourceAt() });
    expect(core.handle({ type: 'sample', requestId: 2, generation: 1, sourceRevision: 3, timeSeconds: 0, horizonSeconds: .25 })).toMatchObject({ type: 'rejected', code: 'stale_generation' });
    expect(core.handle({ type: 'sample', requestId: 3, generation: 2, sourceRevision: 2, timeSeconds: 0, horizonSeconds: .25 })).toMatchObject({ type: 'rejected', code: 'source_revision_mismatch' });
    expect(core.handle({ type: 'sample', requestId: 4, generation: 2, sourceRevision: 3, timeSeconds: NaN, horizonSeconds: .25 }).type).toBe('rejected');
    const sample = frame(core.handle({ type: 'sample', requestId: 5, generation: 2, sourceRevision: 3, timeSeconds: 0, horizonSeconds: .25 }));
    expect(sample.trafficProbe.time).toBe(0);
    expect(core.handle({ type: 'sample', requestId: 6, generation: 2, sourceRevision: 3, timeSeconds: -.2, horizonSeconds: .25 })).toMatchObject({ type: 'rejected', code: 'clock_regression' });
  });

  it('deduplicates identical source payloads, rejects revision conflicts and reports bounded failures explicitly', () => {
    const core = new GameMotionWorkerCore(); const source = sourceAt();
    core.handle({ type: 'configure', requestId: 1, generation: 1, sourceRevision: 1, source });
    expect(core.handle({ type: 'configure', requestId: 2, generation: 1, sourceRevision: 1, source: structuredClone(source) })).toMatchObject({ type: 'configured', reused: true, cost: { bridgeBuilds: 1 } });
    expect(core.handle({ type: 'configure', requestId: 3, generation: 1, sourceRevision: 1, source: sourceAt(5) })).toMatchObject({ type: 'rejected', code: 'source_revision_conflict' });
    expect(core.handle({ type: 'configure', requestId: 4, generation: 2, sourceRevision: 1,
      source: { ...source, entities: Array(4097).fill(source.entities[0]) } })).toMatchObject({ type: 'rejected', code: 'invalid_source' });
    expect(core.handle({ type: 'sample', requestId: 5, generation: 2, sourceRevision: 1, timeSeconds: 0, horizonSeconds: .25 }).type).toBe('rejected');
  });

  it('pins a complete bounded DEV probe to its returned sample without enlarging production summaries', () => {
    const base = sourceAt(), count = 140;
    const source = { ...base, entities: Array.from({ length: count }, (_, i) => ({ ...base.entities[1]!, id: `walker-${i}` })),
      mobilityPresentationMovement: Array.from({ length: count }, (_, i) => ({ ...base.mobilityPresentationMovement[1]!, id: `walker-${i}` })) };
    const production = new GameMotionWorkerCore(), development = new GameMotionWorkerCore({ includeFullProbe: true });
    for (const core of [production, development]) core.handle({ type: 'configure', requestId: 1, generation: 1, sourceRevision: 1, source });
    const request = { type: 'sample' as const, requestId: 2, generation: 1, sourceRevision: 1, timeSeconds: 0, horizonSeconds: .25 };
    const prod = frame(production.handle(request)), dev = frame(development.handle(request));
    expect(prod.fullTrafficProbe).toBeUndefined(); expect(prod.trafficProbe.pedestrians).toHaveLength(64);
    expect(dev.fullTrafficProbe!.pedestrians).toHaveLength(count); expect(dev.columns).toEqual(prod.columns);
    expect(dev.timings.fullProbeJsonBytes).toBeGreaterThan(0);
    const preserved = structuredClone(dev.fullTrafficProbe);
    development.handle({ ...request, requestId: 3, timeSeconds: .25 });
    expect(dev.fullTrafficProbe).toEqual(preserved); expect(dev.fullTrafficProbe!.time).toBe(0);
  });

  it('applies source deltas only against the acknowledged same-generation base and preserves full-configure parity', () => {
    const delta = new GameMotionWorkerCore(), full = new GameMotionWorkerCore(), initial = sourceAt(), updated = sourceAt(5);
    const configure = { type: 'configure' as const, requestId: 1, generation: 1, sourceRevision: 1, source: initial };
    delta.handle(configure); full.handle(configure);
    const sample = { type: 'sample' as const, requestId: 2, generation: 1, sourceRevision: 1, timeSeconds: 5, horizonSeconds: .25 };
    delta.handle(sample); full.handle(sample);
    const patch = { type: 'configure' as const, requestId: 3, generation: 1, sourceRevision: 2, baseSourceRevision: 1,
      sourcePatch: { entities: updated.entities, mobilityPresentationMovement: updated.mobilityPresentationMovement } };
    expect(delta.handle(patch).type).toBe('configured');
    full.handle({ ...configure, requestId: 3, sourceRevision: 2, source: updated });
    const a = frame(delta.handle({ ...sample, requestId: 4, sourceRevision: 2, timeSeconds: 5.25 }));
    const b = frame(full.handle({ ...sample, requestId: 4, sourceRevision: 2, timeSeconds: 5.25 }));
    expect(a.columns).toEqual(b.columns); expect(a.signals).toEqual(b.signals); expect(a.trafficProbe).toEqual(b.trafficProbe);
    expect(delta.handle({ ...patch, requestId: 5, sourceRevision: 3 })).toMatchObject({ type: 'rejected', code: 'patch_base_mismatch' });
    expect(delta.handle({ ...patch, requestId: 6, sourceRevision: 3, baseSourceRevision: 2, sourcePatch: { mystery: true } })).toMatchObject({ type: 'rejected', code: 'invalid_source_patch' });
    delta.handle({ type: 'reset', requestId: 7, generation: 2 });
    expect(delta.handle({ ...patch, requestId: 8, generation: 2 })).toMatchObject({ type: 'rejected', code: 'patch_base_missing' });
  });

  it('reports solver failure explicitly and requires a new generation before sampling resumes', () => {
    const core = new GameMotionWorkerCore(), source = sourceAt();
    const broken = { ...source, presentationMovement: { ...source.presentationMovement!,
      edges: [{ ...source.presentationMovement!.edges[0]!, geometry: null }] } };
    expect(core.handle({ type: 'configure', requestId: 1, generation: 1, sourceRevision: 1, source: broken })).toMatchObject({ type: 'error', code: 'source_solver_failed' });
    expect(core.handle({ type: 'configure', requestId: 2, generation: 1, sourceRevision: 2, source })).toMatchObject({ type: 'rejected', code: 'generation_failed' });
    expect(core.handle({ type: 'sample', requestId: 3, generation: 1, sourceRevision: 1, timeSeconds: 0, horizonSeconds: .25 })).toMatchObject({ type: 'rejected', code: 'not_configured' });
    expect(core.handle({ type: 'configure', requestId: 4, generation: 2, sourceRevision: 1, source }).type).toBe('configured');
    expect(frame(core.handle({ type: 'sample', requestId: 5, generation: 2, sourceRevision: 1, timeSeconds: 0, horizonSeconds: .25 })).columns.ids).toEqual(['car', 'walker']);
  });

  it('keeps targeted probes read-only and rejects oversized horizons and samples after disposal', () => {
    const core = new GameMotionWorkerCore(); core.handle({ type: 'configure', requestId: 1, generation: 1, sourceRevision: 1, source: sourceAt() });
    const first = frame(core.handle({ type: 'sample', requestId: 2, generation: 1, sourceRevision: 1, timeSeconds: 0, horizonSeconds: .25 }));
    const probe = core.handle({ type: 'probe', requestId: 3, generation: 1, sourceRevision: 1, probeIds: ['walker'] });
    expect(probe.type).toBe('probe');
    if (probe.type === 'probe') { expect(probe.signals).toEqual(first.signals); expect(probe.trafficProbe.time).toBe(0);
      expect(probe.trafficProbe.vehicles).toHaveLength(0); expect(probe.trafficProbe.pedestrians.map(row => row.id)).toEqual(['walker']); }
    expect(core.handle({ type: 'sample', requestId: 4, generation: 1, sourceRevision: 1, timeSeconds: .25, horizonSeconds: 2.01 }).type).toBe('rejected');
    expect(core.handle({ type: 'dispose', requestId: 5, generation: 1 }).type).toBe('disposed');
    expect(core.handle({ type: 'sample', requestId: 6, generation: 1, sourceRevision: 1, timeSeconds: .25, horizonSeconds: .25 })).toMatchObject({ type: 'rejected', code: 'disposed' });
  });
});
