import { defineConfig } from '@playwright/test';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const baseURL = process.env.OMNITWIN_DEMO_QA_URL ?? 'http://127.0.0.1:5178/OmniTwin-demo/';
const target = new URL(baseURL);
const loopbackDemo = target.protocol === 'http:' && target.hostname === '127.0.0.1' && Boolean(target.port);
const publishedDemo = target.protocol === 'https:' && target.hostname === 'arseniy24rus.github.io' && !target.port;
if ((!loopbackDemo && !publishedDemo) || target.pathname !== '/OmniTwin-demo/' ||
    target.search || target.hash || target.username || target.password) {
  throw new Error('QA must target the explicit demo loopback or the owner-authorized GitHub Pages deployment.');
}

const artifacts = resolve(process.env.OMNITWIN_DEMO_QA_ARTIFACTS ?? join(tmpdir(), 'omnitwin-demo-qa'));

// Start/reuse only the operator-confirmed demo server. This config deliberately
// does not start another server or touch the original model/OmniTwin processes.
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: join(artifacts, 'test-results'),
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: join(artifacts, 'playwright-results.json') }]],
  use: {
    baseURL,
    browserName: 'chromium',
    headless: false,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    acceptDownloads: true,
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-1920x1080', testMatch: /(?:journey|map-interactions|visual-readiness|cohort-state|observed-reference)\.spec\.ts/,
      use: { viewport: { width: 1920, height: 1080 }, contextOptions: { screen: { width: 1920, height: 1080 }, reducedMotion: 'no-preference' } } },
    { name: 'portrait-390x844', testMatch: /(?:responsive|observed-reference)\.spec\.ts/,
      use: { viewport: { width: 390, height: 844 }, contextOptions: { screen: { width: 390, height: 844 }, reducedMotion: 'no-preference' }, isMobile: true, hasTouch: true } },
    { name: 'landscape-844x390', testMatch: /responsive\.spec\.ts/,
      use: { viewport: { width: 844, height: 390 }, contextOptions: { screen: { width: 844, height: 390 }, reducedMotion: 'no-preference' }, isMobile: true, hasTouch: true } },
  ],
});
