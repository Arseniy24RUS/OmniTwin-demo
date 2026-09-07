import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyPublicShell } from '../copy-public-shell.mjs';

test('Pages shell excludes generated city/population packs but preserves legacy and UI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnitwin-public-shell-'));
  const source = join(directory, 'public'); const output = join(directory, 'dist');
  for (const name of ['city-v2', 'demo-v2', 'demo', 'textures']) {
    await mkdir(join(source, name), { recursive: true }); await writeFile(join(source, name, 'fixture.json'), '{}');
  }
  await writeFile(join(source, 'runtime-config.json'), '{}');
  await copyPublicShell(source, output);
  assert.deepEqual((await readdir(output)).sort(), ['demo', 'runtime-config.json', 'textures']);
  await assert.rejects(copyPublicShell(source, source), /must differ/);
});
