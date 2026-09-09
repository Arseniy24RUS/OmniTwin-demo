export const ALLOWED_ORIGIN = 'https://arseniy24rus.github.io';

/** Public platform project metadata only; never resolve a config file or ADC. */
export function assertRuntimeProject(env, expectedProject) {
  if (expectedProject !== 'omnitwin-demo') throw new Error('Invalid runtime project.');
  const projects = [];
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) if (env[key] !== undefined) projects.push(env[key]);
  if (env.FIREBASE_CONFIG !== undefined) {
    try {
      if (typeof env.FIREBASE_CONFIG !== 'string' || env.FIREBASE_CONFIG.length > 4096 || !env.FIREBASE_CONFIG.startsWith('{')) throw new Error();
      projects.push(JSON.parse(env.FIREBASE_CONFIG).projectId);
    } catch { throw new Error('Invalid runtime project.'); }
  }
  if (!projects.length || projects.some(project => project !== expectedProject)) throw new Error('Invalid runtime project.');
}

// These are deployment ceilings, not a hard billing cap or a free-tier promise.
export const FUNCTION_OPTIONS = Object.freeze({
  region: 'europe-west1',
  minInstances: 0,
  maxInstances: 2,
  concurrency: 1,
  timeoutSeconds: 30,
  memory: '256MiB',
  cpu: 'gcf_gen1',
  serviceAccount: 'omnitwin-chat-runtime@omnitwin-demo.iam.gserviceaccount.com',
  cors: false,
  // Owner explicitly approved existing prepaid OpenRouter balance without a key cap.
  // Durable per-session/global request quotas remain enforced by the handler.
  invoker: 'public',
});
