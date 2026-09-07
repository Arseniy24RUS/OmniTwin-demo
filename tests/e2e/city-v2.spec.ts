import { test, expect, waitForRealWorld } from './qa';

const pose = (lon: number, lat: number, zoom = 16.7, minutes = 600) =>
  `./#/world?dataset=omnitwin-fictional-city-v2&scenario=baseline&year=2026&territory=RU-CHE-SET&minutes=${minutes}&paused=1&speed=1&weather=clear&lon=${lon}&lat=${lat}&zoom=${zoom}&pitch=55&bearing=-24&stats=fictional`;

test('city-scale population and seven source-backed districts', async ({ page, qa }) => {
  const places = [
    ['central', 61.38095385, 55.1534854], ['kurchatovsky', 61.28152095, 55.1944611],
    ['kalininsky', 61.31152645, 55.1726644], ['metallurgichesky', 61.3834548, 55.23646805],
    ['sovetsky', 61.4033715, 55.14889385], ['traktorozavodsky', 61.4528006, 55.1728529],
    ['leninsky', 61.42775195, 55.1430109],
  ] as const;
  for (const [name, lon, lat] of places) {
    await page.goto(pose(lon, lat));
    const city = page.getByTestId('demo-city');
    await expect(city).toHaveAttribute('data-population-state', /^(ready|error)$/, { timeout: 30000 });
    expect(await city.getAttribute('data-population-error'), 'No hidden city data failure').toBe('');
    await expect(city).toHaveAttribute('data-population-state', 'ready');
    await waitForRealWorld(page);
    await expect(page.getByTestId('population-value')).toHaveText('1 177 058');
    await qa.capture(`district-${name}`);
  }
  await page.goto(pose(61.405, 55.16, 14.8, 1140));
  const world = page.getByTestId('world-canvas');
  await expect(page.getByTestId('demo-city')).toHaveAttribute('data-population-state', 'ready', { timeout: 60000 });
  await expect.poll(async () => Number(await world.getAttribute('data-deck-aggregate-road-flows'))).toBeGreaterThan(0);
  await expect(page.locator('canvas')).toHaveCount(1);
  await page.getByRole('button', { name: 'Запустить движение', exact: true }).click();
  await page.waitForTimeout(2200);
  await qa.capture('general-plan-moving-flows');
  await page.getByRole('button', { name: 'Приостановить движение', exact: true }).click();
  await qa.assertHealthy();
  expect(qa.network.some(row => /\/demo\/(?:dataset|chat-profiles)\.json$/.test(new URL(row.url).pathname)), 'No legacy full population download in V2').toBe(false);
});
