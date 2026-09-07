import type { Page } from '@playwright/test';
import { test, expect, openDemo, waitForRealWorld, contextInUrl } from './qa';

type Candidate = { id: string; kind: 'person' | 'vehicle' | 'building'; x: number; y: number; onCanvas?: boolean };
async function candidates(page: Page): Promise<Candidate[]> {
  const renderer = page.getByTestId('world-canvas');
  const actors: unknown = JSON.parse(await renderer.getAttribute('data-demo-actor-pick-candidates') ?? '[]');
  const buildings: unknown = JSON.parse(await renderer.getAttribute('data-demo-building-pick-candidates') ?? '[]');
  if (!Array.isArray(actors) || !Array.isArray(buildings)) throw new Error('Renderer candidates must be arrays.');
  const value: unknown = [...actors, ...buildings];
  if (!Array.isArray(value)) throw new Error('Renderer candidate evidence must be an array.');
  return value.filter((item): item is Candidate => Boolean(item && typeof item.id === 'string' &&
    ['person', 'vehicle', 'building'].includes(item.kind) && Number.isFinite(item.x) && Number.isFinite(item.y)));
}

async function visibleCandidate(page: Page, kind: Candidate['kind']) {
  const canvas = await page.locator('canvas').boundingBox();
  if (!canvas) throw new Error('The actual map canvas has no box.');
  const observed = (await candidates(page)).filter(item => item.kind === kind && item.onCanvas !== false)
    .sort((a, b) => Math.hypot(a.x - canvas.width / 2, a.y - canvas.height / 2) -
      Math.hypot(b.x - canvas.width / 2, b.y - canvas.height / 2));
  for (const candidate of observed) {
    const x = canvas.x + candidate.x;
    const y = canvas.y + candidate.y;
    if (candidate.x < 8 || candidate.y < 8 || candidate.x > canvas.width - 8 || candidate.y > canvas.height - 8) continue;
    // Only choose an observed candidate whose pixel is actually exposed to the
    // user. Never click through the summary, toolbar, clock, or another overlay.
    if (await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', { x, y })) {
      return { ...candidate, pageX: x, pageY: y };
    }
  }
  return null;
}

async function pauseAtSettledPose(page: Page) {
  const renderer = page.getByTestId('world-canvas');
  const beforePauseRevision = Number(await renderer.getAttribute('data-telemetry-flush-revision'));
  await page.getByRole('button', { name: 'Приостановить движение', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Запустить движение', exact: true })).toBeVisible();
  await expect.poll(async () => Number(await renderer.getAttribute('data-telemetry-flush-revision'))).toBeGreaterThan(beforePauseRevision);
  await expect(renderer).toHaveAttribute('data-demo-clock-paused', 'true');
  await expect.poll(async () => Math.abs(Number(await renderer.getAttribute('data-living-presentation-time-seconds')) -
    Number(await renderer.getAttribute('data-demo-clock-anchor-seconds')))).toBeLessThan(0.05);
}

test('live motion and settled pause evidence', async ({ page, qa }) => {
  await openDemo(page);
  await waitForRealWorld(page);
  const renderer = page.getByTestId('world-canvas');
  const motionStart = {
    at: Date.now(), candidates: (await candidates(page)).filter(item => item.kind !== 'building'),
    frames: Number(await renderer.getAttribute('data-deck-rendered-frames')),
    mapFrames: Number(await renderer.getAttribute('data-rendered-frames')),
    positionHash: await renderer.getAttribute('data-living-position-hash'),
  };
  let motionEnd = motionStart;
  await expect.poll(async () => {
    motionEnd = {
      at: Date.now(), candidates: (await candidates(page)).filter(item => item.kind !== 'building'),
      frames: Number(await renderer.getAttribute('data-deck-rendered-frames')),
      mapFrames: Number(await renderer.getAttribute('data-rendered-frames')),
      positionHash: await renderer.getAttribute('data-living-position-hash'),
    };
    const moved = motionStart.candidates.some(before => motionEnd.candidates.some(after =>
      before.id === after.id && Math.hypot(after.x - before.x, after.y - before.y) > 0.1));
    return motionEnd.at - motionStart.at >= 2_000 && motionEnd.frames > motionStart.frames && moved;
  }, { timeout: 12_000, intervals: [250, 500, 1_000] }).toBe(true);
  const timingAttributes = await renderer.evaluate(element => Object.fromEntries([
    'data-frame-time-median-ms', 'data-frame-time-p95-ms',
    'data-render-interval-time-median-ms', 'data-render-interval-time-p95-ms',
  ].map(name => [name, element.getAttribute(name)])));
  const elapsedSeconds = (motionEnd.at - motionStart.at) / 1_000;
  await qa.record('motion-evidence', { classification: 'contaminated_diagnostic',
    performanceReleaseClaim: false, observationSeconds: elapsedSeconds,
    approximateMapRenderEventsPerSecond: (motionEnd.mapFrames - motionStart.mapFrames) / elapsedSeconds,
    approximateDeckRenderCallbacksPerSecond: (motionEnd.frames - motionStart.frames) / elapsedSeconds,
    timingAttributes, start: motionStart, end: motionEnd });
  await qa.capture('01-moving-world');

  await pauseAtSettledPose(page);
  const pausedStart = { candidates: await candidates(page), frames: await renderer.getAttribute('data-deck-rendered-frames'),
    presentationSeconds: await renderer.getAttribute('data-living-presentation-time-seconds') };
  // This is an explicit observation interval for paused stability, not a
  // readiness delay. No clock or input is replaced and no performance claim is made.
  await page.waitForTimeout(2_000);
  const pausedEnd = { candidates: await candidates(page), frames: await renderer.getAttribute('data-deck-rendered-frames'),
    presentationSeconds: await renderer.getAttribute('data-living-presentation-time-seconds') };
  await qa.record('paused-evidence', { classification: 'contaminated_diagnostic', observationMs: 2_000,
    renderedFrameDelta: Number(pausedEnd.frames) - Number(pausedStart.frames), start: pausedStart, end: pausedEnd });
  expect(Number(pausedEnd.frames) - Number(pausedStart.frames), 'Settled pause must not keep drawing').toBeLessThanOrEqual(2);
  expect(pausedEnd.presentationSeconds).toBe(pausedStart.presentationSeconds);
  const persistentActors = pausedStart.candidates.filter(before => before.kind !== 'building' &&
    pausedEnd.candidates.some(after => after.id === before.id));
  expect(persistentActors.length).toBeGreaterThan(0);
  for (const before of persistentActors) {
    const after = pausedEnd.candidates.find(item => item.id === before.id)!;
    expect(Math.hypot(after.x - before.x, after.y - before.y), `Paused actor ${before.id}`).toBeLessThan(0.5);
  }
  await qa.assertHealthy();
});

test('real canvas picking, pan and 2D controls', async ({ page, qa }) => {
  await openDemo(page);
  await waitForRealWorld(page);
  const renderer = page.getByTestId('world-canvas');
  const initialCamera = Object.fromEntries(['lon', 'lat', 'zoom', 'pitch'].map(key => [key, Number(contextInUrl(page).get(key))]));

  // Stop through the ordinary UI before choosing actual render projections.
  // This prevents a moving vehicle from leaving its recorded pixel between
  // telemetry sampling and native input; native hit/identity gates stay exact.
  await pauseAtSettledPose(page);
  await qa.record('picking-settled-pose', {
    paused: await renderer.getAttribute('data-demo-clock-paused'),
    presentationSeconds: await renderer.getAttribute('data-living-presentation-time-seconds'),
    anchorSeconds: await renderer.getAttribute('data-demo-clock-anchor-seconds'),
  });

  for (const kind of ['person', 'vehicle', 'building'] as const) {
    await expect.poll(async () => Boolean(await visibleCandidate(page, kind)), { timeout: 20_000 }).toBe(true);
    const candidate = (await visibleCandidate(page, kind))!;
    await qa.record(`pick-${kind}-input`, candidate);
    const attemptsBefore = Number(await renderer.getAttribute('data-deck-click-pick-attempts'));
    await page.mouse.click(candidate.pageX, candidate.pageY);
    let nativeId = candidate.id;
    if (kind !== 'building') {
      await expect.poll(async () => Number(await renderer.getAttribute('data-deck-click-pick-attempts'))).toBeGreaterThan(attemptsBefore);
      await expect(renderer).toHaveAttribute('data-deck-click-pick-status', 'hit');
      await expect(renderer).toHaveAttribute('data-deck-click-pick-errors', '0');
      nativeId = (await renderer.getAttribute('data-deck-click-pick-logical-id'))!;
      expect(nativeId).toMatch(kind === 'person' ? /^demo-p-/ : /^demo-v-/);
    }
    // Projection is a visible click hint, not an occlusion/picking oracle.
    // A crowded pixel may pick another foreground sprite. Verify the actual
    // native Deck hit is the identity that the application inspector opens.
    await expect.poll(() => contextInUrl(page).get('selected')).toBe(`${kind}:${nativeId}`);
    await qa.record(`pick-${kind}-result`, { projectedHintId: candidate.id, nativeId,
      selected: contextInUrl(page).get('selected'), overlappingHint: candidate.id !== nativeId });
    const inspector = page.getByTestId('selection-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText(kind === 'person' ? 'Профиль жителя' : kind === 'vehicle' ? 'Пассажиры автомобиля' : 'Жизнь здания');
    await qa.capture(`02-picked-${kind}`);
    await page.getByRole('button', { name: 'Закрыть профиль', exact: true }).click();
    await expect(inspector).toHaveCount(0);
  }

  const box = (await page.locator('canvas').boundingBox())!;
  const beforePan = { lon: Number(contextInUrl(page).get('lon')), lat: Number(contextInUrl(page).get('lat')) };
  const panStart = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.4 };
  const hitTag = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, panStart);
  await qa.record('pan-input', { box, panStart, hitTag, beforePan });
  expect(hitTag).toBe('CANVAS');
  await page.mouse.move(panStart.x, panStart.y);
  await page.mouse.down();
  // Pace actual input events across render frames, as a human drag does.
  // An entire press/move/release within one frame is not a meaningful pan.
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(panStart.x + step * 15, panStart.y + step * 3.75);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await expect.poll(() => Math.abs(Number(contextInUrl(page).get('lon')) - beforePan.lon) +
    Math.abs(Number(contextInUrl(page).get('lat')) - beforePan.lat)).toBeGreaterThan(0.00001);
  const beforeZoom = Number(contextInUrl(page).get('zoom'));
  await page.mouse.wheel(0, -240);
  await expect.poll(() => Number(contextInUrl(page).get('zoom'))).toBeGreaterThan(beforeZoom);
  await page.getByRole('button', { name: 'Переключить 2D и 3D', exact: true }).click();
  await expect(renderer).toHaveAttribute('data-scene-mode', '2d');
  await expect.poll(() => Number(contextInUrl(page).get('pitch'))).toBeCloseTo(0, 6);
  await expect(renderer).toHaveAttribute('data-camera-settled', 'true');
  await qa.capture('03-panned-2d');
  const before3dRevision = Number(await renderer.getAttribute('data-telemetry-flush-revision'));
  await page.getByRole('button', { name: 'Переключить 2D и 3D', exact: true }).click();
  await expect(renderer).toHaveAttribute('data-scene-mode', '3d');
  // Sequence completed user actions, not overlapping controlled-camera
  // transitions. The rapid toggle+reset race remains a separate diagnosis.
  // Native settled telemetry compares actual/target pitch (within 0.2 degrees),
  // as well as center, zoom and bearing; pitch itself is not exported in data-*.
  await expect.poll(() => Number(contextInUrl(page).get('pitch'))).toBeCloseTo(55, 2);
  await expect.poll(async () => Number(await renderer.getAttribute('data-telemetry-flush-revision'))).toBeGreaterThan(before3dRevision);
  await expect(renderer).toHaveAttribute('data-camera-settled', 'true');
  await qa.record('camera-before-center', { context: Object.fromEntries(contextInUrl(page)),
    targetPitch: contextInUrl(page).get('pitch'),
    settled: await renderer.getAttribute('data-camera-settled') });
  await page.getByRole('button', { name: 'Центр Челябинска', exact: true }).click();
  for (const [key, value] of Object.entries(initialCamera)) {
    await expect.poll(() => Number(contextInUrl(page).get(key))).toBeCloseTo(value, 4);
  }
  await expect.poll(async () => Number(await renderer.getAttribute('data-camera-zoom'))).toBeCloseTo(initialCamera.zoom, 2);
  await waitForRealWorld(page);
  await qa.capture('04-restored-3d');
  await qa.assertHealthy();
});
