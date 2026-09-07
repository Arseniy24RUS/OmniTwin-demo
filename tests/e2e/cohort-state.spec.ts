import { test, expect, openDemo, navigate, contextInUrl, waitForRealWorld } from './qa';

test('female 18–34 analytics and query pagination comparison URL persistence', async ({ page, qa }) => {
  await openDemo(page);
  await navigate(page, 'Агенты', 'agents');
  const agents = page.getByTestId('agents-view');
  await expect(agents).toBeVisible();
  await page.getByRole('combobox', { name: 'Пол жителя', exact: true }).selectOption('female');
  await page.getByRole('combobox', { name: 'Возрастная группа', exact: true }).selectOption('18-34');
  await expect(agents).toContainText(/707\s+вымышленных жителей/);
  await page.getByRole('button', { name: 'Следующие', exact: true }).click();
  await expect.poll(() => contextInUrl(page).get('offset')).toBe('50');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(agents).toBeVisible();
  await expect(agents).toContainText(/51–100\s+из\s+707/);
  const observedName = (await page.getByRole('button', { name: /^Открыть профиль / }).first().getAttribute('aria-label'))!
    .replace('Открыть профиль ', '');
  const search = page.getByRole('textbox', { name: 'Поиск жителя', exact: true });
  await search.fill(observedName);
  await expect.poll(() => contextInUrl(page).get('q')).toBe(observedName);
  await expect.poll(() => contextInUrl(page).get('offset')).toBe('0');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(search).toHaveValue(observedName);
  await expect(page.getByRole('button', { name: `Открыть профиль ${observedName}`, exact: true }).first()).toBeVisible();
  await qa.capture('01-query-restored');
  await search.fill('');

  await navigate(page, 'Аналитика', 'analytics');
  await expect(page.getByTestId('analytics-cohort-scope')).toContainText('18-34');
  await expect(page.getByTestId('analytics-cohort-scope')).toContainText('женщины');
  await expect(page.getByTestId('analytics-population')).toHaveText(/707\s*человек в группе/);
  await expect(page.locator('canvas')).toHaveCount(0);
  const populationRows = page.getByTestId('analytics-canonical-table').locator('tbody tr')
    .filter({ has: page.getByRole('cell', { name: 'Население', exact: true }) });
  await expect(populationRows).toHaveCount(1);
  await expect(populationRows).toContainText('707');
  await expect(populationRows).toContainText('18-34 · женщины');
  await qa.capture('02-analytics-female-18-34-707');

  await navigate(page, 'Живой мир', 'world');
  await waitForRealWorld(page);
  await expect(page.getByTestId('population-value')).toHaveText('707');
  await qa.capture('02-world-same-female-18-34-707');

  await navigate(page, 'Сценарии', 'scenarios');
  await page.getByRole('combobox', { name: 'Демографический год', exact: true }).selectOption('2031');
  await page.getByRole('combobox', { name: 'Сценарий A', exact: true }).selectOption('inflow');
  await page.getByRole('combobox', { name: 'Сценарий B', exact: true }).selectOption('ageing');
  await expect.poll(() => contextInUrl(page).get('compare')).toBe('inflow');
  await expect.poll(() => contextInUrl(page).get('scenario')).toBe('ageing');
  const delta = await page.getByTestId('scenario-population-delta').innerText();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('combobox', { name: 'Сценарий A', exact: true })).toHaveValue('inflow');
  await expect(page.getByRole('combobox', { name: 'Сценарий B', exact: true })).toHaveValue('ageing');
  await expect(page.getByTestId('scenario-population-delta')).toHaveText(delta);
  expect(contextInUrl(page).get('sex')).toBe('female');
  expect(contextInUrl(page).get('age')).toBe('18-34');
  await qa.capture('03-comparison-restored');
  await qa.assertHealthy();
});
