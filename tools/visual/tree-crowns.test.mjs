import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTreeMeshes } from './tree-crowns.mjs';

const placement = { id: 'green-tree:wood:123:grid:5:9', sourceIds: ['source-wood:123'],
  point: [45, -23], radiusMeters: 2.7, heightMeters: 7.5, provenance: 'visual_synthesis' };

test('rounded three-lobe opaque crown fits exact source placement radius and height; all LODs stay under 200 triangles', () => {
  for (const lod of [0, 1]) for (const heightMeters of [5, 7, 9]) {
    const source = { ...placement, heightMeters }, before = JSON.stringify(source);
    const meshes = buildTreeMeshes(source, { lod });
    assert.deepEqual(meshes.map(m => m.material), ['trunk', 'leaves']);
    assert.ok(meshes.reduce((n, m) => n + m.indices.length / 3, 0) <= 200);
    const leaves = meshes[1]; assert.equal(leaves.crownLobes.length, 3); assert.equal(leaves.opaque, true);
    assert.equal(leaves.crownLobes.reduce((n, lobe) => n + lobe.triangleCount, 0), leaves.indices.length / 3);
    let highest = -Infinity;
    for (const m of meshes) for (let i = 0; i < m.positions.length; i += 3) {
      assert.ok(Math.hypot(m.positions[i] - source.point[0], m.positions[i + 2] + source.point[1]) <= source.radiusMeters + 1e-7);
      assert.ok(m.positions[i + 1] >= .025 - 1e-7 && m.positions[i + 1] <= .025 + heightMeters + 1e-7);
      highest = Math.max(highest, m.positions[i + 1]);
    }
    assert.ok(Math.abs(highest - (.025 + heightMeters)) < 1e-7);
    assert.equal(JSON.stringify(source), before);
  }
});

test('each ellipsoidal lobe has genuinely outward triangle winding and matching normals', () => {
  const leaves = buildTreeMeshes(placement)[1];
  for (const lobe of leaves.crownLobes) for (let face = lobe.triangleStart; face < lobe.triangleStart + lobe.triangleCount; face++) {
    const ids = leaves.indices.slice(face * 3, face * 3 + 3);
    const [a, b, c] = ids.map(index => leaves.positions.slice(index * 3, index * 3 + 3));
    const u = b.map((x, i) => x - a[i]), v = c.map((x, i) => x - a[i]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const radial = a.map((x, i) => (x + b[i] + c[i]) / 3 - lobe.center[i]);
    assert.ok(cross.reduce((dot, x, i) => dot + x * radial[i], 0) > 0, 'each crown face points away from its own lobe center');
    const normal = leaves.normals.slice(ids[0] * 3, ids[0] * 3 + 3);
    assert.ok(normal.reduce((dot, x, i) => dot + x * cross[i] / Math.hypot(...cross), 0) > .999999);
  }
});

test('mesh ownership is deterministic and source coordinates are distinguished from synthetic crown shape', () => {
  const input = { ...placement, provenance: 'source_geometry' };
  const result = buildTreeMeshes(input, { baseHeight: .1 });
  assert.deepEqual(result, buildTreeMeshes(input, { baseHeight: .1 }));
  for (const mesh of result) {
    assert.equal(mesh.ownerId, input.id); assert.equal(mesh.treeId, input.id);
    assert.deepEqual(mesh.sourceIds, input.sourceIds); assert.equal(mesh.canonicalId, undefined);
    assert.equal(mesh.provenance, 'visual_synthesis'); assert.equal(mesh.placementProvenance, 'source_geometry');
    assert.ok(mesh.positions.every(Number.isFinite)); assert.equal(mesh.positions.length, mesh.normals.length);
    assert.equal(mesh.uvs.length * 3, mesh.positions.length * 2); assert.equal(mesh.colors.length, mesh.positions.length);
  }
  assert.notDeepEqual(buildTreeMeshes({ ...input, id: 'different-source-id' })[1].positions, buildTreeMeshes(input)[1].positions);
});

test('LOD reduces faces without changing the declared canopy envelope and invalid dimensions fail closed', () => {
  const near = buildTreeMeshes(placement), far = buildTreeMeshes(placement, { lod: 1 });
  assert.ok(far[1].indices.length < near[1].indices.length);
  assert.deepEqual(far[1].crownLobes.map(l => [l.center, l.radii]), near[1].crownLobes.map(l => [l.center, l.radii]));
  for (const invalid of [{ ...placement, radiusMeters: NaN }, { ...placement, heightMeters: -1 }, { ...placement, point: [Infinity, 0] }]) {
    assert.throws(() => buildTreeMeshes(invalid), /placement/i);
  }
});
