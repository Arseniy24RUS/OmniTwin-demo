import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, PerspectiveCamera, Raycaster, Vector2, Vector3, Vector4 } from 'three';
import { applyMapLibreCamera, ecefToLocalMatrix, localToMercatorMatrix } from '../renderer/game/cameraAdapter';
import publicCityCameraMatrices from './fixtures/publicCityCameraMatrices.json';

const origin = { longitude: 61.39466, latitude: 55.1654, altitude: 0 };

// Public MapLibre 6.4 input: its perspective is in world pixels; mainMatrix is
// normalized-Mercator -> clip. This fixture deliberately varies world scale.
function inputFor(position: Vector3, scale: number, aspect = 16 / 9) {
  const reference = new PerspectiveCamera(42, aspect, 0.7, 9000);
  reference.position.copy(position);
  reference.lookAt(0, 0, 0);
  reference.updateMatrixWorld(true);
  reference.projectionMatrix.elements[8] = 0.13; // MapLibre padding / off-centre view.
  const pixelProjection = reference.projectionMatrix.clone();
  pixelProjection.elements[14] *= scale;
  const mainMatrix = pixelProjection.clone()
    .multiply(new Matrix4().makeScale(scale, scale, scale))
    .multiply(reference.matrixWorldInverse)
    .multiply(localToMercatorMatrix(origin).invert());
  return { reference, input: {
    projectionMatrix: pixelProjection.elements,
    nearZ: reference.near * scale, farZ: reference.far * scale,
    fov: reference.fov * Math.PI / 180,
    defaultProjectionData: { mainMatrix: mainMatrix.elements, projectionTransition: 0 },
  } };
}

describe('MapLibre 6.4 public local-metre camera adapter', () => {
  it.each([0.05, 1, 42])('preserves clip position and depth while removing pixel scale %s', (scale) => {
    const { input, reference } = inputFor(new Vector3(210, 780, 540), scale);
    const camera = new PerspectiveCamera();
    applyMapLibreCamera(camera, input, origin);
    for (const point of [new Vector3(), new Vector3(25, 17, -83), new Vector3(-200, 2, 310)]) {
      const expected = point.clone().project(reference);
      const actual = point.clone().project(camera);
      expect(actual.distanceTo(expected)).toBeLessThan(1e-7);
    }
    expect(camera.position.distanceTo(reference.position)).toBeLessThan(1e-6);
    expect(camera.matrixWorld.determinant()).toBeCloseTo(1, 8);
    expect(camera.near).toBeCloseTo(0.7, 9);
    expect(camera.far).toBeCloseTo(9000, 5);
    expect(new Vector3(1, 0, 0).transformDirection(camera.matrixWorld).length()).toBeCloseTo(1);
  });

  it('keeps a one-metre E/U/S basis, reverses north only, and preserves altitude', () => {
    const matrix = localToMercatorMatrix(origin);
    const zero = new Vector3().applyMatrix4(matrix);
    const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)]
      .map((point) => point.applyMatrix4(matrix).sub(zero));
    expect(axes[0].x).toBeGreaterThan(0);
    expect(axes[1].z).toBeGreaterThan(0);
    expect(axes[2].y).toBeGreaterThan(0);
    expect(axes[0].length()).toBeCloseTo(axes[1].length(), 14);
    expect(axes[1].length()).toBeCloseTo(axes[2].length(), 14);
    const high = new Vector3().applyMatrix4(localToMercatorMatrix({ ...origin, altitude: 15 }));
    expect(high.z - zero.z).toBeCloseTo(15 * axes[1].length(), 12);
  });

  it('preserves culling and forward direction for overhead and rotated courtyard cameras', () => {
    for (const position of [new Vector3(0.1, 1000, 0.1), new Vector3(-200, 140, -120)]) {
      const { input, reference } = inputFor(position, 12, 390 / 844);
      const camera = new PerspectiveCamera();
      applyMapLibreCamera(camera, input, origin);
      const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      expect(frustum.containsPoint(new Vector3())).toBe(true);
      expect(frustum.containsPoint(position.clone().multiplyScalar(2))).toBe(false);
      expect(camera.getWorldDirection(new Vector3()).distanceTo(reference.getWorldDirection(new Vector3()))).toBeLessThan(1e-7);
      const projected = new Vector4(0, 0, 0, 1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
      expect(projected.w).toBeGreaterThan(0);
    }
  });

  it('accepts the Float32 public perspective alongside a Float64 Mercator matrix', () => {
    const { input, reference } = inputFor(new Vector3(250, 680, -180), 3.4);
    const camera = new PerspectiveCamera();
    applyMapLibreCamera(camera, { ...input, projectionMatrix: new Float32Array(input.projectionMatrix) }, origin);
    expect(new Vector3(40, 15, 80).project(camera).distanceTo(new Vector3(40, 15, 80).project(reference))).toBeLessThan(1e-5);
    expect(camera.position.distanceTo(reference.position)).toBeLessThan(0.05);
  });

  it.each(publicCityCameraMatrices.fixtures)('preserves real $name district clip/depth and metric picking rays', fixture => {
    const camera = new PerspectiveCamera(), input = fixture.input;
    applyMapLibreCamera(camera, input, fixture.origin);
    const local = localToMercatorMatrix(fixture.origin);
    const target = new Vector3().applyMatrix4(localToMercatorMatrix(fixture.requestedCamera)).applyMatrix4(local.clone().invert());
    const publicClip = new Matrix4().fromArray(input.defaultProjectionData.mainMatrix).multiply(local);
    for (const offset of [new Vector3(), new Vector3(50, 12, -80), new Vector3(-250, 0, 200)]) {
      const point = target.clone().add(offset), clip = new Vector4(...point.toArray(), 1).applyMatrix4(publicClip);
      const expected = new Vector3(clip.x, clip.y, clip.z).divideScalar(clip.w), actual = point.clone().project(camera);
      expect(actual.distanceTo(expected)).toBeLessThan(1e-7);
      const ray = new Raycaster(); ray.setFromCamera(new Vector2(expected.x, expected.y), camera);
      expect(ray.ray.distanceToPoint(point)).toBeLessThan(0.001);
    }
    const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)]
      .map(axis => axis.applyMatrix4(camera.matrixWorld).sub(camera.position));
    for (const axis of axes) expect(Math.abs(axis.length() - 1)).toBeLessThan(1e-6);
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) expect(Math.abs(axes[a].dot(axes[b]))).toBeLessThan(1e-6);
    expect(Math.abs(camera.matrixWorld.determinant() - 1)).toBeLessThan(1e-6);
  });

  it('rejects contradictory public perspective metadata and true equal-length shear', () => {
    const { input } = inputFor(new Vector3(0, 100, 100), 1);
    expect(() => applyMapLibreCamera(new PerspectiveCamera(), { ...input, nearZ: input.nearZ * 2 }, origin)).toThrow(/perspective|projection/i);
    const skew = new Matrix4().set(1, 0.1, 0, 0, 0, Math.sqrt(0.99), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    const local = localToMercatorMatrix(origin);
    const skewedMain = new Matrix4().fromArray(input.defaultProjectionData.mainMatrix).multiply(local).multiply(skew).multiply(local.clone().invert());
    expect(() => applyMapLibreCamera(new PerspectiveCamera(), { ...input, defaultProjectionData: { ...input.defaultProjectionData, mainMatrix: skewedMain.elements } }, origin)).toThrow(/non-rigid/i);
  });

  it('rejects globe, singular matrices and non-finite origins without silently misplacing tiles', () => {
    const { input } = inputFor(new Vector3(0, 100, 100), 1);
    expect(() => applyMapLibreCamera(new PerspectiveCamera(), { ...input, defaultProjectionData: { ...input.defaultProjectionData, projectionTransition: 1 } }, origin)).toThrow(/mercator/i);
    expect(() => applyMapLibreCamera(new PerspectiveCamera(), { ...input, projectionMatrix: new Array(16).fill(0) }, origin)).toThrow(/matrix/i);
    expect(() => localToMercatorMatrix({ ...origin, latitude: NaN })).toThrow(/origin/i);
  });

  it('recenters standards-valid ECEF tiles into East/Up/South without reflection', () => {
    const inverse = ecefToLocalMatrix({ longitude: 0, latitude: 0, altitude: 10 });
    const centre = new Vector3(6378137 + 10, 0, 0);
    expect(centre.clone().applyMatrix4(inverse).length()).toBeLessThan(1e-8);
    expect(centre.clone().add(new Vector3(0, 1, 0)).applyMatrix4(inverse).distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-8);
    expect(centre.clone().add(new Vector3(1, 0, 0)).applyMatrix4(inverse).distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-8);
    expect(centre.clone().add(new Vector3(0, 0, 1)).applyMatrix4(inverse).distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-8);
    expect(inverse.determinant()).toBeCloseTo(1, 12);
  });
});
