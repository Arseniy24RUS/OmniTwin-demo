/*
 * Solar-position equations adapted from SunCalc 2.0.1.
 * Copyright (c) 2026, Volodymyr Agafonkin. BSD-2-Clause.
 * The complete notice is shipped in public/assets/living-city/licenses.
 */
import type { EnvironmentCycle2025 } from './cycle2025';

const PI = Math.PI;
const RAD = PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2_440_588;
const J2000 = 2_451_545;

export interface SunPosition {
  /** Degrees clockwise from geographic north. */
  readonly azimuthDegrees: number;
  /** Apparent altitude above the horizon in degrees. */
  readonly altitudeDegrees: number;
}

export interface SunLightState extends SunPosition {
  /** Unit vector in local east/north/up coordinates, pointing towards the sun. */
  readonly directionEnu: readonly [east: number, north: number, up: number];
  readonly daylight: number;
  readonly directionalIntensity: number;
  readonly ambientIntensity: number;
  readonly shadowOpacity: number;
  readonly streetLightIntensity: number;
  readonly windowEmission: number;
  readonly colorLinear: readonly [red: number, green: number, blue: number];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(minimum: number, maximum: number, value: number): number {
  const normalized = clamp01((value - minimum) / (maximum - minimum));
  return normalized * normalized * (3 - 2 * normalized);
}

function deltaT(daysSinceJ2000: number): number {
  const year = 2000 + daysSinceJ2000 / 365.2425;
  if (year < 1920) {
    const t = year - 1900;
    return -2.79 + t * (1.494119 + t * (-0.0598939 + t * (0.0061966 - t * 0.000197)));
  }
  if (year < 1941) {
    const t = year - 1920;
    return 21.2 + t * (0.84493 + t * (-0.0761 + t * 0.0020936));
  }
  if (year < 1961) {
    const t = year - 1950;
    return 29.07 + t * (0.407 + t * (-1 / 233 + t / 2547));
  }
  if (year < 1986) {
    const t = year - 1975;
    return 45.45 + t * (1.067 + t * (-1 / 260 - t / 718));
  }
  if (year < 2005) {
    const t = year - 2000;
    return 63.86 + t * (0.3345 + t * (-0.060374 + t * (0.0017275 + t * (0.000651814 + t * 0.00002373599))));
  }
  if (year < 2050) {
    const t = year - 2000;
    return 62.92 + t * (0.32217 + t * 0.005589);
  }
  const t = (year - 1820) / 100;
  return -20 + 32 * t * t - 0.5628 * (2150 - year);
}

function sunCoordinates(daysTerrestrialTime: number) {
  const centuries = daysTerrestrialTime / 36_525;
  const meanLongitude = RAD * (
    280.46646 + centuries * (36_000.76983 + centuries * 0.0003032)
  );
  const meanAnomaly = RAD * (
    357.52911 + centuries * (35_999.05029 - centuries * 0.0001537)
  );
  const sinAnomaly = Math.sin(meanAnomaly);
  const cosAnomaly = Math.cos(meanAnomaly);
  const equationOfCenter = RAD * (
    (1.914602 - centuries * (0.004817 + centuries * 0.000014)) * sinAnomaly
    + (0.019993 - 0.000101 * centuries) * 2 * sinAnomaly * cosAnomaly
    + 0.000289 * sinAnomaly * (3 - 4 * sinAnomaly * sinAnomaly)
  );
  const ascendingNode = RAD * (125.04 - 1934.136 * centuries);
  const longitude = meanLongitude + equationOfCenter
    - RAD * (0.00569 + 0.00478 * Math.sin(ascendingNode));
  const obliquity = RAD * (
    23.439291 - centuries * (
      0.0130042 + centuries * (0.00000016 - centuries * 0.000000504)
    )
  ) + RAD * 0.00256 * Math.cos(ascendingNode);

  return {
    rightAscension: Math.atan2(Math.cos(obliquity) * Math.sin(longitude), Math.cos(longitude)),
    declination: Math.asin(Math.sin(obliquity) * Math.sin(longitude)),
  };
}

function atmosphericRefraction(altitudeRadians: number): number {
  const safeAltitude = Math.max(0, altitudeRadians);
  return 0.0002967 / Math.tan(
    safeAltitude + 0.00312536 / (safeAltitude + 0.08901179),
  );
}

export function calculateSunPosition(
  date: Date,
  latitude: number,
  longitude: number,
): SunPosition {
  if (!Number.isFinite(date.valueOf())) throw new RangeError('date must be valid');
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError('latitude must be between -90 and 90');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError('longitude must be between -180 and 180');
  }

  const longitudeWest = -longitude * RAD;
  const latitudeRadians = latitude * RAD;
  const days = date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
  const coordinates = sunCoordinates(days + deltaT(days) / 86_400);
  const siderealTime = RAD * (280.46061837 + 360.98564736629 * days) - longitudeWest;
  const hourAngle = siderealTime - coordinates.rightAscension;
  const altitude = Math.asin(
    Math.sin(latitudeRadians) * Math.sin(coordinates.declination)
    + Math.cos(latitudeRadians) * Math.cos(coordinates.declination) * Math.cos(hourAngle),
  );
  const azimuth = (
    Math.atan2(
      Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(latitudeRadians)
        - Math.tan(coordinates.declination) * Math.cos(latitudeRadians),
    ) / RAD + 540
  ) % 360;

  return {
    azimuthDegrees: azimuth,
    altitudeDegrees: (altitude + atmosphericRefraction(altitude)) / RAD,
  };
}

function positionToDirection(position: SunPosition): readonly [number, number, number] {
  const azimuth = position.azimuthDegrees * RAD;
  const altitude = position.altitudeDegrees * RAD;
  const horizontal = Math.cos(altitude);
  return [
    Math.sin(azimuth) * horizontal,
    Math.cos(azimuth) * horizontal,
    Math.sin(altitude),
  ];
}

function normalized(vector: readonly [number, number, number]): readonly [number, number, number] {
  const length = Math.hypot(...vector) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function mixColor(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  amount: number,
): readonly [number, number, number] {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

/** Produces one solar state shared by map and Three scene lighting. */
export function calculateSunLightState(
  cycle: EnvironmentCycle2025,
  latitude: number,
  longitude: number,
  cloudCover = 0,
): SunLightState {
  const weightedDirection: [number, number, number] = [0, 0, 0];
  let weightedAltitude = 0;
  for (const instant of cycle.referenceInstants) {
    const position = calculateSunPosition(instant.date, latitude, longitude);
    const direction = positionToDirection(position);
    weightedDirection[0] += direction[0] * instant.weight;
    weightedDirection[1] += direction[1] * instant.weight;
    weightedDirection[2] += direction[2] * instant.weight;
    weightedAltitude += position.altitudeDegrees * instant.weight;
  }
  const direction = normalized(weightedDirection);
  const azimuthDegrees = (Math.atan2(direction[0], direction[1]) / RAD + 360) % 360;
  const altitudeDegrees = Math.asin(direction[2]) / RAD;
  const daylight = smoothstep(-6, 28, weightedAltitude);
  const twilight = smoothstep(-8, 5, weightedAltitude);
  const cloudAttenuation = 1 - 0.62 * clamp01(cloudCover);
  const horizonWarmth = 1 - smoothstep(4, 24, weightedAltitude);
  const daylightColor = mixColor([1, 0.53, 0.27], [1, 0.96, 0.84], 1 - horizonWarmth);
  const colorLinear = mixColor([0.32, 0.42, 0.68], daylightColor, twilight);
  const streetLightIntensity = 1 - smoothstep(-4, 5, weightedAltitude);

  return {
    azimuthDegrees,
    altitudeDegrees,
    directionEnu: direction,
    daylight,
    directionalIntensity: (0.035 + 3.1 * Math.pow(daylight, 0.72)) * cloudAttenuation,
    ambientIntensity: 0.14 + 0.92 * daylight * (0.78 + cloudAttenuation * 0.22),
    shadowOpacity: daylight * cloudAttenuation * 0.82,
    streetLightIntensity,
    windowEmission: 0.08 + 0.92 * streetLightIntensity,
    colorLinear,
  };
}
