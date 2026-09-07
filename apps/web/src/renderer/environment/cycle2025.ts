export const ENVIRONMENT_REFERENCE_YEAR = 2025 as const;
export const REPEATING_ENVIRONMENT_MAPPING_LABEL_RU = 'Повторяемый визуальный цикл 2025';

export interface EnvironmentCycleInstant {
  readonly date: Date;
  readonly weight: number;
}

export interface EnvironmentCycle2025 {
  readonly id: 'repeating-reference-year-2025';
  readonly sourceYear: typeof ENVIRONMENT_REFERENCE_YEAR;
  readonly presentationYear: number;
  readonly timeZone: string;
  readonly localDateKey: string;
  readonly localMinuteOfDay: number;
  /** Milliseconds in the repeating 2025 local-civil year, independent of UTC offset. */
  readonly localPhaseMs: number;
  readonly referenceInstants: readonly EnvironmentCycleInstant[];
  readonly leapDayInterpolated: boolean;
  readonly sourceProvenance: 'visual_synthesis';
  readonly temporalMapping: 'visual_synthesis';
  readonly scientificClaim: false;
  readonly mappingLabel: typeof REPEATING_ENVIRONMENT_MAPPING_LABEL_RU;
}

/**
 * Resolves a UI minute-of-day onto the same scene-local 2025 phase used by
 * initial environment synthesis. It never treats a UTC epoch as local time.
 */
export function environmentPhaseForLocalMinute2025(
  cycle: EnvironmentCycle2025,
  localMinuteOfDay: number,
): number {
  if (
    !Number.isFinite(localMinuteOfDay)
    || localMinuteOfDay < 0
    || localMinuteOfDay >= 1_440
  ) {
    throw new RangeError('localMinuteOfDay must be within one civil day');
  }
  const localDayStartPhaseMs = cycle.localPhaseMs - cycle.localMinuteOfDay * 60_000;
  return localDayStartPhaseMs + localMinuteOfDay * 60_000;
}

/**
 * Advances a scene-local reference phase from the authoritative presentation
 * clock. The absolute clock may be seconds-since-start or an epoch timestamp;
 * only the delta from its explicit anchor is interpreted.
 */
export function environmentPhaseFromAbsoluteSeconds2025(
  anchorLocalPhaseMs: number,
  anchorAbsolutePresentationSeconds: number,
  absolutePresentationSeconds: number,
): number {
  if (
    !Number.isFinite(anchorLocalPhaseMs)
    || !Number.isFinite(anchorAbsolutePresentationSeconds)
    || !Number.isFinite(absolutePresentationSeconds)
  ) {
    throw new RangeError('Environment phase anchor and absolute clock must be finite');
  }
  return anchorLocalPhaseMs
    + (absolutePresentationSeconds - anchorAbsolutePresentationSeconds) * 1_000;
}

interface LocalDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const REFERENCE_YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

function wrapPhase(value: number): number {
  return ((value % REFERENCE_YEAR_MS) + REFERENCE_YEAR_MS) % REFERENCE_YEAR_MS;
}

function parseDate(value: Date | string | number): Date {
  const parsed = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) {
    throw new RangeError('presentationTime must be a valid date');
  }
  return parsed;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function localParts(date: Date, timeZone: string): LocalDateParts {
  const values = new Map<string, number>();
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') values.set(part.type, Number(part.value));
  }
  const required = (key: string) => {
    const value = values.get(key);
    if (!Number.isFinite(value)) throw new RangeError(`Cannot resolve ${key} in ${timeZone}`);
    return value as number;
  };
  return {
    year: required('year'),
    month: required('month') - 1,
    day: required('day'),
    hour: required('hour'),
    minute: required('minute'),
    second: required('second'),
    millisecond: required('fractionalSecond'),
  };
}

function offsetAt(instantMs: number, timeZone: string): number {
  const instant = new Date(instantMs);
  const parts = localParts(instant, timeZone);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  return representedAsUtc - instantMs;
}

function referenceInstant(parts: Omit<LocalDateParts, 'year'>, timeZone: string): Date {
  const civilAsUtc = Date.UTC(
    ENVIRONMENT_REFERENCE_YEAR,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  let candidate = civilAsUtc;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    candidate = civilAsUtc - offsetAt(candidate, timeZone);
  }
  return new Date(candidate);
}

/**
 * Advances a cycle in local-civil time while re-resolving every source instant
 * through its IANA zone. This preserves leap-day interpolation and DST rules.
 */
export function advanceEnvironmentCycle2025(
  cycle: EnvironmentCycle2025,
  targetLocalPhaseMs: number,
): EnvironmentCycle2025 {
  if (!Number.isFinite(targetLocalPhaseMs)) {
    throw new RangeError('targetLocalPhaseMs must be finite');
  }
  const normalizedPhaseMs = wrapPhase(targetLocalPhaseMs);
  const rawDeltaMs = targetLocalPhaseMs - cycle.localPhaseMs;
  const deltaMs = ((rawDeltaMs + REFERENCE_YEAR_MS / 2) % REFERENCE_YEAR_MS
    + REFERENCE_YEAR_MS) % REFERENCE_YEAR_MS - REFERENCE_YEAR_MS / 2;
  const phaseCivil = new Date(Date.UTC(ENVIRONMENT_REFERENCE_YEAR, 0, 1) + normalizedPhaseMs);
  const referenceInstants = cycle.referenceInstants.map((instant) => {
    const parts = localParts(instant.date, cycle.timeZone);
    const shiftedCivil = new Date(Date.UTC(
      ENVIRONMENT_REFERENCE_YEAR,
      parts.month,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      parts.millisecond,
    ) + deltaMs);
    return {
      date: referenceInstant({
        month: shiftedCivil.getUTCMonth(),
        day: shiftedCivil.getUTCDate(),
        hour: shiftedCivil.getUTCHours(),
        minute: shiftedCivil.getUTCMinutes(),
        second: shiftedCivil.getUTCSeconds(),
        millisecond: shiftedCivil.getUTCMilliseconds(),
      }, cycle.timeZone),
      weight: instant.weight,
    };
  });
  const localMinuteOfDay = phaseCivil.getUTCHours() * 60
    + phaseCivil.getUTCMinutes()
    + phaseCivil.getUTCSeconds() / 60
    + phaseCivil.getUTCMilliseconds() / 60_000;
  return {
    ...cycle,
    localDateKey: `${String(phaseCivil.getUTCMonth() + 1).padStart(2, '0')}-${String(phaseCivil.getUTCDate()).padStart(2, '0')}`,
    localMinuteOfDay,
    localPhaseMs: normalizedPhaseMs,
    referenceInstants,
  };
}

/**
 * Maps presentation time onto a stable 365-day reference year in local civil
 * time. A leap day is the midpoint between 28 February and 1 March at the same
 * local clock time, so playback never jumps a whole day.
 */
export function mapToEnvironmentCycle2025(
  presentationTime: Date | string | number,
  timeZone: string,
): EnvironmentCycle2025 {
  if (!timeZone.trim()) throw new RangeError('timeZone must be a non-empty IANA zone');
  const presentation = parseDate(presentationTime);
  const parts = localParts(presentation, timeZone);
  const isLeapDay = parts.month === 1 && parts.day === 29;
  const create = (month: number, day: number, weight: number): EnvironmentCycleInstant => ({
    date: referenceInstant(
      {
      month,
      day,
        hour: parts.hour,
        minute: parts.minute,
        second: parts.second,
        millisecond: parts.millisecond,
      },
      timeZone,
    ),
    weight,
  });
  const referenceInstants = isLeapDay
    ? [create(1, 28, 0.5), create(2, 1, 0.5)]
    : [create(parts.month, parts.day, 1)];
  const localPhaseFor = (month: number, day: number) => Date.UTC(
    ENVIRONMENT_REFERENCE_YEAR,
    month,
    day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  ) - Date.UTC(ENVIRONMENT_REFERENCE_YEAR, 0, 1);
  const localPhaseMs = isLeapDay
    ? (localPhaseFor(1, 28) + localPhaseFor(2, 1)) / 2
    : localPhaseFor(parts.month, parts.day);

  return {
    id: 'repeating-reference-year-2025',
    sourceYear: ENVIRONMENT_REFERENCE_YEAR,
    presentationYear: parts.year,
    timeZone,
    localDateKey: `${String(parts.month + 1).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    localMinuteOfDay: parts.hour * 60 + parts.minute + parts.second / 60
      + parts.millisecond / 60_000,
    localPhaseMs,
    referenceInstants,
    leapDayInterpolated: isLeapDay,
    sourceProvenance: 'visual_synthesis',
    temporalMapping: 'visual_synthesis',
    scientificClaim: false,
    mappingLabel: REPEATING_ENVIRONMENT_MAPPING_LABEL_RU,
  };
}
