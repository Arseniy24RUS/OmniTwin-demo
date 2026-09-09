#!/usr/bin/env node
/** Real-source functional junction probe; owns its Chromium context and Temp artifacts. */
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args=process.argv.slice(2),option=name=>{
  const index=args.indexOf(name);return index<0?undefined:args[index+1];
};
for(let i=0;i<args.length;i++){
  if(args[i]==='--cold-playing')continue;
  if(['--pose','--duration'].includes(args[i])&&args[i+1]&&!args[i+1].startsWith('--')){i++;continue;}
  throw Error(`Unsupported QA argument: ${args[i]}`);
}
const pose=option('--pose')??'original',coldPlaying=args.includes('--cold-playing');
const durationSeconds=Number(option('--duration')??34);
if(!['original','wide'].includes(pose)||!Number.isFinite(durationSeconds)||durationSeconds<30||durationSeconds>90)
  throw Error('QA pose must be original/wide and duration between 30 and 90 seconds');
const sourceFiles = ['junctionTraffic.ts', 'laneTraffic.ts', 'opposingLaneReservations.ts', 'gameActorHeading.ts', 'actorColumnsBridge.ts', 'actorFootprintClearance.ts', 'TiledGameScene.tsx'];
const output = join(tmpdir(), `omnitwin-city-junctions-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(output, { recursive: true });
async function fingerprint() {
  const hash = createHash('sha256');
  for (const name of sourceFiles) hash.update(name).update(await readFile(join(root, 'apps/web/src/renderer/game', name)));
  return hash.digest('hex');
}
const browserChannel = process.env.OMNITWIN_QA_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'chrome' : 'chromium');
if (!['chrome', 'msedge', 'chromium'].includes(browserChannel)) throw Error('Unsupported QA browser channel');
const report = { contract: 'JunctionTrafficBrowserEvidenceV1', performanceClaim: false, browserChannel,
  pose,startup:coldPlaying?'cold_playing':'paused_until_ready',durationSeconds,
  sourceFiles, sourceSha256Before: await fingerprint(), sourceSha256After: null, errors: [], checks: [], samples: [], artifacts: [],
  limitations: ['Presentation probe is bounded to 64 cars and 64 pedestrians per sample.',
    'Body checks use source tangent headings and presentation samples, not interpolated renderer matrices.',
    'Concurrent local work and video recording preclude a performance claim.'] };
const browser = await chromium.launch({ headless: true, ...(browserChannel === 'chromium' ? {} : { channel: browserChannel }) });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: output, size: { width: 960, height: 600 } } });
const page = await context.newPage();
page.on('pageerror', error => report.errors.push(error.message));
const camera = pose==='wide'?{longitude:61.36655003525502,latitude:55.15701676371921,
  zoom:16.284,pitch:35.00168684811705,bearing:95.88051943032724}:
  { longitude: 61.40335931261333, latitude: 55.166641128116765,
    zoom: 18.2, pitch: 46.49661799282392, bearing: -172.97699800600026 };
report.camera = camera;
const params = new URLSearchParams({ scenario: 'baseline', year: '2026', territory: 'RU-CHE-SET',
  minutes: pose==='wide'?'925':'707.7335833333341', paused: coldPlaying?'0':'1', speed: '1', weather: 'clear', lon: String(camera.longitude), lat: String(camera.latitude),
  zoom: String(camera.zoom), pitch: String(camera.pitch), bearing: String(camera.bearing), stats: 'observed', observedYear: '2024',
  dataset: 'omnitwin-fictional-city-v2', graphics: 'tiled_game' });
const deadline = Date.now() + 70_000 + durationSeconds*1000;
try {
  await page.goto('http://127.0.0.1:5178/OmniTwin-demo/#/world?' + params, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-testid="world-canvas"]');
    return element?.readGameTrafficProbe?.().managedVehicles > 0 && element?.readGameSignalProbe?.().junctions.length > 0;
  }, null, { timeout: 60_000 });
  if(!coldPlaying)await page.getByTestId('play-toggle').click();
  const start = Date.now();
  for (let i = 0; i < 500 && Date.now() - start < durationSeconds*1000 && Date.now() < deadline; i++) {
    report.samples.push(await page.evaluate(() => {
      const element = document.querySelector('[data-testid="world-canvas"]');
      return { traffic: element.readGameTrafficProbe(), signals: element.readGameSignalProbe(),
        renderer: element.readGameOwnershipProbe?.()?.diagnostics.state,
        signalRenderer: JSON.parse(element.dataset.gameSignals ?? 'null'),
        trafficMembership: JSON.parse(element.dataset.gameTraffic ?? 'null') };
    }));
    if (i === 3) await page.screenshot({ path: join(output, 'junction-start.png') });
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: join(output, 'junction-end.png') });
} catch (error) {
  report.errors.push(error.message);
  await page.screenshot({ path: join(output, 'error.png') }).catch(() => {});
} finally {
  await context.close();
  await browser.close();
}
const minimums = { carCar: Infinity, carPed: Infinity }, violations = [], bodyViolations = [];
const carBody = actor => {
  const angle = Number(actor.laneKey.split(':')[0]) / 1e8;
  return { forward: [Math.cos(angle), Math.sin(angle)], side: [-Math.sin(angle), Math.cos(angle)], center: actor.point };
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
function bodiesOverlap(a, b) {
  const x = carBody(a), delta = [b.point[0] - a.point[0], b.point[1] - a.point[1]];
  if (b.kind === 'pedestrian') {
    const longitudinal = Math.max(0, Math.abs(dot(delta, x.forward)) - 2.25);
    const lateral = Math.max(0, Math.abs(dot(delta, x.side)) - 1);
    return Math.hypot(longitudinal, lateral) < .35 - 1e-4;
  }
  const y = carBody(b);
  return [x.forward, x.side, y.forward, y.side].every(axis => Math.abs(dot(delta, axis)) <
    2.25 * (Math.abs(dot(x.forward, axis)) + Math.abs(dot(y.forward, axis))) +
    Math.abs(dot(x.side, axis)) + Math.abs(dot(y.side, axis)) - 1e-4);
}
let pairChecks = 0;
for (let i = 0; i < report.samples.length; i++) {
  const sample = report.samples[i], cars = sample.traffic.vehicles.filter(actor => actor.visible), peds = sample.traffic.pedestrians.filter(actor => actor.visible);
  for (let a = 0; a < cars.length; a++) for (const b of [...cars.slice(a + 1), ...peds]) {
    const car = cars[a], kind = b.kind === 'pedestrian' ? 'carPed' : 'carCar';
    const distance = Math.hypot(car.point[0] - b.point[0], car.point[1] - b.point[1]);
    pairChecks++; minimums[kind] = Math.min(minimums[kind], distance);
    if (distance < (kind === 'carPed' ? 1.35 : 2.05)) violations.push({ sample: i, kind, ids: [car.id, b.id], distance });
    if (distance < 5 && bodiesOverlap(car, b)) bodyViolations.push({ sample: i, kind, ids: [car.id, b.id], distance });
  }
}
const first = report.samples[0], last = report.samples.at(-1), check = (name, pass) => report.checks.push({ name, pass: Boolean(pass) });
report.sourceSha256After = await fingerprint();
Object.assign(report, { pairChecks, minimums, violations, bodyViolations, elapsedPresentationSeconds: last?.traffic.time - first?.traffic.time,
  phaseKinds: [...new Set(report.samples.flatMap(sample => sample.signals.junctions.map(node => node.phase)))],
  maximumRoadsideProps: Math.max(0, ...report.samples.map(sample => sample.signals.junctions.flatMap(node => node.approaches).filter(approach => approach.signalPoint !== null).length)),
  waitingSamples: report.samples.filter(sample => sample.signals.junctions.some(node => node.approaches.some(approach => approach.waiting > 0))).length });
check('source metadata unchanged during run', report.sourceSha256Before === report.sourceSha256After);
check('sampled a full visual phase cycle', report.elapsedPresentationSeconds >= 30 && report.phaseKinds.length === 3);
check('actual source cars and pedestrians controlled', report.samples.length > 20 && report.samples.every(sample => sample.traffic.managedVehicles > 0 && sample.traffic.managedPedestrians > 0));
check('all sampled source traversals are regulated', report.samples.every(sample => sample.trafficMembership?.unsupportedTraversalVehicles === 0 && sample.trafficMembership?.unsupportedTraversalPedestrians === 0));
check('renderer remains active through signal phase changes', report.samples.every(sample => sample.renderer === 'rendering'));
check('source refresh preserves retained presentation', last?.traffic.sourceRefreshes > first?.traffic.sourceRefreshes && last?.traffic.sourceReanchors === first?.traffic.sourceReanchors);
check('signals have verified roadside placements', report.maximumRoadsideProps > 0);
check('signal node and approach identities remain unique', report.samples.every(sample => {
  const nodes=sample.signals.junctions,ids=nodes.map(node=>node.id);
  const approaches=nodes.flatMap(node=>node.approaches.map(approach=>`${node.id}:${approach.id}`));
  return new Set(ids).size===ids.length&&new Set(approaches).size===approaches.length;
}));
check('signal props do not enter an error or disposed state', report.samples.every(sample=>
  sample.signalRenderer&&!['error_hidden','disposed'].includes(sample.signalRenderer.state)));
check('queues wait at conflict barriers', report.waitingSamples > 0);
check('no bounded-controller overflow', report.samples.every(sample => sample.signals.diagnostics.overflow === 0 && sample.traffic.admissionOverflows === 0 && sample.traffic.followingOverflows === 0));
check('no close-centre collision diagnostic', violations.length === 0 && pairChecks > 1000);
check('no source-tangent body envelope overlap', bodyViolations.length === 0 && pairChecks > 1000);
check('no page or harness errors', report.errors.length === 0);
for (const name of (await readdir(output)).sort()) {
  const bytes = await readFile(join(output, name));
  report.artifacts.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, checks: report.checks, pairChecks, minimums, elapsedPresentationSeconds: report.elapsedPresentationSeconds, errors: report.errors }));
process.exitCode = report.checks.every(item => item.pass) ? 0 : 1;
