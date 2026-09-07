import { test, expect, openDemo, navigate, navigationItem, waitForRealWorld,
  expectNoHorizontalOverflow, contextInUrl, assertScriptedChatOnly } from './qa';

// The flow under test is: real world -> analytics -> scenario comparison ->
// resident profile -> real map and labelled local chat -> Back and reload.
test('desktop connected fictional-data journey', async ({ page, qa }) => {
  await openDemo(page, './#/world?stats=fictional');
  for (const name of ['Живой мир', 'Агенты', 'Сценарии', 'Аналитика', 'О проекте']) {
    await expect(navigationItem(page, name)).toBeVisible();
  }
  await expect(page.getByTestId('population-value')).toBeVisible();
  await qa.capture('00-shell-before-tile-readiness');
  await waitForRealWorld(page);
  await expect(page.getByTestId('population-value')).toContainText(/8\s*246/);
  await expectNoHorizontalOverflow(page);
  await qa.capture('01-world');

  // Presentation controls must change presentation, not the demographic year.
  await page.getByRole('button', { name: 'Приостановить движение', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Запустить движение', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Погода', exact: true }).selectOption('rain');
  await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-environment-weather', 'rain');
  expect(contextInUrl(page).get('year')).toBe('2026');
  await page.getByRole('combobox', { name: 'Погода', exact: true }).selectOption('clear');

  await navigate(page, 'Аналитика', 'analytics');
  await expect(page.getByTestId('demo-analytics')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Аналитика населения', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Демографический год', exact: true }).selectOption('2031');
  await expect(page.getByRole('combobox', { name: 'Демографический срез', exact: true })).toHaveValue('2031');
  expect(contextInUrl(page).get('year')).toBe('2031');
  const table = page.getByTestId('analytics-canonical-table');
  await expect(table.locator('tbody tr')).not.toHaveCount(0);
  await page.getByRole('combobox', { name: 'Набор показателей', exact: true }).selectOption('events');
  await expect(table).toContainText('Рождения');
  await expect(table.getByRole('cell', { name: 'Население', exact: true })).toHaveCount(0);
  await qa.capture('02-analytics');

  await navigate(page, 'Сценарии', 'scenarios');
  await expect(page.getByTestId('demo-scenarios')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  const originalDelta = await page.getByTestId('scenario-population-delta').innerText();
  await page.getByRole('combobox', { name: 'Сценарий B', exact: true }).selectOption('ageing');
  await expect(page.getByTestId('scenario-population-delta')).not.toHaveText(originalDelta);
  await expect(page.getByRole('combobox', { name: 'Активный сценарий', exact: true })).toHaveValue('ageing');
  expect(contextInUrl(page).get('scenario')).toBe('ageing');
  expect(contextInUrl(page).get('year')).toBe('2031');
  await qa.capture('03-scenarios');

  await navigate(page, 'Агенты', 'agents');
  await expect(page.getByTestId('agents-view')).toBeVisible();
  await page.getByRole('combobox', { name: 'Пол жителя', exact: true }).selectOption('female');
  await page.getByRole('combobox', { name: 'Возрастная группа', exact: true }).selectOption('18-34');
  await page.getByRole('button', { name: /^Открыть профиль / }).first().click();
  const inspector = page.getByTestId('selection-inspector');
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText('Вымышленный житель');
  await expect(inspector).toContainText('01.01.2031');
  const personName = await inspector.getByRole('heading', { level: 2 }).innerText();
  const selection = contextInUrl(page).get('selected');
  expect(selection).toMatch(/^person:/);
  await qa.capture('04-agent');

  await inspector.getByRole('button', { name: 'Показать на карте', exact: true }).click();
  await expect.poll(() => new URL(page.url()).hash.split('?')[0]).toBe('#/world');
  await waitForRealWorld(page);
  await expect(page.getByTestId('selection-inspector').getByRole('heading', { level: 2 })).toHaveText(personName);
  expect(contextInUrl(page).get('selected')).toBe(selection);
  expect(contextInUrl(page).get('scenario')).toBe('ageing');
  expect(contextInUrl(page).get('year')).toBe('2031');
  await assertScriptedChatOnly(page);
  const chat = page.getByRole('region', { name: 'Разговор с жителем', exact: true });
  await chat.getByRole('button', { name: 'Расскажи о себе', exact: true }).click();
  await expect(chat).toContainText('демореплика');
  await expect(chat).toContainText('ИИ-сервис ещё не подключён');
  await expect(chat).toContainText('вымышленный житель');
  expect(qa.network.filter(entry => /\/(?:session|chat)$/.test(new URL(entry.url).pathname)),
    'Unconfigured chat must not make any inference/session request').toEqual([]);
  await qa.capture('05-map-scripted-chat');

  await page.goBack();
  await expect.poll(() => new URL(page.url()).hash.split('?')[0]).toBe('#/agents');
  await expect(page.getByTestId('agents-view')).toBeVisible();
  expect(contextInUrl(page).get('scenario')).toBe('ageing');
  expect(contextInUrl(page).get('year')).toBe('2031');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('agents-view')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Активный сценарий', exact: true })).toHaveValue('ageing');
  await expect(page.getByRole('combobox', { name: 'Демографический срез', exact: true })).toHaveValue('2031');
  await expect(page.getByRole('combobox', { name: 'Пол жителя', exact: true })).toHaveValue('female');
  await expect(page.getByRole('combobox', { name: 'Возрастная группа', exact: true })).toHaveValue('18-34');
  await qa.capture('06-back-reload');

  await navigate(page, 'О проекте', 'about');
  await expect(page.getByRole('heading', { name: 'Честная граница демонстрации', exact: true })).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  await qa.assertHealthy();
});
