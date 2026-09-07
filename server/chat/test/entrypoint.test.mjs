import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const execFileAsync = promisify(execFile);

test('deployment entrypoint follows the documented CommonJS export contract', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.type, 'commonjs');
  const { stdout, stderr } = await execFileAsync(process.execPath, ['--input-type=commonjs', '-e', `
    const assert = require('node:assert/strict');
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error('Network forbidden in entrypoint test'); };
    const entry = require('./index.js');
    assert.equal(typeof entry.handler, 'function');
    assert.deepEqual(Object.keys(entry), ['handler']);
    assert.equal(networkCalls, 0);
    entry.handler({ headers: {} }, {}).then((response) => {
      assert.equal(response.statusCode, 503);
      assert.deepEqual(JSON.parse(response.body), { source: 'unavailable', reason: 'service_not_configured' });
      assert.equal(networkCalls, 0);
      process.stdout.write(JSON.stringify({ commonJsEntry: true, noCredentials: true, networkCalls }));
    }).catch((error) => { console.error(error); process.exitCode = 1; });
  `], { cwd: root, env: {}, timeout: 10_000 });
  // An empty child environment intentionally excludes all operator credentials.
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), { commonJsEntry: true, noCredentials: true, networkCalls: 0 });
});
