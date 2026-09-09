/** Normalize presentation templates; these dimensions are visual synthesis, not observations. */
export function normalizeActorFrames(frames, target) {
  const base = frames[0];
  if (!base?.length || base.length % 3 || frames.some(frame => frame.length !== base.length)) throw new Error('Actor frames must share nonempty XYZ topology');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < base.length; i++) {
    if (!Number.isFinite(base[i])) throw new Error('Actor positions must be finite');
    min[i % 3] = Math.min(min[i % 3], base[i]); max[i % 3] = Math.max(max[i % 3], base[i]);
  }
  const size = max.map((value, axis) => value - min[axis]);
  if (size.some(value => value <= 0) || !Number.isFinite(target.height) || target.height <= 0) throw new Error('Actor bounds and target height must be positive');
  const car = target.length != null || target.width != null;
  if (car && [target.length, target.width].some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Vehicle width and length must be positive');
  const rotate = car && size[0] > size[2];
  const uniform = target.height / size[1];
  const dimensions = car ? {height: target.height, width: target.width, length: target.length} : {height: target.height, width: size[0] * uniform, length: size[2] * uniform};
  const sx = dimensions.width / size[rotate ? 2 : 0], sz = dimensions.length / size[rotate ? 0 : 2];
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  for (const frame of frames) for (let i = 0; i < frame.length; i += 3) {
    const x = frame[i] - cx, z = frame[i + 2] - cz;
    frame[i] = (rotate ? z : x) * sx;
    frame[i + 1] = (frame[i + 1] - min[1]) * uniform;
    frame[i + 2] = (rotate ? -x : z) * sz;
  }
  return dimensions;
}
