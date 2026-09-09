/** Opaque illustrative broadleaf trees; source-backed placement never becomes an observed species claim. */
import { IcosahedronGeometry } from 'three';
import { stableHash, triangle } from './geometry.mjs';

const templates = new Map();
function crownTemplate(detail) {
  if (templates.has(detail)) return templates.get(detail);
  const geometry = new IcosahedronGeometry(1, detail), positions = geometry.getAttribute('position');
  const vertices = [], indices = geometry.index;
  let maxY = 0;
  for (let i = 0; i < positions.count; i++) maxY = Math.max(maxY, Math.abs(positions.getY(i)));
  for (let i = 0; i < (indices?.count ?? positions.count); i++) {
    const index = indices ? indices.getX(i) : i;
    // Normalize the template's vertical extent so the requested tree height is attained exactly.
    vertices.push([positions.getX(index), positions.getY(index) / maxY, positions.getZ(index)]);
  }
  geometry.dispose(); templates.set(detail, vertices); return vertices;
}
function makeMesh(placement, material) {
  return { name: `${placement.id}:${material}`, material, positions: [], normals: [], uvs: [], colors: [], indices: [],
    sourceIds: [...placement.sourceIds], treeId: placement.id, ownerId: placement.id, opaque: true,
    provenance: 'visual_synthesis', placementProvenance: placement.provenance,
    geometryRepresentation: 'illustrative_opaque_three_lobe_broadleaf_not_observed_species_or_dimensions' };
}

/**
 * glTF local coordinates: X=east, Y=up, Z=-north. Returns [trunk, leaves].
 * Crown radius is a strict horizontal envelope around the unchanged placement point;
 * height includes the whole tree above baseHeight. LOD0 uses 148 triangles, LOD1 80.
 * leaves.crownLobes describes each CLOSED ellipsoid's center/radii and triangle interval.
 * Outward winding must be tested against the respective lobe center, not the whole-tree axis.
 * Shape offsets/rotations are deterministic visual synthesis from placement.id.
 */
export function buildTreeMeshes(placement, { lod = 0, baseHeight = .025 } = {}) {
  if (!placement || typeof placement.id !== 'string' || !placement.id || !Array.isArray(placement.sourceIds)
    || !placement.sourceIds.every(id => typeof id === 'string') || !Array.isArray(placement.point)
    || placement.point.length < 2 || !placement.point.slice(0, 2).every(Number.isFinite)
    || !Number.isFinite(placement.radiusMeters) || placement.radiusMeters <= 0 || placement.radiusMeters > 20
    || !Number.isFinite(placement.heightMeters) || placement.heightMeters <= 0 || placement.heightMeters > 50) {
    throw new Error('Tree placement must have a source owner, finite point, and bounded positive dimensions');
  }
  if (lod !== 0 && lod !== 1 || !Number.isFinite(baseHeight)) throw new Error('Tree lod must be 0 or 1 and baseHeight must be finite');
  const { point: [east, north], radiusMeters: radius, heightMeters: height } = placement;
  const trunk = makeMesh(placement, 'trunk'), leaves = makeMesh(placement, 'leaves');
  const angle = stableHash(`${placement.id}:crown-axis`) / 4294967296 * Math.PI * 2;
  const asymmetry = stableHash(`${placement.id}:crown-asymmetry`) / 4294967296;
  const lobeSpecs = [
    { offset: [0, 0], centerHeight: .65, verticalRadius: .35, horizontalRadius: .76, rotation: angle, detail: lod === 0 ? 1 : 0 },
    { offset: [Math.cos(angle) * .36, Math.sin(angle) * .36], centerHeight: .53 + .025 * asymmetry,
      verticalRadius: .25, horizontalRadius: .60, rotation: angle + .43, detail: 0 },
    { offset: [Math.cos(angle + Math.PI + .22) * .34, Math.sin(angle + Math.PI + .22) * .34], centerHeight: .56 - .025 * asymmetry,
      verticalRadius: .25, horizontalRadius: .58, rotation: angle - .37, detail: 0 },
  ];
  leaves.crownLobes = [];
  for (const [lobeIndex, spec] of lobeSpecs.entries()) {
    const center = [east + spec.offset[0] * radius, baseHeight + spec.centerHeight * height, -north - spec.offset[1] * radius];
    const radii = [spec.horizontalRadius * radius, spec.verticalRadius * height, spec.horizontalRadius * radius];
    const cos = Math.cos(spec.rotation), sin = Math.sin(spec.rotation), points = crownTemplate(spec.detail);
    const triangleStart = leaves.indices.length / 3;
    const transform = p => [center[0] + (p[0] * cos - p[2] * sin) * radii[0], center[1] + p[1] * radii[1],
      center[2] + (p[0] * sin + p[2] * cos) * radii[2]];
    for (let i = 0; i < points.length; i += 3) {
      const local = points.slice(i, i + 3), transformed = local.map(transform);
      const meanY = local.reduce((sum, p) => sum + p[1], 0) / 3;
      triangle(leaves, transformed, [[0, 0], [1, 0], [.5, 1]], .94 + .045 * meanY - lobeIndex * .015);
    }
    leaves.crownLobes.push({ center, radii, triangleStart, triangleCount: leaves.indices.length / 3 - triangleStart });
  }
  const sides = lod === 0 ? 7 : 5, trunkRadius = Math.min(.17, radius * .075), top = baseHeight + height * .59;
  for (let side = 0; side < sides; side++) {
    const a = angle + side * 2 * Math.PI / sides, b = angle + (side + 1) * 2 * Math.PI / sides;
    const pa = [east + Math.cos(a) * trunkRadius, baseHeight, -north - Math.sin(a) * trunkRadius];
    const pb = [east + Math.cos(b) * trunkRadius, baseHeight, -north - Math.sin(b) * trunkRadius];
    const at = [pa[0], top, pa[2]], bt = [pb[0], top, pb[2]];
    triangle(trunk, [pa, pb, bt]); triangle(trunk, [pa, bt, at], [[0, 0], [1, 1], [0, 1]]);
    triangle(trunk, [[east, top, -north], at, bt]); triangle(trunk, [[east, baseHeight, -north], pb, pa]);
  }
  return [trunk, leaves];
}
