import { cp, readdir, mkdir, readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

/** Omit rollback bytes only when a complete current local binary is pinned. */
async function hasCurrentActorBinary(source) {
  const assets=join(source,'assets'),pack=join(assets,'game-actors-v1'),manifestPath=join(pack,'manifest.json');
  try {
    for(const directory of [assets,pack])if(!(await lstat(directory)).isDirectory())return false;
    const metadata=await lstat(manifestPath);
    if(!metadata.isFile()||metadata.size>1024*1024)return false;
    const manifest=JSON.parse(await readFile(manifestPath,'utf8')),binary=manifest.binary;
    if(manifest.contractVersion!==1||!binary||typeof binary.url!=='string'||binary.url==='actors.bin'
      ||!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.bin$/.test(binary.url)||!Number.isSafeInteger(binary.bytes)
      ||binary.bytes<1||binary.bytes>64*1024*1024||typeof binary.sha256!=='string'||!/^[a-f0-9]{64}$/.test(binary.sha256))return false;
    const current=join(pack,binary.url),info=await lstat(current);
    if(!info.isFile()||info.size!==binary.bytes)return false;
    return createHash('sha256').update(await readFile(current)).digest('hex')===binary.sha256;
  } catch {
    // Missing, malformed or incomplete packs keep the previous shell behavior.
    return false;
  }
}

/** Large verified city packs live in Storage, never in the Pages artifact. */
export async function copyPublicShell(sourceDirectory, outputDirectory) {
  const source = resolve(sourceDirectory); const output = resolve(outputDirectory);
  if (source === output) throw new Error('Public shell source/output must differ');
  const omitLegacyActor=await hasCurrentActorBinary(source),legacyActor=join(source,'assets/game-actors-v1/actors.bin');
  await mkdir(output, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (['city-v2', 'demo-v2', 'city-visual-v1'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('Public shell symlink is not approved');
    await cp(join(source, entry.name), join(output, entry.name), { recursive: true, dereference: false,
      filter: path=>!omitLegacyActor||resolve(path)!==legacyActor });
  }
}
