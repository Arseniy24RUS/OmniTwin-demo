import { cp, readdir, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/** Large verified city packs live in Storage, never in the Pages artifact. */
export async function copyPublicShell(sourceDirectory, outputDirectory) {
  const source = resolve(sourceDirectory); const output = resolve(outputDirectory);
  if (source === output) throw new Error('Public shell source/output must differ');
  await mkdir(output, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (['city-v2', 'demo-v2'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('Public shell symlink is not approved');
    await cp(join(source, entry.name), join(output, entry.name), { recursive: true, dereference: false });
  }
}
