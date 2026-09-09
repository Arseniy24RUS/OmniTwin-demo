import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {replacePreviewManifest} from './atomic-preview-write.mjs';

test('verified preview manifest replaces existing bytes and failed replacement preserves them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omnitwin-preview-'));
  try {
    const target = join(dir, 'manifest.json'), next = join(dir, 'manifest.json.next');
    await writeFile(target, '{"generation":1}\n');
    await writeFile(next, '{"generation":2}\n');
    assert.ok(['rename', 'windows_replacefile'].includes(await replacePreviewManifest(next, target)));
    assert.equal(await readFile(target, 'utf8'), '{"generation":2}\n');
    await assert.rejects(readFile(next), {code: 'ENOENT'});
    await assert.rejects(replacePreviewManifest(next, target), {code: 'ENOENT'});
    assert.equal(await readFile(target, 'utf8'), '{"generation":2}\n');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
