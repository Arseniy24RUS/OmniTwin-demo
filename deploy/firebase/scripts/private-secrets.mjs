import { randomBytes } from 'node:crypto';

export const DEMO_PROJECT_ID = 'omnitwin-demo';
export const DEMO_PROJECT_NUMBER = '679501553916';
export const ALLOWED_SECRET_NAMES = Object.freeze(['OPENROUTER_API_KEY', 'SESSION_SIGNING_SECRET']);
const API = 'https://secretmanager.googleapis.com/v1';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const secretAllowed = (name) => ALLOWED_SECRET_NAMES.includes(name);
const verification = (status, name) => ({ status, name, needsVerification: true });

/**
 * One-time, server-only operator. No import-time work, CLI, files, environment
 * access, logging, or secret-value reads. The injected fetch must be trusted.
 *
 * Before calling ensure*, the human-controlled caller must persist a NONSECRET
 * attempt marker. Metadata listing is eventually consistent; an empty list is
 * NOT an atomic create-if-uninitialized guard. Use a single operator/writer and
 * never restart an uncertain create/add automatically. Reconcile metadata and
 * the durable attempt record manually. In-memory guards cannot survive restart.
 *
 * Pass tokens/keys privately in memory; never paste them into chat or logged
 * source. Only bounded statuses below are safe to print. Memory-only does not
 * promise erasure of immutable JS strings or removal from process crash dumps.
 */
export function createPrivateSecretsOperator({
  accessToken, fetchImpl = globalThis.fetch,
  projectId = DEMO_PROJECT_ID, expectedProjectNumber = DEMO_PROJECT_NUMBER,
  timeoutMs = 10_000,
} = {}) {
  if (projectId !== DEMO_PROJECT_ID || expectedProjectNumber !== DEMO_PROJECT_NUMBER || typeof fetchImpl !== 'function' || typeof accessToken !== 'string' || !/^[A-Za-z0-9._~+/-]{16,4096}={0,2}$/.test(accessToken) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error('Invalid private-secret operator configuration.');
  }
  const attempted = new Set();
  let queue = Promise.resolve();
  const path = (name) => `/projects/${DEMO_PROJECT_ID}/secrets/${name}`;
  const validResource = (value, name, version = false) => {
    if (typeof value !== 'string') return false;
    const parts = value.split('/');
    return parts.length === (version ? 6 : 4) && parts[0] === 'projects' && [DEMO_PROJECT_ID, DEMO_PROJECT_NUMBER].includes(parts[1]) && parts[2] === 'secrets' && parts[3] === name && (!version || (parts[4] === 'versions' && /^[1-9][0-9]{0,19}$/.test(parts[5])));
  };

  async function request(method, suffix, body) {
    try {
      const response = await fetchImpl(`${API}${suffix}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        // Deliberately do not parse, retain or display an API error envelope.
        try { await response.body?.cancel(); } catch { /* No diagnostic output. */ }
        return { kind: response.status === 404 ? 'absent' : 'failed' };
      }
      const text = await response.text();
      if (Buffer.byteLength(text) > 16_384) return { kind: 'unverified' };
      const data = JSON.parse(text);
      return isObject(data) ? { kind: 'ok', data } : { kind: 'unverified' };
    } catch {
      return { kind: 'unverified' };
    }
  }

  async function metadata(name) {
    const response = await request('GET', path(name));
    if (response.kind === 'absent') return { status: 'absent', name };
    if (response.kind !== 'ok') return verification('metadata_unverified', name);
    if (!validResource(response.data.name, name)) return verification('resource_mismatch', name);
    return { status: 'metadata_exists', name };
  }

  async function versions(name) {
    // No state filter: disabled/destroyed versions also forbid reinitialization.
    const response = await request('GET', `${path(name)}/versions?pageSize=1`);
    if (response.kind !== 'ok') return verification('versions_unverified', name);
    const data = response.data;
    if (Object.keys(data).some((field) => !['versions', 'nextPageToken', 'totalSize'].includes(field))) return verification('versions_unverified', name);
    const items = data.versions === undefined ? [] : data.versions;
    if (!Array.isArray(items) || items.length > 1 || items.some((item) => !isObject(item) || !validResource(item.name, name, true))) return verification('versions_unverified', name);
    if (items.length > 0) return { status: 'existing_versions', name, versionId: items[0].name.split('/')[5], needsVerification: true };
    // Empty protobuf fields may be omitted, but contradictory metadata is never
    // treated as proof that no version exists.
    if ((data.nextPageToken !== undefined && data.nextPageToken !== '') || (data.totalSize !== undefined && data.totalSize !== 0)) return verification('versions_unverified', name);
    return { status: 'empty', name };
  }

  async function ensure(name, valueFactory) {
    if (attempted.has(name)) return verification('already_attempted', name);
    attempted.add(name); // Set before yielding, including concurrent invocations.
    const run = async () => {
      try {
        const existing = await metadata(name);
        if (existing.status === 'absent') {
          const created = await request('POST', `/projects/${DEMO_PROJECT_ID}/secrets?secretId=${name}`, {
            replication: { automatic: {} }, labels: { application: 'omnitwin-demo', scope: 'demo-only' },
          });
          if (created.kind !== 'ok' || !validResource(created.data.name, name)) return verification('creation_outcome_unknown', name);
        } else if (existing.status !== 'metadata_exists') return existing;
        const current = await versions(name);
        if (current.status !== 'empty') return current;
        const value = valueFactory();
        const added = await request('POST', `${path(name)}:addVersion`, { payload: { data: Buffer.from(value, 'utf8').toString('base64') } });
        // Even a malformed success response may follow a committed add. There is
        // no automatic retry and no attempt to access the returned secret value.
        if (added.kind !== 'ok' || !validResource(added.data.name, name, true)) return verification('version_add_outcome_unknown', name);
        return { status: 'version_added', name, versionId: added.data.name.split('/')[5] };
      } catch {
        return verification('operation_unverified', name);
      }
    };
    const operation = queue.then(run, run);
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  return Object.freeze({
    async inspectSecret(name) {
      if (!secretAllowed(name)) return { status: 'invalid_input' };
      const existing = await metadata(name);
      return existing.status === 'metadata_exists' ? versions(name) : existing;
    },
    async ensureOpenRouterKey(value) {
      if (typeof value !== 'string' || value.length < 20 || value.length > 512 || /[\s\u0000-\u001f\u007f]/.test(value)) return { status: 'invalid_input', name: 'OPENROUTER_API_KEY' };
      return ensure('OPENROUTER_API_KEY', () => value);
    },
    async ensureSessionSigningSecret() {
      return ensure('SESSION_SIGNING_SECRET', () => randomBytes(64).toString('hex'));
    },
  });
}
