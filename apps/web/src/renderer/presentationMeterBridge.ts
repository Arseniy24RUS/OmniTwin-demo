import { WebMercatorViewport } from '@deck.gl/core';

/**
 * Display-only conversion. The retained worker frame uses 111320*cos(lat) and
 * 110540 local units per degree. They are not Deck's METER_OFFSETS. Invert the
 * installed SDK's high-precision metre transform so original source WGS84 is
 * preserved without changing routes, speed state, provider data or science.
 */
export function createPresentationMeterBridge(origin: readonly [number, number]) {
  const viewport = new WebMercatorViewport({ longitude: origin[0], latitude: origin[1], zoom: 0, width: 1, height: 1 });
  const scales = viewport.getDistanceScales([...origin]);
  // The public getter's base TS return type omits its documented-origin
  // high-precision fields, present in the pinned SDK implementation.
  const highPrecision = scales as typeof scales & { unitsPerMeter2?: readonly number[] };
  if (!highPrecision.unitsPerMeter2 || !Number.isFinite(highPrecision.unitsPerMeter2[0])) throw new Error('Deck high-precision metre scales unavailable');
  const originWorldY = viewport.projectPosition([origin[0], origin[1], 0])[1];
  const longitudeSourceUnits = 111_320 * Math.cos(origin[1] * Math.PI / 180);
  const worldUnitsPerDegreeX = 512 / 360;
  const unitsX = scales.unitsPerMeter[0]!;
  const unitsY = scales.unitsPerMeter[1]!;
  const unitsX2 = highPrecision.unitsPerMeter2[0]!;
  const write = (target: Float32Array | Float64Array, offset: number, sourceX: number, sourceY: number, z: number): void => {
    const latitude = origin[1] + sourceY / 110_540;
    const worldY = (Math.PI + Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360))) * 512 / (2 * Math.PI);
    const deckY = (worldY - originWorldY) / unitsY;
    target[offset] = sourceX / longitudeSourceUnits * worldUnitsPerDegreeX / (unitsX + unitsX2 * deckY);
    target[offset + 1] = deckY;
    target[offset + 2] = z;
  };
  return {
    origin,
    write,
    fromGeographic(longitude: number, latitude: number, z = 0): [number, number, number] {
      const result = new Float64Array(3);
      write(result, 0, (((longitude - origin[0] + 540) % 360) - 180) * longitudeSourceUnits, (latitude - origin[1]) * 110_540, z);
      return [result[0]!, result[1]!, result[2]!];
    },
  };
}
