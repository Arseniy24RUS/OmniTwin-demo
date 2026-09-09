import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { opaqueGzipMiddleware } from '../../tools/opaque-gzip-middleware.mjs';
import { copyPublicShell } from '../../tools/copy-public-shell.mjs';
import { movementPreviewMiddleware } from '../../tools/movement-preview-middleware.mjs';

export default defineConfig({
  base: process.env.DEMO_BASE || '/OmniTwin-demo/',
  plugins: [react(), {
    name: 'verified-city-gzip-assets',
    configureServer(server) {
      // Never copied into dist or exposed by the production preview server.
      server.middlewares.use(movementPreviewMiddleware(fileURLToPath(new URL('../../.cache/movement-mode-v2', import.meta.url)),server.config.base));
      server.middlewares.use(opaqueGzipMiddleware(server.config.publicDir, server.config.base));
    },
    configurePreviewServer(server) {
      server.middlewares.use(opaqueGzipMiddleware(fileURLToPath(new URL('./dist', import.meta.url)), server.config.base));
    },
  }, {
    name: 'public-shell-only',
    apply: 'build',
    async writeBundle() {
      await copyPublicShell(fileURLToPath(new URL('./public', import.meta.url)), fileURLToPath(new URL('./dist', import.meta.url)));
    },
  }],
  resolve: { alias: { '@omnitwin/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 5178, strictPort: false },
  preview: { host: '127.0.0.1', port: 4178 },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1700, copyPublicDir: false },
  test: { environment: 'node', maxWorkers: 1, include: ['src/demo/**/*.test.{ts,tsx}', 'src/renderer/game/**/*.test.ts', 'src/renderer/actor{Physical,Shaders,Atlas,Occlusion}.test.ts', 'src/renderer/presentationMeterBridge.test.ts', 'src/renderer/aggregateRoadFlow.test.ts', 'src/renderer/deckAdapter.test.ts', 'src/renderer/living/partition.test.ts', 'src/renderer/runtime/performanceGovernor.test.ts'] },
});
