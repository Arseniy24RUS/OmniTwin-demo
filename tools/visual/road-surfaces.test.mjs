import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoadSurfaces } from './road-surfaces.mjs';

const origin = [61.405, 55.16];
const radians = Math.PI / 180, eccentricity2 = 6.69437999014e-3;
const sine = Math.sin(origin[1] * radians), scale = 1 - eccentricity2 * sine * sine;
const eastScale = radians * 6378137 / Math.sqrt(scale) * Math.cos(origin[1] * radians);
const northScale = radians * 6378137 * (1 - eccentricity2) / scale ** 1.5;
const geographic = ([east, north]) => [origin[0] + east / eastScale, origin[1] + north / northScale];
const options = { origin, boundsMeters: [-100, -100, 100, 100] };
const road = (id, points, extra = {}) => ({ id, coordinates: points.map(geographic),
  nodeIds: points.map((_, i) => `${id}-node-${i}`), className: 'residential',
  drivable: true, walkable: true, bridge: false, tunnel: false, layer: 0, oneway: false, ...extra });
const positions = mesh => Array.from({ length: mesh.positions.length / 3 }, (_, i) => mesh.positions.slice(i * 3, i * 3 + 3));

test('known source width produces metre-scale glTF Y-up road geometry and normalized patch UVs', () => {
  const result = buildRoadSurfaces([road('r', [[0, 0], [40, 0]], { widthM: 8 })], options);
  const surface = result.meshes.find(mesh => mesh.material === 'asphalt');
  assert.ok(surface); assert.equal(surface.provenance, 'source_geometry');
  assert.deepEqual(surface.sourceIds, ['r']);
  const points = positions(surface);
  assert.ok(Math.abs(Math.min(...points.map(p => p[0]))) < 1e-6);
  assert.ok(Math.abs(Math.max(...points.map(p => p[0])) - 40) < 1e-6);
  assert.ok(Math.abs(Math.max(...points.map(p => p[2])) - 4) < 1e-6);
  assert.ok(points.every(p => p[1] === 0.05));
  assert.ok(surface.uvs.every(value => value >= 0 && value <= 1));
  for (let i = 0; i < surface.normals.length; i += 3) assert.deepEqual(surface.normals.slice(i, i + 3), [0, 1, 0]);
  assert.equal(result.diagnostics.sourceWidthRoads, 1);
});

test('unknown widths, lane widths, curbs and markings are explicit visual synthesis', () => {
  const result = buildRoadSurfaces([
    road('class', [[0, 0], [30, 0]]),
    road('lanes', [[0, 20], [30, 20]], { lanes: 2 }),
    road('path', [[0, 40], [30, 40]], { className: 'footway', drivable: false }),
  ], options);
  assert.equal(result.diagnostics.classWidthRoads, 2);
  assert.equal(result.diagnostics.laneWidthRoads, 1);
  assert.ok(result.meshes.some(mesh => mesh.material === 'paving'));
  assert.ok(result.meshes.some(mesh => mesh.material === 'curb'));
  assert.ok(result.meshes.every(mesh => mesh.provenance === 'visual_synthesis'));
});

test('shared source node creates a bounded T-junction fan without curbs across the open mouths', () => {
  const roads = [
    road('left', [[-30, 0], [0, 0]], { nodeIds: ['left', 'junction'], widthM: 6 }),
    road('right', [[0, 0], [30, 0]], { nodeIds: ['junction', 'right'], widthM: 6 }),
    road('north', [[0, 0], [0, 30]], { nodeIds: ['junction', 'north'], widthM: 6 }),
  ];
  const result = buildRoadSurfaces(roads, options);
  assert.equal(result.diagnostics.sharedNodeJunctions, 1);
  assert.ok(result.diagnostics.junctionTriangles > 0 && result.diagnostics.junctionTriangles < 12);
  const curbs = result.meshes.filter(mesh => mesh.material === 'curb').flatMap(positions);
  assert.ok(curbs.every(([east, , south]) => Math.abs(east) >= 2 || Math.abs(south) >= 2));
  assert.ok(result.diagnostics.maxJunctionRadiusMeters < 7);
});

test('an intrinsic polyline bend is joined, but coincident unrelated node IDs are not connected', () => {
  const curved = buildRoadSurfaces([road('bend', [[-20, 0], [0, 0], [0, 20]], { widthM: 6 })], options);
  assert.equal(curved.diagnostics.polylineJunctions, 1);
  const unrelated = buildRoadSurfaces([
    road('a', [[-20, 0], [0, 0]]), road('b', [[0, 0], [0, 20]]),
  ], options);
  assert.equal(unrelated.diagnostics.sharedNodeJunctions, 0);
  assert.equal(unrelated.diagnostics.junctionTriangles, 0);
});

test('tunnels, bridges and nonzero layers are omitted explicitly instead of becoming ground roads', () => {
  const result = buildRoadSurfaces([
    road('ground', [[0, 0], [20, 0]]), road('tunnel', [[0, 10], [20, 10]], { tunnel: true }),
    road('bridge', [[0, 20], [20, 20]], { bridge: true }), road('layer', [[0, 30], [20, 30]], { layer: 1 }),
  ], options);
  assert.equal(result.diagnostics.omittedTunnelRoads, 1);
  assert.equal(result.diagnostics.omittedBridgeRoads, 1);
  assert.equal(result.diagnostics.omittedLayerRoads, 1);
  assert.ok(result.meshes.every(mesh => mesh.sourceIds.every(id => id === 'ground')));
});

test('invalid coordinates break a polyline rather than linking across missing geometry', () => {
  const broken = road('broken', [[-40, 0], [-20, 0], [0, 0], [20, 0], [40, 0]]);
  broken.coordinates[2] = [NaN, 55];
  const result = buildRoadSurfaces([broken], options);
  assert.equal(result.diagnostics.invalidSegments, 2);
  assert.equal(result.diagnostics.renderedSegments, 2);
  const surface = result.meshes.find(mesh => mesh.material === 'asphalt');
  assert.ok(positions(surface).every(([east]) => east <= -19.999 || east >= 19.999));
});

test('all surface and solid-curb geometry is clipped to the requested bounds', () => {
  const boundsMeters = [-10, -8, 10, 8];
  const result = buildRoadSurfaces([road('cross', [[-100, -10], [100, 10]], { widthM: 8 })], { origin, boundsMeters });
  assert.ok(result.meshes.length > 0);
  for (const mesh of result.meshes) {
    for (const [east, up, south] of positions(mesh)) {
      assert.ok(east >= -10 - 1e-8 && east <= 10 + 1e-8);
      assert.ok(-south >= -8 - 1e-8 && -south <= 8 + 1e-8);
      assert.ok(up >= 0.05 && up <= 0.23);
    }
    assert.equal(mesh.normals.length, mesh.positions.length);
    assert.equal(mesh.uvs.length, mesh.positions.length / 3 * 2);
    assert.ok(mesh.positions.every(Number.isFinite));
    assert.ok(mesh.normals.every(Number.isFinite));
    assert.ok(mesh.indices.every(index => Number.isInteger(index) && index >= 0 && index < mesh.positions.length / 3));
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = mesh.indices.slice(i, i + 3).map(index => mesh.positions.slice(index * 3, index * 3 + 3));
      const ab = b.map((x, k) => x - a[k]), ac = c.map((x, k) => x - a[k]);
      const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const n = mesh.normals.slice(mesh.indices[i] * 3, mesh.indices[i] * 3 + 3);
      assert.ok(cross.reduce((sum, x, k) => sum + x * n[k], 0) > 0);
    }
  }
});

test('input order and repeated source roads do not change the meshes or mutate source rows', () => {
  const roads = [road('b', [[-30, 10], [30, 10]]), road('a', [[-30, -10], [30, -10]])];
  const before = structuredClone(roads);
  assert.deepEqual(buildRoadSurfaces(roads, options).meshes,
    buildRoadSurfaces([roads[1], roads[0], roads[1]], options).meshes);
  assert.deepEqual(roads, before);
  assert.equal(buildRoadSurfaces([roads[0], roads[0]], options).diagnostics.duplicateRoadRows, 1);
});

test('rejects invalid scene frames and returns a valid empty result for no source roads', () => {
  assert.throws(() => buildRoadSurfaces([], { origin: [NaN, 55], boundsMeters: [-1, -1, 1, 1] }), /origin/i);
  assert.throws(() => buildRoadSurfaces([], { origin, boundsMeters: [1, 1, -1, -1] }), /bounds/i);
  assert.deepEqual(buildRoadSurfaces([], options).meshes, []);
});

test('entirely invalid polylines are diagnosed as invalid, not as outside the viewport', () => {
  const invalid = road('invalid', [[0, 0], [10, 0], [20, 0]]);
  invalid.coordinates[1] = [NaN, 55];
  const result = buildRoadSurfaces([invalid], options);
  assert.equal(result.diagnostics.invalidSegments, 2);
  assert.equal(result.diagnostics.outsideSegments, 0);
  assert.equal(result.diagnostics.partial, true);
});

test('the hard vertex budget drops decorative curbs before omitting retained road surfaces', () => {
  const roads = Array.from({ length: 240 }, (_, index) => road(`r-${String(index).padStart(3, '0')}`,
    [[-99, 0], [99, 0]], { widthM: 6 }));
  const result = buildRoadSurfaces(roads, options);
  assert.ok(result.diagnostics.vertexCount <= 400000);
  assert.ok(result.diagnostics.omittedPatchesByCap > 0);
  assert.equal(result.diagnostics.renderedSegments, 240);
  assert.equal(result.meshes.find(mesh => mesh.material === 'asphalt').sourceIds.length, 240);
});

test('coarse LOD generates road and junction surfaces without spending budget on hidden decoration', () => {
  const roads = Array.from({ length: 240 }, (_, index) => road(`r-${String(index).padStart(3, '0')}`,
    [[-99, 0], [99, 0]], { widthM: 6, lanes: 2 }));
  const result = buildRoadSurfaces(roads, { ...options, lod: 1 });
  assert.ok(result.meshes.every(mesh => mesh.material === 'asphalt' || mesh.material === 'paving'));
  assert.equal(result.diagnostics.renderedSegments, 240);
  assert.equal(result.diagnostics.omittedPatchesByCap, 0);
  assert.equal(result.diagnostics.lod, 1);
  assert.equal(result.diagnostics.maxSurfacePatchLengthMeters, 24);
  assert.ok(result.diagnostics.vertexCount < 20000);
});
