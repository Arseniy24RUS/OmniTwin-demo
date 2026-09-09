import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('../../apps/web', import.meta.url)),
  test: { environment: 'node', maxWorkers: 1, include: ['src/renderer/game/GameActors.test.ts'] },
});
