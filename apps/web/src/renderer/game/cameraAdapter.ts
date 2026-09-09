import { MercatorCoordinate } from 'maplibre-gl';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';

export interface GameOrigin { longitude: number; latitude: number; altitude?: number }

/** Deliberately only the PUBLIC CustomRenderMethodInput fields of MapLibre 6.4. */
export interface GameCameraInput {
  projectionMatrix: ArrayLike<number>;
  nearZ: number;
  farZ: number;
  fov: number;
  defaultProjectionData: { mainMatrix: ArrayLike<number>; projectionTransition: number };
}

function validateOrigin(origin: GameOrigin): void {
  if (![origin.longitude, origin.latitude, origin.altitude ?? 0].every(Number.isFinite)
    || Math.abs(origin.latitude) >= 85.051129 || Math.abs(origin.longitude) > 180) {
    throw new Error('Invalid local city origin.');
  }
}

/** Three local right-handed East / Up / South metres -> conformal Mercator. */
export function localToMercatorMatrix(origin: GameOrigin, target = new Matrix4()): Matrix4 {
  validateOrigin(origin);
  const point = MercatorCoordinate.fromLngLat([origin.longitude, origin.latitude], origin.altitude ?? 0);
  const s = point.meterInMercatorCoordinateUnits();
  return target.set(s, 0, 0, point.x, 0, 0, s, point.y, 0, s, 0, point.z, 0, 0, 0, 1);
}

/** WGS84 ECEF -> the same local East / Up / South metres used by actors. */
export function ecefToLocalMatrix(origin: GameOrigin): Matrix4 {
  validateOrigin(origin);
  const lon = origin.longitude * Math.PI / 180;
  const lat = origin.latitude * Math.PI / 180;
  const sl = Math.sin(lon), cl = Math.cos(lon), sp = Math.sin(lat), cp = Math.cos(lat);
  const n = 6378137 / Math.sqrt(1 - 6.6943799901413165e-3 * sp * sp);
  const h = origin.altitude ?? 0;
  return new Matrix4().makeBasis(
    new Vector3(-sl, cl, 0), new Vector3(cp * cl, cp * sl, sp), new Vector3(sp * cl, sp * sl, -cp),
  ).setPosition((n + h) * cp * cl, (n + h) * cp * sl, (n * (1 - 6.6943799901413165e-3) + h) * sp).invert();
}

const localMatrix = new Matrix4();
const projection = new Matrix4();
const scaledView = new Matrix4();

function readMatrix(values: ArrayLike<number>, target: Matrix4): Matrix4 {
  if (values.length !== 16 || !Array.from(values).every(Number.isFinite)) throw new Error('Invalid public camera matrix.');
  target.fromArray(values);
  if (Math.abs(target.determinant()) < 1e-24) throw new Error('Singular public camera matrix.');
  return target;
}

/** MapLibre clones P into Float32 but supplies P*V in Float64. Recover only the
 * standard perspective coefficients independently specified by its public API.
 * Inverting rounded depth terms otherwise adds a projective row whose error
 * grows with distance from the fixed city origin. Off-centre offsets are kept. */
function readPublicPerspective(input: GameCameraInput, target: Matrix4): Matrix4 {
  readMatrix(input.projectionMatrix, target);
  const { nearZ: near, farZ: far, fov } = input;
  if (![near, far, fov].every(Number.isFinite) || near <= 0 || far <= near || fov <= 0 || fov >= Math.PI) {
    throw new Error('Invalid public perspective metadata.');
  }
  const e = target.elements, depth = -(far + near) / (far - near), translation = -2 * far * near / (far - near);
  const vertical = 1 / Math.tan(fov / 2);
  const float32Close = (actual: number, expected: number) => Math.abs(actual - expected) <= Math.abs(expected) * 2 ** -23;
  if (e[0] <= 0 || e[11] !== -1 || [1, 2, 3, 4, 6, 7, 12, 13, 15].some(index => e[index] !== 0)
    || !float32Close(e[5], vertical) || !float32Close(e[10], depth) || !float32Close(e[14], translation)) {
    throw new Error('Unsupported public perspective projection.');
  }
  e[5] = vertical; e[10] = depth; e[14] = translation;
  return target;
}

/**
 * Factor P * V * localOrigin into a proper metre-space Three camera. MapLibre's
 * P is in world pixels: leaving that uniform scale inside V breaks lighting,
 * distance LOD and camera positions even when the first screenshot aligns.
 * Dividing the combined clip matrix by a positive scale preserves shared depth.
 * No private map.transform, free-camera guess, or camera reconstruction by pitch.
 */
export function applyMapLibreCamera(camera: PerspectiveCamera, input: GameCameraInput, origin: GameOrigin): number {
  if (input.defaultProjectionData.projectionTransition !== 0) throw new Error('The game city supports Mercator projection only.');
  readPublicPerspective(input, projection);
  readMatrix(input.defaultProjectionData.mainMatrix, scaledView);
  // Recenter before deprojection: the Mercator clip translation is ~1e8 while
  // the city-local translation is ~1e3. This order avoids world-scale cancellation.
  scaledView.multiply(localToMercatorMatrix(origin, localMatrix))
    .premultiply(camera.projectionMatrixInverse.copy(projection).invert());
  const e = scaledView.elements;
  const sx = Math.hypot(e[0], e[1], e[2]);
  const sy = Math.hypot(e[4], e[5], e[6]);
  const sz = Math.hypot(e[8], e[9], e[10]);
  const orthogonality = Math.max(
    Math.abs(e[0] * e[4] + e[1] * e[5] + e[2] * e[6]) / (sx * sy),
    Math.abs(e[0] * e[8] + e[1] * e[9] + e[2] * e[10]) / (sx * sz),
    Math.abs(e[4] * e[8] + e[5] * e[9] + e[6] * e[10]) / (sy * sz),
  );
  if (!(sx > 0) || !Number.isFinite(sx) || Math.abs(sy / sx - 1) > 1e-6 || Math.abs(sz / sx - 1) > 1e-6
    || orthogonality > 1e-6 || scaledView.determinant() <= 0 || Math.abs(e[15] - 1) > 1e-7
    || Math.max(Math.abs(e[3]), Math.abs(e[7]), Math.abs(e[11])) / sx > 1e-10) {
    throw new Error('Unsupported non-rigid public camera matrix.');
  }
  // An admitted rigid view is affine. Remove only its verified round-off residue
  // so Three's camera position and metre-sized picking rays use the same origin.
  e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
  for (let column = 0; column < 4; column++) for (let row = 0; row < 3; row++) e[column * 4 + row] /= sx;
  camera.matrixAutoUpdate = false;
  camera.matrixWorldAutoUpdate = false;
  camera.matrixWorldInverse.copy(scaledView);
  camera.matrixWorld.copy(scaledView).invert();
  camera.matrix.copy(camera.matrixWorld);
  camera.position.setFromMatrixPosition(camera.matrixWorld);
  camera.quaternion.setFromRotationMatrix(camera.matrixWorld);
  camera.scale.set(1, 1, 1);
  camera.projectionMatrix.copy(projection);
  // P_pixel * scale(s) / s: first three columns cancel; translation scales.
  for (let row = 0; row < 4; row++) camera.projectionMatrix.elements[12 + row] /= sx;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  camera.near = input.nearZ / sx;
  camera.far = input.farZ / sx;
  camera.fov = input.fov * 180 / Math.PI;
  camera.aspect = projection.elements[5] / projection.elements[0];
  return sx;
}
