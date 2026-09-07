import { test, expect, openDemo, waitForRealWorld, expectNoHorizontalOverflow } from './qa';

test('source-backed world visual evidence', async ({ page, qa }) => {
  await openDemo(page);
  await waitForRealWorld(page);
  await page.getByRole('button', { name: 'Приостановить движение', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Запустить движение', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await qa.capture('world-ready-paused');
  await qa.assertHealthy();
});
