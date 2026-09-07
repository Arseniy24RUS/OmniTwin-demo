import { createHash } from 'node:crypto';
import { issueSession, verifySession } from './sessions.mjs';

const MAX_BODY_BYTES = 8192;
const INPUT_FIELDS = new Set(['personId', 'datasetId', 'scenario', 'year', 'presentationMinutes', 'message', 'history', 'sessionToken', 'requestId']);
const SCENARIOS = new Set(['baseline', 'inflow', 'ageing']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);

export async function withinDeadline(task, signal) {
  let rejectOnAbort;
  const expired = new Promise((_, reject) => {
    rejectOnAbort = () => reject(new Error('Request deadline reached.'));
    if (signal.aborted) rejectOnAbort();
    else signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try { return await Promise.race([task, expired]); }
  finally { signal.removeEventListener('abort', rejectOnAbort); }
}

function parseInput(event) {
  if (typeof event.body !== 'string') throw Object.assign(new Error(), { status: 400 });
  // Check encoded size before allocating a decoded body as well.
  if (Buffer.byteLength(event.body) > MAX_BODY_BYTES * (event.isBase64Encoded ? 1.4 : 1)) throw Object.assign(new Error(), { status: 413 });
  const bytes = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  if (bytes.length > MAX_BODY_BYTES) throw Object.assign(new Error(), { status: 413 });
  const input = JSON.parse(bytes.toString('utf8'));
  if (!isObject(input)) throw new Error();
  return input;
}

function validateInput(input, config) {
  if (Object.keys(input).some((key) => !INPUT_FIELDS.has(key))) return null;
  if (!boundedText(input.personId, 100) || !boundedText(input.datasetId, 100) || !SCENARIOS.has(input.scenario)) return null;
  if (config.acceptsDataset ? !config.acceptsDataset(input.datasetId) : input.datasetId !== config.datasetId) return null;
  if (config.canResolvePerson && !config.canResolvePerson(input.datasetId, input.personId)) return null;
  if (!Number.isInteger(input.year) || input.year < 2026 || input.year > 2036 || !Number.isFinite(input.presentationMinutes) || input.presentationMinutes < 0 || input.presentationMinutes >= 1440) return null;
  if (!boundedText(input.message, 600) || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(input.requestId)) return null;
  const history = input.history ?? [];
  if (!Array.isArray(history) || history.length > 4 || history.some((item) => !isObject(item) || Object.keys(item).some((key) => !['role', 'content'].includes(key)) || !['user', 'assistant'].includes(item.role) || !boundedText(item.content, 300))) return null;
  // History is untrusted user-provided transcript, never an instruction channel.
  return { ...input, history };
}

function legacyContext(input, config) {
  const profile = config.profiles.get(input.personId);
  if (!profile) return null;
  const membership = profile.membership?.[input.scenario];
  if (profile.membership && (!membership || input.year < membership.entryYear || (membership.exitYear !== null && input.year >= membership.exitYear))) return null;
  return { profile: config.profileForYear ? config.profileForYear(profile, input.year, input.scenario) : profile, profileHash: config.profileHash };
}

export function createHandler({ config, quota, upstream, now = Date.now, requestTimeoutMs = 25_000 }) {
  if (!config?.origins?.length || typeof config.sessionSecret !== 'string' || Buffer.byteLength(config.sessionSecret) < 32 || !quota || !upstream) throw new Error('Incomplete server configuration.');
  return async function handler(event, { signal: outerSignal } = {}) {
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const origin = headers.origin;
    const allowedOrigin = config.origins.includes(origin);
    const response = (statusCode, body, extraHeaders = {}) => ({
      statusCode,
      headers: {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin',
        ...(allowedOrigin ? { 'Access-Control-Allow-Origin': origin } : {}), ...extraHeaders,
      },
      body: JSON.stringify(body), isBase64Encoded: false,
    });
    const unavailable = (status, reason, requestId) => response(status, { source: 'unavailable', reason, ...(requestId ? { requestId } : {}) });
    if (!allowedOrigin) return unavailable(403, 'origin_not_allowed');
    const method = event.httpMethod;
    const path = event.path;
    if (!['/session', '/chat'].includes(path)) return unavailable(404, 'not_found');
    if (method === 'OPTIONS') return response(204, {}, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
    if (method !== 'POST') return unavailable(405, 'method_not_allowed');
    if (typeof headers['content-type'] !== 'string' || headers['content-type'].split(';')[0].trim().toLowerCase() !== 'application/json') return unavailable(400, 'invalid_input');
    let input;
    try { input = parseInput(event); } catch (error) { return unavailable(error.status ?? 400, error.status === 413 ? 'input_too_large' : 'invalid_input'); }
    const timestamp = now();
    if (path === '/session') {
      if (Object.keys(input).length !== 0) return unavailable(400, 'invalid_input');
      // Anonymous signed capability, NOT user authentication. The durable global
      // quota protects spending even when a caller requests multiple sessions.
      return response(200, issueSession(config.sessionSecret, origin, timestamp));
    }
    const session = verifySession(input.sessionToken, config.sessionSecret, origin, timestamp);
    if (!session) return unavailable(401, 'invalid_session');
    const approvedInput = validateInput(input, config);
    if (!approvedInput) return unavailable(400, 'invalid_input');
    const requestId = input.requestId;
    const signal = outerSignal ? AbortSignal.any([outerSignal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs);
    if (signal.aborted) return unavailable(503, 'quota_unavailable', requestId);
    const { sessionToken: ignored, ...requestData } = approvedInput;
    let reservation;
    const reserve = async profileHash => {
      const fingerprint = createHash('sha256').update(JSON.stringify({ profileHash, ...requestData })).digest('hex');
      try { reservation = await withinDeadline(quota.reserve({ sessionId: session.sid, requestId, fingerprint, now: timestamp }), signal); }
      catch { return unavailable(503, 'quota_unavailable', requestId); }
      return reservation.allowed ? null : unavailable(reservation.reason === 'rate_limited' ? 429 : 409, reservation.reason, requestId);
    };
    const profileFailure = async (status, reason) => {
      if (reservation?.allowed && !signal.aborted) {
        try { await withinDeadline(quota.finalize(reservation.requestKey, 'failed'), signal); } catch { /* The admitted attempt remains consumed and cannot be replayed. */ }
      }
      return unavailable(status, reason, requestId);
    };
    // Remote V2 data consumes an existing attempt before I/O, including an
    // unknown/inactive record or asset failure. Legacy validation stays local.
    const admittedHash = config.profileRevisionFor?.(input.datasetId) ?? null;
    if (admittedHash !== null) {
      if (typeof admittedHash !== 'string' || !/^[a-f0-9]{64}$/.test(admittedHash)) return unavailable(503, 'profile_unavailable', requestId);
      const denied = await reserve(admittedHash); if (denied) return denied;
    }
    let canonical;
    try {
      if (signal.aborted) throw new Error('Request deadline reached.');
      const { datasetId, personId, scenario, year, presentationMinutes } = approvedInput;
      canonical = config.resolveProfile
        ? await withinDeadline(Promise.resolve().then(() => config.resolveProfile({ datasetId, personId, scenario, year, presentationMinutes }, { signal })), signal)
        : legacyContext(approvedInput, config);
      if (signal.aborted) throw new Error('Request deadline reached.');
    } catch { return profileFailure(503, 'profile_unavailable'); }
    if (!canonical) return profileFailure(400, 'invalid_input');
    if (!isObject(canonical.profile) || canonical.profile.id !== input.personId || typeof canonical.profileHash !== 'string' || !/^[a-f0-9]{64}$/.test(canonical.profileHash) || admittedHash !== null && canonical.profileHash !== admittedHash) return profileFailure(503, 'profile_unavailable');
    const validated = { input: approvedInput, profile: canonical.profile, ...(canonical.presence ? { presence: canonical.presence } : {}) };
    if (!reservation) { const denied = await reserve(canonical.profileHash); if (denied) return denied; }
    let result;
    try {
      if (signal.aborted) throw new Error('Request deadline reached.');
      result = await withinDeadline(upstream({ ...validated, signal }), signal);
      if (!isObject(result) || !boundedText(result.reply, 1800) || Buffer.byteLength(JSON.stringify(result)) > 7000) throw new Error('Invalid upstream output.');
    } catch {
      if (!signal.aborted) {
        try { await withinDeadline(quota.finalize(reservation.requestKey, 'failed'), signal); } catch { /* Reservation remains consumed and cannot be replayed. */ }
      }
      return unavailable(503, 'provider_unavailable', requestId);
    }
    try { await withinDeadline(quota.finalize(reservation.requestKey, 'completed'), signal); }
    catch { return unavailable(503, 'quota_unavailable', requestId); }
    return response(200, { reply: result.reply, source: 'llm', requestId, model: result.model });
  };
}
