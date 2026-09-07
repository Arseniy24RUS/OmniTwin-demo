const MAX_BATCH_SIZE = 16;
const MAX_TIMESTAMP_MS = 253_402_300_799_999;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validKey = (key) => typeof key === 'string' && /^[a-z][A-Za-z0-9:_-]{0,255}$/.test(key);
const validExpiry = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP_MS;

function quotaValue(value) {
  if (!isObject(value)) throw new Error('Invalid quota value.');
  const keys = Object.keys(value).sort().join(',');
  if (keys === 'count' && Number.isSafeInteger(value.count) && value.count >= 0) return { count: value.count };
  if (keys === 'fingerprint,status' && typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint) && ['started', 'completed', 'failed'].includes(value.status)) {
    return { fingerprint: value.fingerprint, status: value.status };
  }
  // No arbitrary objects, messages, profiles, session tokens or model output.
  throw new Error('Invalid quota value.');
}

function validateKeys(keys) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_BATCH_SIZE || keys.some((key) => !validKey(key)) || new Set(keys).size !== keys.length) {
    throw new Error('Invalid quota keys.');
  }
}

/**
 * Inject the server-side Firestore instance and its Timestamp class. The caller
 * supplies application-default credentials; this module never reads credentials.
 * Only quota callbacks belong here: Firestore may re-run them on contention.
 * The LLM call remains in handler.mjs, after reservation has committed.
 */
export function createFirestoreTransactions({ firestore, Timestamp, collection = 'demo_chat_state', maxAttempts = 4 }) {
  if (typeof collection !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(collection)) throw new Error('Invalid quota collection.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 4) throw new Error('Invalid quota retry limit.');
  if (typeof firestore?.collection !== 'function' || typeof firestore?.runTransaction !== 'function' || typeof Timestamp?.fromMillis !== 'function') throw new Error('Invalid Firestore dependencies.');
  const documents = firestore.collection(collection);
  return {
    async transaction(work) {
      try {
        if (typeof work !== 'function') throw new Error('Invalid transaction callback.');
        return await firestore.runTransaction(async (nativeTx) => {
          // These variables reset for every SDK retry, never across transactions.
          const readKeys = new Set();
          let writing = false;
          let active = true;
          let pendingReads = 0;
          const tx = {
            async get(keys) {
              if (!active || writing) throw new Error('Quota reads must precede writes.');
              validateKeys(keys);
              pendingReads += 1;
              try {
                const snapshots = await nativeTx.getAll(...keys.map((key) => documents.doc(key)));
                if (!active || !Array.isArray(snapshots) || snapshots.length !== keys.length) throw new Error('Invalid quota result.');
                const result = new Map();
                snapshots.forEach((snapshot, index) => {
                  const key = keys[index];
                  if (snapshot.id !== key || typeof snapshot.exists !== 'boolean') throw new Error('Invalid quota document.');
                  readKeys.add(key);
                  if (!snapshot.exists) return;
                  const data = snapshot.data();
                  if (!isObject(data) || Object.keys(data).sort().join(',') !== 'expiresAt,value' || typeof data.expiresAt?.toMillis !== 'function') throw new Error('Invalid quota document.');
                  const expiresAt = data.expiresAt.toMillis();
                  if (!validExpiry(expiresAt)) throw new Error('Invalid quota expiry.');
                  result.set(key, { key, value: quotaValue(data.value), expiresAt });
                });
                return result;
              } finally { pendingReads -= 1; }
            },
            async put(rows) {
              if (!active || pendingReads !== 0 || !Array.isArray(rows)) throw new Error('Invalid quota write.');
              validateKeys(rows.map((row) => row?.key));
              const prepared = rows.map((row) => {
                if (!readKeys.has(row.key) || !validExpiry(row.expiresAt) || Object.keys(row).sort().join(',') !== 'expiresAt,key,value') throw new Error('Invalid quota write.');
                return { ref: documents.doc(row.key), data: { value: quotaValue(row.value), expiresAt: Timestamp.fromMillis(row.expiresAt) } };
              });
              writing = true;
              for (const { ref, data } of prepared) nativeTx.set(ref, data);
            },
          };
          try { return await work(tx); }
          finally { active = false; }
        }, { maxAttempts });
      } catch {
        // Let the SDK handle retries before stripping potentially sensitive SDK
        // error details. Ambiguous failures never fall back to an in-memory store.
        throw new Error('Quota transaction unavailable.');
      }
    },
  };
}
