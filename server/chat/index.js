'use strict';

// Yandex resolves index.handler through the documented CommonJS export.
// Internal modules stay ESM; loading this entrypoint never reads credentials or
// creates a database connection. The runtime retains all request policy.
let runtime;
module.exports.handler = async function handler(event, context) {
  runtime ??= import('./src/runtime.mjs').catch((error) => {
    runtime = undefined;
    throw error;
  });
  return (await runtime).handler(event, context);
};
