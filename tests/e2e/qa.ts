import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

type NetworkEntry = { url: string; method: string; resourceType: string; status?: number; failure?: string };
type ConsoleEntry = { level: string; text: string; url?: string; lineNumber?: number };
const artifactRoot = () => resolve(process.env.OMNITWIN_DEMO_QA_ARTIFACTS ?? join(tmpdir(), 'omnitwin-demo-qa'));
const safeName = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '-');
const forbiddenRuntime = (url: string) => /(?:^|\/)v[12](?:\/|$)/.test(new URL(url).pathname);

export class QaEvidence {
  readonly startedAt = new Date().toISOString();
  readonly network: NetworkEntry[] = [];
  readonly console: ConsoleEntry[] = [];
  readonly errors: string[] = [];
  readonly snapshots: string[] = [];
  readonly directory: string;

  constructor(readonly page: Page, readonly info: TestInfo) {
    this.directory = join(artifactRoot(), info.project.name,
      `${safeName(info.title)}${info.repeatEachIndex > 0 ? `-repeat-${info.repeatEachIndex + 1}` : ''}`);
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type())) this.console.push({
        level: message.type(), text: message.text(), ...message.location(),
      });
    });
    page.on('pageerror', error => this.errors.push(error.message));
    page.on('request', request => this.network.push({
      url: request.url(), method: request.method(), resourceType: request.resourceType(),
    }));
    page.on('response', response => this.network.push({
      url: response.url(), method: response.request().method(),
      resourceType: response.request().resourceType(), status: response.status(),
    }));
    page.on('requestfailed', request => this.network.push({
      url: request.url(), method: request.method(), resourceType: request.resourceType(),
      failure: request.failure()?.errorText ?? 'unknown',
    }));
  }

  async capture(stage: string) {
    await mkdir(this.directory, { recursive: true });
    const prefix = join(this.directory, safeName(stage));
    await this.page.screenshot({ path: `${prefix}-viewport.png`, fullPage: false });
    await this.page.screenshot({ path: `${prefix}-fullpage.png`, fullPage: true });
    const state = await this.page.evaluate(() => ({
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
      documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      canvasCount: document.querySelectorAll('canvas').length,
      rendererEvidence: Array.from(document.querySelectorAll('[data-testid="demo-city"], [data-testid="world-canvas"]'))
        .map(element => Object.fromEntries(Array.from(element.attributes)
          .filter(attribute => attribute.name.startsWith('data-')).map(attribute => [attribute.name, attribute.value]))),
      visibleText: document.body.innerText,
    }));
    await writeFile(`${prefix}-state.json`, JSON.stringify(state, null, 2));
    this.snapshots.push(prefix);
  }

  async record(name: string, value: unknown) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, `${safeName(name)}.json`), JSON.stringify(value, null, 2));
  }

  async assertHealthy() {
    await expect(this.page.locator('vite-error-overlay, nextjs-portal, #webpack-dev-server-client-overlay')).toHaveCount(0);
    expect(this.errors, 'Uncaught application errors').toEqual([]);
    expect(this.console.filter(entry => entry.level === 'error'), 'Console errors are evidence, not suppressed').toEqual([]);
    expect(this.network.filter(entry => forbiddenRuntime(entry.url)), 'Static demo must not call original /v1 or /v2 runtime').toEqual([]);
    expect(this.network.filter(entry => entry.status !== undefined && entry.status >= 400), 'HTTP errors including real tile failures').toEqual([]);
  }

  async finish() {
    await mkdir(this.directory, { recursive: true });
    const files: Record<string, unknown> = {
      'console.json': this.console,
      'page-errors.json': this.errors,
      'network-manifest.json': this.network,
      'run-manifest.json': {
        classification: 'contaminated_diagnostic',
        performanceClaim: false,
        reason: 'Concurrent model workloads are not stopped or controlled by this QA run.',
        browserPath: 'Playwright; Browser plugin not available',
        realNetwork: true, mocks: false, canvasOrTileOverrides: false,
        project: this.info.project.name, title: this.info.title,
        status: this.info.status, startedAt: this.startedAt,
        durationMs: this.info.duration, url: this.page.url(), snapshots: this.snapshots,
      },
    };
    for (const [name, content] of Object.entries(files)) {
      const path = join(this.directory, name);
      await writeFile(path, JSON.stringify(content, null, 2));
      await this.info.attach(name, { path, contentType: 'application/json' });
    }
  }
}

export const test = base.extend<{ qa: QaEvidence }>({
  qa: [async ({ page }, use, info) => {
    const qa = new QaEvidence(page, info);
    try { await use(qa); }
    finally {
      if (info.status !== info.expectedStatus && !page.isClosed()) {
        await qa.capture('failure').catch(error => qa.errors.push(`Evidence capture: ${String(error)}`));
      }
      await qa.finish();
    }
  }, { auto: true }],
});
export { expect };

export async function openDemo(page: Page, entry = './') {
  await page.goto(entry, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/OmniTwin/i);
  await expect(page.getByRole('combobox', { name: 'Территория', exact: true })).toBeVisible();
  const menuWasHidden = !await navigationItem(page, 'Живой мир').isVisible();
  if (menuWasHidden) await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
  for (const name of ['Живой мир', 'Агенты', 'Сценарии', 'Аналитика', 'О проекте']) {
    await expect(navigationItem(page, name)).toBeVisible();
  }
  if (menuWasHidden) await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
}

export function navigationItem(page: Page, name: string) {
  return page.getByRole('navigation').getByRole('link', { name, exact: true });
}

export async function navigate(page: Page, name: string, route: string) {
  if (!await navigationItem(page, name).isVisible()) {
    await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
  }
  await navigationItem(page, name).click();
  await expect.poll(() => new URL(page.url()).hash.split('?')[0]).toBe(`#/${route}`);
}

export async function waitForRealWorld(page: Page) {
  const city = page.getByTestId('demo-city');
  await expect(city).toBeVisible();
  await expect(city).toHaveAttribute('data-source-state', /^online(?:_degraded)?$/, { timeout: 60_000 });
  await expect(city).toHaveAttribute('data-map-features-ready', 'true', { timeout: 60_000 });
  await expect.poll(async () => Number(await city.getAttribute('data-layout-buildings')), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(async () => Number(await city.getAttribute('data-layout-roads')), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(page.getByTestId('offline-fallback')).toHaveCount(0);
  // Planned actors and loaded tiles do not prove the living layer was drawn.
  // Require the actual renderer submission; do not paper over it with a sleep.
  const renderer = page.getByTestId('world-canvas');
  await expect.poll(async () => Number(await renderer.getAttribute('data-deck-living-submitted')), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(async () => Number(await renderer.getAttribute('data-demo-rendered-buildings')), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(renderer).toHaveAttribute('data-camera-settled', 'true');
  await expect.poll(async () => Number(await city.getAttribute('data-visible-people')), { timeout: 20_000 }).toBeGreaterThan(0);
}

export async function expectNoHorizontalOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  expect(sizes.content, 'Page-wide horizontal overflow; chart/table internal scroll is allowed').toBeLessThanOrEqual(sizes.width + 1);
}

export function contextInUrl(page: Page) {
  return new URLSearchParams(new URL(page.url()).hash.split('?')[1] ?? '');
}

export async function assertScriptedChatOnly(page: Page) {
  // Read the real deployed configuration before clicking Send. A non-null API
  // requires separate authorization; these tests never invoke a paid model.
  const response = await page.request.get('./runtime-config.json');
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).chatApiUrl, 'Do not run fallback QA against a connected model').toBeNull();
}
