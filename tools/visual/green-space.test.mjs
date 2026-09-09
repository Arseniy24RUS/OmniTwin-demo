import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGreenSpace } from './green-space.mjs';
import { localBoundsToGeographic } from './geometry.mjs';

const origin = [61.405, 55.16];
const options = { origin, boundsMeters: [-100, -100, 100, 100], maxTrees: 1000, lod: 0 };
const geo = ([e, n]) => { const b = localBoundsToGeographic([e, n, e, n], origin); return b.slice(0, 2); };
const ring = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]].map(geo);
const feature = (id, properties, rings = [ring(-90, -90, 90, 90)]) => ({ id, sourceLayer: 'landcover', properties, geometry: { type: 'Polygon', coordinates: rings } });
const point = (id, e, n) => ({ id, sourceLayer: 'poi', properties: { natural: 'tree' }, geometry: { type: 'Point', coordinates: geo([e, n]) } });
const area = meshes => meshes.filter(m => m.material === 'grass').reduce((sum, m) => {
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = m.indices.slice(i, i + 3).map(j => [m.positions[j * 3], -m.positions[j * 3 + 2]]);
    sum += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  } return sum;
}, 0);

test('only explicitly eligible source classes produce ground; grass alone never synthesizes trees', () => {
  for (const properties of [{}, { name: 'Green place' }, { leisure: 'pitch' }, { leisure: 'playground' }, { natural: 'water' }, { landuse: 'railway' }]) {
    const result = buildGreenSpace([feature('reject', properties)], [], [], options);
    assert.equal(result.meshes.length, 0); assert.equal(result.treePlacements.length, 0);
  }
  const result = buildGreenSpace([feature('grass', { class: 'grass' })], [], [], options);
  assert.ok(area(result.meshes) > 32000); assert.equal(result.treePlacements.length, 0);
  assert.ok(result.meshes.every(m => m.provenance === 'source_geometry'));
});

test('grass ground has subtle deterministic vertex tint without modifying source geometry',()=>{
 const source=feature('grass',{class:'grass'}),before=JSON.stringify(source);
 const a=buildGreenSpace([source],[],[],options),b=buildGreenSpace([source],[],[],options);
 const colors=a.meshes.flatMap(m=>m.colors);
 assert.ok(new Set(colors).size>1);assert.ok(colors.every(v=>v>=.93&&v<=1));
 assert.deepEqual(a,b);assert.equal(JSON.stringify(source),before);
});

test('source polygon holes survive triangulation before clipping; no duplicate overlap at the same elevation', () => {
  const source = feature('a', { class: 'grass' }, [ring(-90, -90, 90, 90), ring(-30, -30, 30, 30).reverse()]);
  const input = JSON.stringify(source);
  const result = buildGreenSpace([source, { ...source, id: 'duplicate' }], [], [], { ...options, boundsMeters: [-60, -60, 60, 60] });
  assert.ok(Math.abs(area(result.meshes) - (120 * 120 - 60 * 60)) < 1e-5);
  assert.equal(JSON.stringify(source), input);
  for (const m of result.meshes) for (let i = 0; i < m.positions.length; i += 3) {
    assert.equal(m.positions[i + 1], .025); assert.ok(m.normals[i + 1] > .999);
    assert.ok(Math.abs(m.positions[i]) <= 60 + 1e-7 && Math.abs(m.positions[i + 2]) <= 60 + 1e-7);
  }
});

test('partially overlapping green source polygons have exact union area and deterministic priority', () => {
  const a = feature('park', { leisure: 'park' }, [ring(-70, -40, 20, 40)]);
  const b = feature('grass', { landuse: 'grass' }, [ring(-20, -40, 70, 40)]);
  const one = buildGreenSpace([a, b], [], [], { ...options, maxTrees: 0 });
  assert.ok(Math.abs(area(one.meshes) - 140 * 80) < 1e-5);
  assert.deepEqual(one, buildGreenSpace([b, a], [], [], { ...options, maxTrees: 0 }));
});

test('12 metre grid is deterministic, bounded, and independent of feature order; exact trees take cap priority', () => {
  const forest = feature('forest', { natural: 'wood' });
  const exact = point('observed-tree', 3, 5);
  const a = buildGreenSpace([forest, exact], [], [], { ...options, maxTrees: 7 });
  assert.equal(a.treePlacements.length, 7);
  assert.equal(a.treePlacements[0].provenance, 'source_geometry');
  assert.ok(Math.abs(a.treePlacements[0].point[0] - 3) < 1e-7);
  assert.deepEqual(a, buildGreenSpace([exact, forest], [], [], { ...options, maxTrees: 7 }));
  const grid = a.treePlacements.filter(p => p.provenance === 'visual_synthesis');
  for (const p of grid) assert.deepEqual(p.gridSpacingMeters, 12);
  for (let i = 0; i < grid.length; i++) for (let j = i + 1; j < grid.length; j++) assert.ok(Math.hypot(grid[i].point[0] - grid[j].point[0], grid[i].point[1] - grid[j].point[1]) >= 12 - 1e-7);
});

test('trees avoid building solids and walls; actual courtyard holes remain eligible with clearance', () => {
  const building = { id: 'building', footprint: { type: 'Polygon', coordinates: [ring(-45, -45, 45, 45), ring(-15, -15, 15, 15).reverse()] } };
  const source = [point('inside-solid', 35, 0), point('too-close-wall', 47, 0), point('courtyard', 0, 0), point('clear', 55, 0)];
  const result = buildGreenSpace(source, [building], [], options);
  assert.deepEqual(result.treePlacements.map(p => p.sourceIds[0]).sort(), ['clear', 'courtyard']);
  assert.equal(result.diagnostics.excludedByBuildings, 2);
});

test('source-width, lane-derived, and class-derived road strips include 2 metre canopy clearance', () => {
  for (const [fields, half] of [[{ widthM: 20 }, 10], [{ lanes: 4 }, 6.3], [{ className: 'residential' }, 3]]) {
    const road = { id: 'road', drivable: true, coordinates: [geo([-90, 0]), geo([90, 0])], ...fields };
    const result = buildGreenSpace([point('blocked', 0, half + 1.9), point('clear', 0, half + 3)], [], [road], options);
    assert.deepEqual(result.treePlacements.map(p => p.sourceIds[0]), ['clear']);
  }
});

test('forbidden polygons override a broad park tree policy, including exact points', () => {
  const park = feature('park', { leisure: 'park' });
  const pitch = feature('pitch', { leisure: 'pitch' }, [ring(-30, -30, 30, 30)]);
  const result = buildGreenSpace([park, pitch, point('pitch-tree', 0, 0)], [], [], options);
  assert.ok(result.treePlacements.length > 0);
  assert.ok(result.treePlacements.every(p => Math.abs(p.point[0]) >= 30 || Math.abs(p.point[1]) >= 30));
});

test('opaque 3D foliage has outward crown winding, physical dimensions, and source owners without building IDs', () => {
  const result = buildGreenSpace([point('tree', 0, 0)], [], [], options);
  const p = result.treePlacements[0];
  assert.ok(p.radiusMeters >= 2 && p.radiusMeters <= 3 && p.heightMeters >= 5 && p.heightMeters <= 9);
  for (const m of result.meshes) {
    assert.equal(m.canonicalId, undefined); assert.deepEqual(m.sourceIds, ['tree']); assert.equal(m.treeId, p.id);
    assert.ok(m.positions.every(Number.isFinite)); assert.equal(m.positions.length, m.normals.length);
    if (m.material !== 'leaves') continue;
    assert.equal(m.crownLobes.length,3);
    for (let i = 0; i < m.positions.length; i += 9) {
      const center = [0, 0, 0]; for (let j = 0; j < 3; j++) for (let axis = 0; axis < 3; axis++) center[axis] += m.positions[i + j * 3 + axis] / 3;
      const lobe=m.crownLobes.find(l=>i/9>=l.triangleStart&&i/9<l.triangleStart+l.triangleCount);
      assert.ok(lobe);assert.ok(center.reduce((sum,v,axis)=>sum+(v-lobe.center[axis])*m.normals[i+axis],0)>0,'outward lobe normals');
    }
  }
});

test('invalid geometry fails closed and pathological bounds are rejected without loops', () => {
  assert.throws(() => buildGreenSpace([], [], [], { ...options, boundsMeters: [-1e9, -1e9, 1e9, 1e9] }), /bounds/i);
  const invalid = feature('bad', { natural: 'wood' }, [[[NaN, 55], [61, 55], [62, 55], [NaN, 55]]]);
  const result = buildGreenSpace([invalid], [], [], options);
  assert.equal(result.meshes.length, 0); assert.equal(result.treePlacements.length, 0); assert.equal(result.diagnostics.invalidFeatures, 1);
});

test('actual MVT grass subclasses permit park/garden trees, while MultiPolygon holes and disjoint parts stay exact', () => {
  for (const subclass of ['wood', 'park', 'garden']) {
    const result = buildGreenSpace([feature(subclass, { class: 'grass', subclass })], [], [], { ...options, maxTrees: 3 });
    assert.equal(result.treePlacements.length, 3);
  }
  const source = feature('multi', { class: 'grass' });
  source.geometry = { type: 'MultiPolygon', coordinates: [[ring(-80, -80, -20, -20), ring(-60, -60, -40, -40).reverse()], [ring(20, 20, 80, 80)]] };
  const result = buildGreenSpace([source], [], [], options);
  assert.ok(Math.abs(area(result.meshes) - (3600 - 400 + 3600)) < 1e-5);
});

test('one global call enforces hard 1000-tree cap and LOD keeps the exact placement set', () => {
  const forest = feature('forest', { class: 'wood' }, [ring(-310, -310, 310, 310)]);
  const opts = { ...options, boundsMeters: [-310, -310, 310, 310], maxTrees: 1200 };
  const result = buildGreenSpace([forest], [], [], opts);
  assert.equal(result.treePlacements.length, 1000); assert.equal(result.diagnostics.maxTrees, 1000);
  assert.ok(result.diagnostics.omittedTreesByCap > 0);
  const coarse = buildGreenSpace([forest], [], [], { ...opts, lod: 1 });
  assert.deepEqual(coarse.treePlacements, result.treePlacements);
  assert.ok(coarse.diagnostics.vertexCount < result.diagnostics.vertexCount);
  const ids = new Set(result.treePlacements.map(p => p.id));
  assert.equal(ids.size, 1000); assert.ok(result.meshes.filter(m => m.treeId).every(m => ids.has(m.treeId)));
});

test('malformed building and road exclusion geometry suppresses trees instead of silently treating it as empty', () => {
  for (const [buildings, roads] of [[[{}], []], [[], [{ id: 'bad-road', coordinates: [geo([0, 0]), [NaN, 55]] }]]]) {
    const result = buildGreenSpace([point('tree', 0, 0)], buildings, roads, options);
    assert.equal(result.treePlacements.length, 0); assert.equal(result.diagnostics.treesSuppressedByInvalidExclusions, true);
  }
});

test('explicit tunnels do not displace ground trees; bridge corridors conservatively do', () => {
  const road = { id: 'road', className: 'primary', coordinates: [geo([-90, 0]), geo([90, 0])] };
  assert.equal(buildGreenSpace([point('tree', 0, 0)], [], [{ ...road, tunnel: true }], options).treePlacements.length, 1);
  assert.equal(buildGreenSpace([point('tree', 0, 0)], [], [{ ...road, bridge: true }], options).treePlacements.length, 0);
});
test('furniture is source-contained and avoids entire building and road footprints',()=>{
  const courtyard={id:'openmaptiles_buildings:1',footprint:{type:'Polygon',coordinates:[ring(-80,-80,80,80),ring(-65,-65,65,65).reverse()]}};
  const annex={id:'openmaptiles_buildings:2',footprint:{type:'Polygon',coordinates:[ring(-20,-55,20,55)]}};
  const road={id:'courtyard-access',widthM:6,coordinates:[geo([-70,0]),geo([70,0])]};
  const before=JSON.stringify([courtyard,annex,road]);
  const result=buildGreenSpace([], [courtyard,annex], [road], {...options,maxDecorations:12});
  assert.ok(result.decorationPlacements.length>0);
  for(const p of result.decorationPlacements){assert.equal(p.areaKind,'courtyard_hole');assert.ok(Math.abs(p.point[1])>=5+p.radiusMeters-1e-6);assert.ok(Math.abs(p.point[0])>=20+p.radiusMeters+.35-1e-6||Math.abs(p.point[1])>=55+p.radiusMeters+.35-1e-6);for(const [x,y] of p.corners)assert.ok(Math.abs(x)<65&&Math.abs(y)<65);}
  assert.equal(JSON.stringify([courtyard,annex,road]),before);
  const groundOnly=buildGreenSpace([], [courtyard,annex], [road], {...options,maxTrees:0,maxDecorations:0});
  assert.equal(groundOnly.decorationPlacements.length,0);
});
