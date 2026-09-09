#!/usr/bin/env node
/** Bounded real-source turnaround regression in an independent Chromium context. */
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(tmpdir(), `omnitwin-city-traffic-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
const targetId = 'demo2-v-0137107';
const sourceFiles = ['laneTraffic.ts', 'actorColumnsBridge.ts'];
async function fingerprint() {
  const hash = createHash('sha256');
  for (const name of sourceFiles) hash.update(await readFile(join(root, 'apps/web/src/renderer/game', name)));
  return hash.digest('hex');
}
const before = await fingerprint();
const report = { contract: 'PingPongTrafficBrowserEvidenceV1', performanceClaim: false,
  targetId, sourceSha256Before: before, sourceSha256After: null, samples: [], errors: [], checks: [], artifacts: [] };
const browserChannel=process.env.OMNITWIN_QA_BROWSER_CHANNEL??(process.platform==='win32'?'chrome':'chromium');
if(!['chrome','msedge','chromium'].includes(browserChannel))throw Error('Unsupported QA browser channel');
report.browserChannel=browserChannel;
const browser = await chromium.launch({ headless: true,...(browserChannel==='chromium'?{}:{channel:browserChannel}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 },
  recordVideo: { dir: output, size: { width: 960, height: 600 } } });
const page = await context.newPage();
page.on('pageerror', error => report.errors.push(error.message));
const params = new URLSearchParams({ scenario: 'baseline', year: '2026', territory: 'RU-CHE-SET',
  minutes: '732.10', paused: '1', speed: '1', weather: 'clear', lon: '61.40335931261333',
  lat: '55.166641128116765', zoom: '19', pitch: '46.49661799282392', bearing: '-172.97699800600026',
  stats: 'observed', observedYear: '2024', dataset: 'omnitwin-fictional-city-v2', graphics: 'tiled_game' });
const deadline = Date.now() + 75_000;
try {
  await page.goto('http://127.0.0.1:5178/OmniTwin-demo/#/world?' + params, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForFunction(id => document.querySelector('[data-testid="world-canvas"]')
    ?.readGameTrafficProbe?.([id]).vehicles.length > 0, targetId, { timeout: 25_000 });
  // A direct hash change remounts DemoCity. Use the real play control so this
  // regression observes one retained Scene through source refreshes and a turn.
  await page.getByTestId('play-toggle').click();
  let previousDistance = null, capturedTurn = false;
  for (let i = 0; i < 75 && Date.now() < deadline; i++) {
    const sample = await page.evaluate(id => {
      const element = document.querySelector('[data-testid="world-canvas"]');
      return { probe: element.readGameTrafficProbe([id]), traffic: JSON.parse(element.dataset.gameTraffic ?? 'null') };
    }, targetId);
    report.samples.push(sample);
    const row = sample.probe.vehicles[0];
    if (row && previousDistance !== null && row.distance < previousDistance - 50 && !capturedTurn) {
      capturedTurn = true;
      await page.screenshot({ path: join(output, 'traffic-turn.png') });
    }
    if (row) previousDistance = row.distance;
    if (i === 5 || i === 70) await page.screenshot({ path: join(output, `sample-${i}.png`) });
    await page.waitForTimeout(150);
  }
  const rows = report.samples.filter(sample => sample.probe.vehicles.length);
  const moves = rows.slice(1).map((row, i) => {
    const previous = rows[i], a = previous.probe.vehicles[0], b = row.probe.vehicles[0];
    return { dt: row.probe.time - previous.probe.time, meters: Math.hypot(b.point[0] - a.point[0], b.point[1] - a.point[1]) };
  });
  const check = (name, pass) => report.checks.push({ name, pass: Boolean(pass) });
  check('real source target sampled across turnaround', rows.length >= 10 && capturedTurn);
  check('target remains visible while in source inventory', rows.every(row => row.probe.vehicles[0].visible));
  check('all current vehicle traversals regulated', report.samples.every(sample => sample.traffic?.unsupportedTraversalVehicles === 0));
  check('no position jump, including endpoint reversal and pause', moves.every(move => move.meters <= 7 * move.dt + 1e-5));
  check('source refresh occurs without presentation reanchor', rows.at(-1)?.probe.sourceRefreshes > rows[0]?.probe.sourceRefreshes
    && rows.at(-1)?.probe.sourceReanchors === rows[0]?.probe.sourceReanchors);
  Object.assign(report, { rowSamples: rows.length, visibleSamples: rows.filter(row => row.probe.vehicles[0].visible).length,
    elapsedTargetSeconds: rows.at(-1)?.probe.time - rows[0]?.probe.time,
    maxStepSpeed: Math.max(0, ...moves.filter(move => move.dt > 0).map(move => move.meters / move.dt)),
    sourceReanchors: [rows[0]?.probe.sourceReanchors, rows.at(-1)?.probe.sourceReanchors],
    sourceRefreshes: [rows[0]?.probe.sourceRefreshes, rows.at(-1)?.probe.sourceRefreshes] });
} catch (error) {
  report.errors.push(error.message);
  await page.screenshot({ path: join(output, 'error.png') }).catch(() => {});
} finally {
  await context.close();
  await browser.close();
}
report.sourceSha256After = await fingerprint();
report.checks.push({ name: 'traffic modules unchanged during run', pass: report.sourceSha256Before === report.sourceSha256After });
report.checks.push({ name: 'no page or harness errors', pass: report.errors.length === 0 });
for (const name of (await readdir(output)).sort()) {
  const bytes = await readFile(join(output, name));
  report.artifacts.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, checks: report.checks, rowSamples: report.rowSamples, maxStepSpeed: report.maxStepSpeed, errors: report.errors }));
process.exitCode = report.checks.every(check => check.pass) && report.samples.length > 0 ? 0 : 1;
