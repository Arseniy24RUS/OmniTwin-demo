const MAX_BODY_BYTES = 8192;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function transportHeaders(input) {
  if (!isObject(input)) throw new Error('Invalid HTTP headers.');
  const output = {};
  for (const [name, value] of Object.entries(input)) {
    if (!headerName.test(name)) throw new Error('Invalid HTTP header.');
    if (value === undefined) continue;
    const normalized = Array.isArray(value) && value.every((part) => typeof part === 'string') ? value.join(', ') : value;
    if (typeof normalized !== 'string' || /[\r\n]/.test(normalized)) throw new Error('Invalid HTTP header.');
    output[name.toLowerCase()] = normalized;
  }
  return output;
}

/**
 * Convert Firebase onRequest's Express transport into the existing chat event.
 * rawBody is authoritative: req.body is never trusted, read, or reserialized.
 * The Functions framework may already have parsed req.body before onRequest;
 * this 8KB check precedes all JSON parsing and quota/provider work in our code.
 */
export function createFirebaseHttpHandler({ handler, origins = [] }) {
  if (typeof handler !== 'function' || !Array.isArray(origins) || origins.some((value) => typeof value !== 'string')) throw new Error('Invalid HTTP adapter configuration.');
  const allowedOrigins = new Set(origins);
  return async function firebaseHttp(req, res) {
    let origin;
    const unavailable = (status, reason) => {
      res.status(status).set({
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', Vary: 'Origin',
        ...(allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
      }).send(JSON.stringify({ source: 'unavailable', reason }));
    };
    try {
      let headers;
      try {
        if (!isObject(req) || typeof req.method !== 'string' || !/^[A-Z]+$/.test(req.method) || typeof req.path !== 'string' || !req.path.startsWith('/')) throw new Error('Invalid HTTP request.');
        headers = transportHeaders(req.headers);
        origin = headers.origin;
      } catch { return unavailable(400, 'invalid_input'); }
      const rawBody = req.rawBody;
      if (Buffer.isBuffer(rawBody) && rawBody.length > MAX_BODY_BYTES) return unavailable(413, 'input_too_large');
      if (rawBody !== undefined && !Buffer.isBuffer(rawBody)) return unavailable(400, 'invalid_input');
      if (req.method === 'POST' && !Buffer.isBuffer(rawBody)) return unavailable(400, 'invalid_input');
      const result = await handler({
        httpMethod: req.method,
        path: req.path,
        headers,
        queryStringParameters: req.query ?? {},
        body: (rawBody ?? Buffer.alloc(0)).toString('base64'),
        isBase64Encoded: true,
      });
      if (!isObject(result) || !Number.isInteger(result.statusCode) || result.statusCode < 200 || result.statusCode > 599 || typeof result.body !== 'string' || Buffer.byteLength(result.body) > MAX_BODY_BYTES || result.isBase64Encoded === true || !isObject(result.headers)) throw new Error('Invalid HTTP response.');
      // Validate all response headers before starting a response; never relay an
      // exception, a provider error object or a partially validated header set.
      for (const [name, value] of Object.entries(result.headers)) {
        if (!headerName.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid HTTP response header.');
      }
      res.status(result.statusCode).set(result.headers);
      if (result.statusCode === 204) return res.end();
      return res.send(result.body);
    } catch {
      // No request body, header values, session tokens or upstream errors logged.
      if (!res.headersSent) return unavailable(503, 'server_unavailable');
      return res.end();
    }
  };
}
