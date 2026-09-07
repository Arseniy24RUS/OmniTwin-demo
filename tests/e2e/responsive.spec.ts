import { test, expect, openDemo, navigate, waitForRealWorld,
  expectNoHorizontalOverflow, contextInUrl, assertScriptedChatOnly } from './qa';

// Real mobile Chromium rendering, not screenshots of a resized desktop image.
test('responsive navigation, shared context and world controls', async ({ page, qa }) => {
  await openDemo(page);
  await waitForRealWorld(page);
  await expectNoHorizontalOverflow(page);
  await qa.capture('01-world');

  const pause = page.getByRole('button', { name: 'Приостановить движение', exact: true });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect(page.getByRole('button', { name: 'Запустить движение', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Переключить 2D и 3D', exact: true }).click();
  await expect.poll(() => Number(contextInUrl(page).get('pitch'))).toBeCloseTo(0, 6);
  await page.getByRole('button', { name: 'Переключить 2D и 3D', exact: true }).click();
  await expect.poll(() => Number(contextInUrl(page).get('pitch'))).toBeCloseTo(55, 6);

  await navigate(page, 'Аналитика', 'analytics');
  await expect(page.getByTestId('demo-analytics')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Демографический год', exact: true }).selectOption('2030');
  await expect(page.getByRole('combobox', { name: 'Демографический срез', exact: true })).toHaveValue('2030');
  await expectNoHorizontalOverflow(page);
  await qa.capture('02-analytics');

  await navigate(page, 'Сценарии', 'scenarios');
  await expect(page.getByTestId('demo-scenarios')).toBeVisible();
  await page.getByRole('combobox', { name: 'Сценарий B', exact: true }).selectOption('inflow');
  await expect(page.getByTestId('scenario-population-delta')).not.toHaveText(/^0\s*человек$/);
  await expectNoHorizontalOverflow(page);
  await qa.capture('03-scenarios');

  await navigate(page, 'Агенты', 'agents');
  await expect(page.getByTestId('agents-view')).toBeVisible();
  await page.getByRole('combobox', { name: 'Возрастная группа', exact: true }).selectOption('18-34');
  await page.getByRole('button', { name: /^Открыть профиль / }).first().click();
  await expect(page.getByTestId('selection-inspector')).toBeVisible();
  await expect(page.getByTestId('selection-inspector')).toContainText('01.01.2030');
  await expectNoHorizontalOverflow(page);
  await qa.capture('04-agent');
  await assertScriptedChatOnly(page);
  const chat = page.getByRole('region', { name: 'Разговор с жителем', exact: true });
  await chat.getByRole('button', { name: 'Расскажи о себе', exact: true }).click();
  await expect(chat).toContainText('демореплика');
  await expect(chat).toContainText('ИИ-сервис ещё не подключён');
  await chat.scrollIntoViewIfNeeded();
  await qa.capture('04-agent-scripted-chat');
  await page.getByRole('button', { name: 'Закрыть профиль', exact: true }).click();
  await expect(page.getByTestId('selection-inspector')).toHaveCount(0);

  await navigate(page, 'Живой мир', 'world');
  await waitForRealWorld(page);
  expect(contextInUrl(page).get('year')).toBe('2030');
  expect(contextInUrl(page).get('scenario')).toBe('inflow');
  await expectNoHorizontalOverflow(page);
  await qa.capture('05-world-return');
  await qa.assertHealthy();
});
