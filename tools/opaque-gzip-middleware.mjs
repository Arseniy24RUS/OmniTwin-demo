import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** Match production's opaque gzip aliases; the browser verifies compressed bytes. */
export function opaqueGzipMiddleware(publicRoot, base) {
  const root = resolve(publicRoot);
  return (request, response, next) => {
    if (!['GET', 'HEAD'].includes(request.method)) return next();
    let path;
    try { path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { return next(); }
    if (!path.startsWith(base)) return next();
    const relative = path.slice(base.length);
    if (!/^(?:demo-v2|city-v2)\/[a-zA-Z0-9_./-]+\.gz$/.test(relative) || relative.split('/').includes('..')) return next();
    const file = resolve(root, relative);
    if (!file.startsWith(`${root}${sep}`)) return next();
    void stat(file).then(info => {
      if (!info.isFile()) return next();
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/gzip');
      response.setHeader('Content-Length', info.size);
      response.setHeader('Cache-Control', 'public, max-age=3600');
      // Explicit .gz is an opaque asset, not HTTP transport compression.
      response.removeHeader('Content-Encoding');
      if (request.method === 'HEAD') return response.end();
      const stream = createReadStream(file);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    }, () => next());
  };
}
