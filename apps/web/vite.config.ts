import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: process.env.DEMO_BASE || '/OmniTwin-demo/',
  plugins: [react()],
  resolve: { alias: { '@omnitwin/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 5178, strictPort: false },
  preview: { host: '127.0.0.1', port: 4178 },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1700 },
  test: { environment: 'node', maxWorkers: 1, include: ['src/demo/**/*.test.{ts,tsx}'] },
});
