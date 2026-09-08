import { test, expect, waitForRealWorld, navigate } from './qa';

test('textured city survives analytics, Browser Back and reload', async ({page,qa},info)=>{
  test.skip(info.project.name!=='desktop-1920x1080','Mid/high facade reconciliation; low-tier mobile intentionally uses solid buildings.');
  const entry='./#/world?dataset=omnitwin-public-fictional-chelyabinsk-v1&scenario=baseline&year=2026&territory=RU-CHE-SET&minutes=690&paused=1&speed=1&weather=clear&lon=61.4026&lat=55.1684&zoom=16.7&pitch=58&bearing=-24&stats=observed&observedYear=2024';
  const ready=async()=>{
    await waitForRealWorld(page);
    const world=page.getByTestId('world-canvas');
    await expect(world).toHaveAttribute('data-material-atlas-ready','true');
    await expect(world).toHaveAttribute('data-map-tiles-loaded','true');
    await expect(world).toHaveAttribute('data-map-idle','true');
    await expect.poll(async()=>{
      const layers=JSON.parse(await world.getAttribute('data-demo-building-layers')??'[]') as Array<{id:string;minzoom?:number;maxzoom?:number;layout?:{visibility?:string}}>;
      const facade=layers.find(layer=>layer.id==='omnitwin-building-facade-3d');
      const solid=layers.find(layer=>layer.id==='building-3d');
      return facade?.layout?.visibility!=='none'&&typeof facade?.minzoom==='number'&&facade.minzoom<=16.7&&solid?.maxzoom===facade.minzoom;
    },{timeout:15000}).toBe(true);
  };
  await page.goto(entry);
  await ready();
  await qa.capture('01-initial-textured-city');
  await navigate(page,'Аналитика','analytics');
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.goBack();
  await ready();
  await qa.capture('02-browser-back-textured-city');
  await page.reload({waitUntil:'domcontentloaded'});
  await ready();
  await qa.capture('03-reload-textured-city');
  await qa.assertHealthy();
});

test('far firefly opens the actual resident through native GPU picking', async ({ page, qa }) => {
  // Keep an exposed path inside the narrow portrait viewport. At lon61.405
  // its candidate people are legitimately hidden behind the foreground block.
  const portrait = (page.viewportSize()?.width ?? 1920) < 600;
  const longitude = portrait ? 61.403 : 61.405;
  const pitch = portrait ? 25 : 55;
  await page.goto(`./#/world?dataset=omnitwin-public-fictional-chelyabinsk-v1&scenario=baseline&year=2026&territory=RU-CHE-SET&minutes=690&paused=1&speed=1&weather=clear&lon=${longitude}&lat=55.16&zoom=15.5&pitch=${pitch}&bearing=-24&stats=observed&observedYear=2024`);
  await waitForRealWorld(page);
  const world = page.getByTestId('world-canvas');
  const box = (await page.locator('canvas').boundingBox())!;
  const hints = JSON.parse(await world.getAttribute('data-demo-actor-pick-candidates') ?? '[]') as Array<{
    id: string; kind: string; x: number; y: number; impostorMix?: number;
  }>;
  const attempts: unknown[] = [];
  let nativeId: string | null = null;
  await qa.capture('01-far-before-picking');
  // Hints locate real projected actors but do not prove they are unobscured.
  // Try a bounded set of actual clicks; never bypass the native depth gate.
  for (const hint of hints.filter(item => item.kind === 'person' && (item.impostorMix ?? 0) > 0.5)) {
    const x = box.x + hint.x; const y = box.y + hint.y;
    if (!await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', { x, y })) continue;
    const beforeAttempt = Number(await world.getAttribute('data-deck-click-pick-attempts'));
    await page.mouse.click(x, y);
    // MapLibre defers single clicks while distinguishing double-click zoom.
    // Wait for this click's native result instead of reading the previous one.
    await expect.poll(async () => Number(await world.getAttribute('data-deck-click-pick-attempts')), { timeout: 2000 }).toBeGreaterThan(beforeAttempt);
    const status = await world.getAttribute('data-deck-click-pick-status');
    const id = await world.getAttribute('data-deck-click-pick-logical-id');
    attempts.push({ hint, status, id });
    if (status === 'hit' && id?.startsWith('demo-p-')) { nativeId = id; break; }
    const close = page.getByRole('button', { name: 'Закрыть профиль', exact: true });
    if (await close.isVisible()) await close.click();
  }
  await qa.record('native-firefly-picking', { attempts, nativeId });
  expect(nativeId, 'At least one exposed far firefly must be selectable').not.toBeNull();
  await expect.poll(() => new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('selected')).toBe(`person:${nativeId}`);
  await expect(page.getByTestId('selection-inspector')).toContainText('Профиль жителя');
  await qa.capture('02-far-resident-profile');
  await page.getByRole('button', { name: 'Показать на карте', exact: true }).click();
  await expect(world).toHaveAttribute('data-camera-settled', 'true');
  await expect.poll(async () => Number(await world.getAttribute('data-camera-zoom'))).toBeGreaterThan(17);
  await expect.poll(async () => {
    const hints = JSON.parse(await world.getAttribute('data-demo-actor-pick-candidates') ?? '[]') as Array<{ id: string; impostorMix?: number }>;
    return hints.find(hint => hint.id === nativeId)?.impostorMix;
  }).toBe(0);
  if (portrait) {
    await expect(page.locator('.detail-panel')).not.toHaveClass(/expanded/);
    // The bottom sheet animates independently of MapLibre's settled camera.
    // Do not accept a screenshot with the actor still covered by that sheet.
    await expect.poll(async () => (await page.locator('.detail-panel').boundingBox())?.height).toBe(196);
  }
  await qa.capture('03-same-resident-near-without-glow');
  expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('selected')).toBe(`person:${nativeId}`);
  await qa.assertHealthy();
});

test('firefly LOD and materials survive real camera interaction', async ({ page, qa }) => {
  await page.goto('./#/world?dataset=omnitwin-public-fictional-chelyabinsk-v1&scenario=baseline&year=2026&territory=RU-CHE-SET&minutes=690&paused=1&speed=1&weather=clear&lon=61.405&lat=55.16&zoom=15.5&pitch=55&bearing=-24&stats=observed&observedYear=2024');
  await waitForRealWorld(page);
  const world = page.getByTestId('world-canvas');
  await expect(world).toHaveAttribute('data-camera-zoom', '15.500');
  await qa.capture('01-far-fireflies');
  const canvas = page.locator('canvas'); const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.4);
  for (let step = 0; step < 3; step++) { await page.mouse.wheel(0, -650); await page.waitForTimeout(700); }
  await expect.poll(async () => Number(await world.getAttribute('data-camera-zoom'))).toBeGreaterThan(17);
  await expect(world).toHaveAttribute('data-camera-settled', 'true');
  await qa.capture('02-near-physical-people');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'right' });
  for (let step = 1; step <= 8; step++) await page.mouse.move(box.x + box.width * 0.5 + step * 12, box.y + box.height * 0.5 - step * 2, { steps: 2 });
  await qa.capture('03-camera-rotation-held');
  await page.mouse.up({ button: 'right' });
  await expect(world).toHaveAttribute('data-camera-settled', 'true');
  await qa.capture('04-after-rotation');
  // Camera motion ends before the newly exposed real vector tiles finish.
  // Wait for an actual quiet window, not merely for the mouseup event.
  await expect(world).toHaveAttribute('data-map-tiles-loaded', 'true');
  await expect(world).toHaveAttribute('data-map-idle', 'true');
  await expect.poll(async () => {
    const start = Number(await world.getAttribute('data-map-render-revision'));
    await page.waitForTimeout(800);
    return Number(await world.getAttribute('data-map-render-revision')) - start;
  }, { timeout: 20000 }).toBeLessThanOrEqual(1);
  const pausedFrames = Number(await world.getAttribute('data-map-render-revision'));
  await page.waitForTimeout(2200);
  const afterPause = Number(await world.getAttribute('data-map-render-revision'));
  await qa.record('paused-service-frames', { frames: afterPause - pausedFrames, windowMs: 2200 });
  expect(afterPause - pausedFrames).toBeLessThanOrEqual(2);
  await page.getByRole('button', { name: 'Запустить движение', exact: true }).click();
  const before = await world.getAttribute('data-living-position-hash');
  await expect.poll(() => world.getAttribute('data-living-position-hash')).not.toBe(before);
  await page.waitForTimeout(2000);
  await qa.capture('05-moving-world');
  await page.getByRole('button', { name: 'Приостановить движение', exact: true }).click();
  await qa.assertHealthy();
});
