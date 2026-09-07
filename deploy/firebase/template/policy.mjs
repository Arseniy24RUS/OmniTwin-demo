export const ALLOWED_ORIGIN = 'https://arseniy24rus.github.io';

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
