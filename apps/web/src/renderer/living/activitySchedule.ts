import { LivingActivity, type LivingActivityScheduleDescriptor } from './types';

export const LIVING_ROUTE_LOCKED_ACTIVITY_PROFILE = 0xff;
export const LIVING_ACTIVITY_SCHEDULE_POLICY = 'scene_local_hourly_profile_v1' as const;
export const LIVING_ACTIVITY_SCHEDULE_DERIVATION_VERSION = '1.0.0' as const;
export const LIVING_ACTIVITY_SCHEDULE_FORMULA = (
  'network_edge=>activity=travel,profile=null;otherwise '
  + "profile=stable_seed(run_id,scene_id,entity_id,'activity-schedule')%12;"
  + 'activity=hourly_profile[profile][scene_local_hour]'
) as LivingActivityScheduleDescriptor['formula'];

const COMMUTE_BY_PROFILE = Uint8Array.of(
  LivingActivity.HOME,
  LivingActivity.TRANSIT,
  LivingActivity.TRANSIT,
);
const DAYTIME_BY_PROFILE = Uint8Array.of(
  LivingActivity.WORK,
  LivingActivity.STUDY,
  LivingActivity.WORK,
  LivingActivity.LEISURE,
);
const EVENING_BY_PROFILE = Uint8Array.of(
  LivingActivity.LEISURE,
  LivingActivity.HOME,
  LivingActivity.TRANSIT,
);

const hourFormatterByTimeZone = new Map<string, Intl.DateTimeFormat>();

export function supportedLivingActivityScheduleDescriptor(
  timeZone: string,
): LivingActivityScheduleDescriptor {
  return {
    classification: 'visual_synthesis',
    scientificClaim: false,
    policy: LIVING_ACTIVITY_SCHEDULE_POLICY,
    timeZone,
    derivationVersion: LIVING_ACTIVITY_SCHEDULE_DERIVATION_VERSION,
    formula: LIVING_ACTIVITY_SCHEDULE_FORMULA,
  };
}

function hourFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = hourFormatterByTimeZone.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-nu-latn', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new Error(`Living activity schedule requires a valid IANA time zone: ${timeZone}`);
  }
  hourFormatterByTimeZone.set(timeZone, formatter);
  return formatter;
}

export function validateLivingActivityScheduleDescriptor(
  descriptor: LivingActivityScheduleDescriptor,
): void {
  if (descriptor.classification !== 'visual_synthesis' || descriptor.scientificClaim !== false) {
    throw new Error('Living activity schedule must be non-scientific visual synthesis');
  }
  if (descriptor.policy !== LIVING_ACTIVITY_SCHEDULE_POLICY) {
    throw new Error(`Unsupported Living activity schedule policy: ${descriptor.policy}`);
  }
  if (descriptor.derivationVersion !== LIVING_ACTIVITY_SCHEDULE_DERIVATION_VERSION) {
    throw new Error(`Unsupported Living activity schedule derivation: ${descriptor.derivationVersion}`);
  }
  if (descriptor.formula !== LIVING_ACTIVITY_SCHEDULE_FORMULA) {
    throw new Error('Living activity schedule formula does not match the supported derivation');
  }
  if (typeof descriptor.timeZone !== 'string' || descriptor.timeZone.length === 0) {
    throw new Error('Living activity schedule requires a non-empty IANA time zone');
  }
  hourFormatter(descriptor.timeZone);
}

export function sceneLocalHourAtPresentationSeconds(
  descriptor: LivingActivityScheduleDescriptor,
  absolutePresentationSeconds: number,
): number {
  validateLivingActivityScheduleDescriptor(descriptor);
  if (!Number.isFinite(absolutePresentationSeconds)) {
    throw new Error('Living activity schedule presentation time must be finite');
  }
  const instant = new Date(absolutePresentationSeconds * 1_000);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error('Living activity schedule presentation time is outside the Date range');
  }
  const hour = Number(hourFormatter(descriptor.timeZone).format(instant));
  if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23) {
    throw new Error('Living activity schedule could not resolve the scene-local hour');
  }
  return hour;
}

export function resolveLivingActivityForLocalHour(profile: number, hour: number): LivingActivity {
  if (profile === LIVING_ROUTE_LOCKED_ACTIVITY_PROFILE) return LivingActivity.TRANSIT;
  if (!Number.isSafeInteger(profile) || profile < 0 || profile > 11) {
    throw new Error(`Living activity schedule profile must be in [0, 11] or 255: ${profile}`);
  }
  if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Living activity schedule local hour must be in [0, 23]: ${hour}`);
  }
  if (hour < 7 || hour >= 23) return LivingActivity.HOME;
  if (hour < 9 || (hour >= 17 && hour < 19)) {
    return COMMUTE_BY_PROFILE[profile % COMMUTE_BY_PROFILE.length] as LivingActivity;
  }
  if (hour < 17) {
    return DAYTIME_BY_PROFILE[profile % DAYTIME_BY_PROFILE.length] as LivingActivity;
  }
  return EVENING_BY_PROFILE[profile % EVENING_BY_PROFILE.length] as LivingActivity;
}

export function resolveLivingActivityAtPresentationSeconds(
  descriptor: LivingActivityScheduleDescriptor,
  profile: number,
  absolutePresentationSeconds: number,
): LivingActivity {
  return resolveLivingActivityForLocalHour(
    profile,
    sceneLocalHourAtPresentationSeconds(descriptor, absolutePresentationSeconds),
  );
}

/** Writes one retained hot-path column; the scene-local hour is resolved once per frame. */
export function writeLivingActivitiesAtPresentationSeconds(
  descriptor: LivingActivityScheduleDescriptor,
  profiles: Uint8Array,
  absolutePresentationSeconds: number,
  output: Uint8Array,
): Uint8Array {
  if (profiles.length !== output.length) {
    throw new Error('Living activity schedule profile/output lengths do not match');
  }
  const hour = sceneLocalHourAtPresentationSeconds(descriptor, absolutePresentationSeconds);
  for (let index = 0; index < profiles.length; index += 1) {
    output[index] = resolveLivingActivityForLocalHour(profiles[index]!, hour);
  }
  return output;
}
