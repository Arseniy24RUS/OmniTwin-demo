import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { loadConfig } from './src/config.mjs';
import { createHandler, withinDeadline } from './src/handler.mjs';
import { createQuotaStore } from './src/quota.mjs';
import { createOpenRouter } from './src/openrouter.mjs';
import { createFirestoreTransactions } from './src/firestore.mjs';
import { createFirebaseHttpHandler } from './src/firebase-http.mjs';
import { PROFILE_MANIFEST_SHA256 } from './approved-profile.mjs';
import { ALLOWED_ORIGIN, FUNCTION_OPTIONS } from './policy.mjs';
import { createFirebaseRuntime } from './runtime.mjs';

const OPENROUTER_API_KEY = defineSecret('OPENROUTER_API_KEY');
const SESSION_SIGNING_SECRET = defineSecret('SESSION_SIGNING_SECRET');

const runtime = createFirebaseRuntime({
  withinDeadline,
  initialize: async () => {
    // Missing bindings fail silently before SecretParam.value() can emit an SDK
    // diagnostic. Never resolve secrets during deployment source discovery.
    if (!process.env.OPENROUTER_API_KEY || !process.env.SESSION_SIGNING_SECRET) throw new Error('Missing runtime bindings.');
    const config = await loadConfig({
      OPENROUTER_API_KEY: OPENROUTER_API_KEY.value(),
      SESSION_SIGNING_SECRET: SESSION_SIGNING_SECRET.value(),
      ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      PROFILE_MANIFEST_PATH: 'data/chat-profiles.json',
      PROFILE_MANIFEST_SHA256,
      // Non-secret immutable asset pins are operator configuration. No remote
      // profile reads happen until an approved V2 /chat request is validated.
      ...(process.env.V2_POPULATION_MANIFEST_URL !== undefined ? { V2_POPULATION_MANIFEST_URL: process.env.V2_POPULATION_MANIFEST_URL } : {}),
      ...(process.env.V2_POPULATION_MANIFEST_SHA256 !== undefined ? { V2_POPULATION_MANIFEST_SHA256: process.env.V2_POPULATION_MANIFEST_SHA256 } : {}),
      ...(process.env.V2_SPATIAL_MANIFEST_URL !== undefined ? { V2_SPATIAL_MANIFEST_URL: process.env.V2_SPATIAL_MANIFEST_URL } : {}),
      ...(process.env.V2_SPATIAL_MANIFEST_SHA256 !== undefined ? { V2_SPATIAL_MANIFEST_SHA256: process.env.V2_SPATIAL_MANIFEST_SHA256 } : {}),
      FIRESTORE_COLLECTION: 'demo_chat_state',
    }, { storage: 'firestore' });
    // Application Default Credentials are supplied by the deployed service
    // identity; no service-account JSON or browser Firebase SDK is packaged.
    const app = getApps().find((item) => item.name === '[DEFAULT]') ?? initializeApp();
    const transactions = createFirestoreTransactions({
      firestore: getFirestore(app), Timestamp, collection: config.firestore.collection,
    });
    return createHandler({ config, quota: createQuotaStore(transactions), upstream: createOpenRouter({ apiKey: config.apiKey }) });
  },
});

export const chatApi = onRequest(
  { ...FUNCTION_OPTIONS, secrets: [OPENROUTER_API_KEY, SESSION_SIGNING_SECRET] },
  createFirebaseHttpHandler({ handler: runtime, origins: [ALLOWED_ORIGIN] }),
);
