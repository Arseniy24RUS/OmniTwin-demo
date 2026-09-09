import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteCorridorBuilder } from './route-corridors.mjs';
import { dailyMovement } from './spatial.mjs';

const point = (x, y = 0) => [61 + x / 64_000, 55 + y / 111_195];
const road = (id, nodes, points, extra = {}) => ({ id, nodeIds: nodes, coordinates: points.map(([x, y]) => point(x, y)), className:'living_street',walkable: true, drivable: true, oneway: false, ...extra });
const policy = { targetMeters: 450, maxMeters: 600, maxSegments: 12, seed: 92 };

test('a straight short service dead end loses to a connected arterial continuation',()=>{
 const r=[road('start',['a','b'],[[0,0],[100,0]],{className:'primary'}),road('blind',['b','x'],[[100,0],[120,0]],{className:'service'}),road('main',['b','c'],[[100,0],[160,160]],{className:'primary'}),road('exit',['c','d'],[[160,160],[300,400]],{className:'primary'})];
 const route=createRouteCorridorBuilder(r,policy).build('start',{mode:'car'});
 assert.ok(route.sourceRoadIds.includes('main'));assert.ok(!route.sourceRoadIds.includes('blind'));
});
test('best legal orientation escapes a source driveway pointing into a dead end',()=>{
 const r=[road('drive',['a','b'],[[100,0],[120,0]],{className:'service'}),road('main',['a','c'],[[100,0],[100,400]],{className:'primary'})];
 const builder=createRouteCorridorBuilder(r,policy),route=builder.buildBest('drive',{mode:'car'});
 assert.equal(route.segments[0].direction,'reverse');assert.ok(route.sourceRoadIds.includes('main'));
});
test('mode-aware seeds prefer actual footways and connected arterial over nearest cul-de-sac',()=>{
 const r=[road('dead',['a','b'],[[0,0],[10,0]],{className:'service'}),road('main',['c','d'],[[-200,55],[200,55]],{className:'primary'}),road('in',['e','c'],[[-400,55],[-200,55]],{className:'primary'}),road('out',['d','f'],[[200,55],[400,55]],{className:'primary'}),road('foot',['w','x'],[[-100,12],[100,12]],{className:'footway',drivable:false})];
 const b=createRouteCorridorBuilder(r,policy);
 assert.equal(b.selectSeed(point(0,0),{mode:'walk'}).sourceRoadId,'foot');
 assert.equal(b.selectSeed(point(0,0),{mode:'car'}).sourceRoadId,'main');
 assert.deepEqual(b.selectSeed(point(0,0),{mode:'car'}),createRouteCorridorBuilder([...r].reverse(),policy).selectSeed(point(0,0),{mode:'car'}));
 assert.equal(b.selectSeed(point(5000,0),{mode:'car'}),null);
});

test('splits at shared internal nodes and follows only real connected geometry', () => {
  const roads = [road('main', ['a', 'b', 'c'], [[0, 0], [100, 0], [200, 0]]), road('branch', ['b', 'd', 'e'], [[100, 0], [100, 200], [100, 400]], { oneway: true }), road('exit', ['c', 'f'], [[200, 0], [400, 0]])];
  const builder = createRouteCorridorBuilder(roads, policy);
  const result = builder.build('main', { mode: 'car' });
  assert.ok(result.sourceRoadIds.length > 1);
  assert.equal(result.segments[0].fromNodeId, 'a');
  assert.equal(result.segments[0].toNodeId, 'b');
  for (let i = 1; i < result.segments.length; i++) assert.equal(result.segments[i - 1].toNodeId, result.segments[i].fromNodeId);
  assert.equal(result.connectivity, 'source_node_ids');
  assert.ok(result.lengthMeters <= 600.001);
  assert.equal(builder.build('main', { mode: 'car' }), result, 'retained cache identity');
});

test('coordinate crossings without shared node IDs never create a junction', () => {
  const roads = [road('bridge', ['a', 'b'], [[0, 0], [100, 0]], { bridge: true }), road('under', ['c', 'd'], [[100, 0], [200, 0]])];
  const result = createRouteCorridorBuilder(roads, policy).build('bridge');
  assert.deepEqual(result.sourceRoadIds, ['bridge']);
  assert.equal(result.termination, 'dead_end');
});

test('oneway and mode eligibility are respected without fabricated return edges', () => {
  const roads = [road('start', ['a', 'b'], [[0, 0], [100, 0]], { oneway: true,walkDirection:'forward' }), road('wrong-way', ['c', 'b'], [[200, 0], [100, 0]], { oneway: true,walkDirection:'forward' }), road('foot', ['b', 'd'], [[100, 0], [100, 300]], { className:'footway',drivable: false })];
  const builder = createRouteCorridorBuilder(roads, policy);
  assert.equal(builder.build('start', { direction: 'reverse' }), null);
  assert.equal(builder.build('foot', { mode: 'car' }), null);
  assert.deepEqual(builder.build('start', { mode: 'car' }).sourceRoadIds, ['start']);
  assert.deepEqual(builder.build('start', { mode: 'walk' }).sourceRoadIds, ['start', 'foot']);
  assert.equal(builder.build('start', { mode: 'walk' }).oneway, true);
});

test('bounded distance clips on the source line, segment budget terminates honestly', () => {
  const builder = createRouteCorridorBuilder([road('long', ['a', 'b'], [[0, 0], [4000, 0]])], policy);
  const route = builder.build('long');
  assert.ok(Math.abs(route.lengthMeters - 600) < 0.01);
  assert.equal(route.termination, 'distance_budget');
  assert.equal(route.segments[0].clipped, true);
  assert.equal(route.segments[0].toNodeId, null, 'derived clipped endpoint is not a source junction');
  const chain = Array.from({ length: 20 }, (_, i) => road(`r${i}`, [`n${i}`, `n${i + 1}`], [[i * 10, 0], [(i + 1) * 10, 0]]));
  const short = createRouteCorridorBuilder(chain, { ...policy, maxSegments: 3 }).build('r0');
  assert.equal(short.segments.length, 3);
  assert.equal(short.termination, 'segment_budget');
});

test('road input order and bounded cache eviction cannot change the route', () => {
  const roads = [road('start', ['a', 'b'], [[0, 0], [100, 0]]), road('north', ['b', 'c'], [[100, 0], [100, 300]]), road('east', ['b', 'd'], [[100, 0], [400, 0]])];
  const first = createRouteCorridorBuilder(roads, { ...policy, maxCachedRoutes: 1 });
  const result = first.build('start'); first.build('east');
  assert.deepEqual(first.build('start'), result);
  assert.deepEqual(createRouteCorridorBuilder([...roads].reverse(), policy).build('start'), result);
  assert.equal(first.stats().cachedRoutes, 1);
});

test('physical movement retains corridor identity and absolute-time phase at walking speed', () => {
  const corridor = createRouteCorridorBuilder([road('main', ['a', 'b'], [[0, 0], [400, 0]])], policy).build('main');
  const presence = { active: true, role: 'travel', age: 17, direction: 'outbound', progress: 0.25 };
  const first = dailyMovement({ personIndex: 7 }, presence, { walkRoad: corridor }, 600);
  const opposite = dailyMovement({ personIndex: 7 }, presence, { walkRoad: corridor }, 600 + corridor.lengthMeters / 1.2 / 60);
  // One physical traversal is half of the two-way triangle-wave cycle. Changing
  // the building schedule's progress/direction must not re-anchor the street.
  assert.deepEqual(dailyMovement({ personIndex: 7 }, { ...presence, progress: 0.9, direction: 'return' }, { walkRoad: corridor }, 600), first);
  const [forward, back] = first.direction === 'forward' ? [first, opposite] : [opposite, first];
  for (const movement of [forward, back]) {
    assert.equal(movement.routeId, corridor.id);
    assert.equal(movement.routeMode, 'ping_pong');
    assert.equal(movement.speedMps, 1.2);
    assert.ok([movement.longitude, movement.latitude, movement.progress].every(Number.isFinite));
    assert.ok(movement.progress >= 0 && movement.progress <= 1);
  }
  assert.equal(forward.direction, 'forward'); assert.equal(back.direction, 'reverse');
  assert.equal(forward.heading, 90); assert.equal(back.heading, 270);
  assert.ok(Math.abs(forward.progress + back.progress - 1) < 1e-9);
});

test('repeated edges do not produce ping-pong, while real loops remain connected', () => {
  const loop = road('loop', ['a', 'b', 'c', 'a'], [[0, 0], [100, 0], [100, 100], [0, 0]], { oneway: true });
  const result = createRouteCorridorBuilder([loop], policy).build('loop');
  assert.equal(result.segments.length, 1);
  assert.equal(result.termination, 'dead_end');
  assert.equal(new Set(result.segments.map((segment) => `${segment.roadId}:${segment.startVertex}:${segment.endVertex}`)).size, result.segments.length);
});

test('conflicting source IDs and malformed or unbounded inputs fail closed', () => {
  assert.throws(() => createRouteCorridorBuilder([road('a', ['x', 'y'], [[0, 0], [100, 0]]), road('b', ['y', 'z'], [[105, 0], [200, 0]])]), /coordinate/);
  assert.throws(() => createRouteCorridorBuilder([{ ...road('a', ['x', 'y'], [[0, 0], [100, 0]]), nodeIds: ['x'] }]), /node/);
  assert.throws(() => createRouteCorridorBuilder([], { maxSegments: 13 }), /policy/);
  assert.throws(() => createRouteCorridorBuilder([], { maxMeters: 1501 }), /policy/);
});
