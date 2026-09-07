import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect, openDemo, navigate, waitForRealWorld, contextInUrl, expectNoHorizontalOverflow } from './qa';

/** Observe completed layout, including the native bottom-sheet transition. */
async function stableBox(locator: Locator) {
  let previous: Awaited<ReturnType<Locator['boundingBox']>> = null;
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    const animating = await locator.evaluate(element => element.getAnimations().some(animation => animation.playState === 'running'));
    const stable = box !== null && previous !== null && !animating &&
      (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(box[key] - previous![key]) < 0.1);
    previous = box;
    return stable;
  }, { intervals: [100], timeout: 5_000 }).toBe(true);
  return previous!;
}

async function revealFullPyramid(page: Page) {
  const chart = page.getByTestId('observed-age-chart');
  // The application scrolls inside page-content; a fullPage screenshot alone
  // cannot expose the part of the chart below that scroll container's fold.
  await chart.scrollIntoViewIfNeeded();
  const box = await stableBox(chart);
  const viewport = await page.locator('.page-content').boundingBox();
  if (!viewport) throw new Error('Analytics scroll container has no box.');
  expect(box.y, 'Entire age chart must be below the fixed application header').toBeGreaterThanOrEqual(viewport.y - 1);
  expect(box.y + box.height, 'Entire chart, including the open age group, must fit in the content viewport').toBeLessThanOrEqual(viewport.y + viewport.height + 1);
  return { chart: box, contentViewport: viewport };
}

/** Read the real downloaded, quoted CSV, including doubled quotes and UTF-8 BOM. */
function csvRows(text: string): Record<string, string>[] {
  const source = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && (character === ',' || character === '\n')) {
      row.push(cell.replace(/\r$/, '')); cell = '';
      if (character === '\n') { if (row.some(Boolean)) rows.push(row); row = []; }
    } else cell += character;
  }
  if (quoted) throw new Error('Downloaded CSV has an unterminated quoted cell.');
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); if (row.some(Boolean)) rows.push(row); }
  const [header, ...data] = rows;
  if (!header?.length) throw new Error('Downloaded CSV has no header.');
  for (const values of data) expect(values.length, 'CSV column count must match its header').toBe(header.length);
  return data.map(values => Object.fromEntries(header.map((key, index) => [key, values[index]!])));
}

// Flow: default observed city -> official 2024 pyramid -> observed 2023/reload
// -> source-qualified CSV -> explicit fictional source -> native Back restores each source.
// Portrait runs the same observed entry and a shorter year/reload journey.
test('observed city reference, source switch and export persistence', async ({ page, qa }, info) => {
  const portrait = info.project.name === 'portrait-390x844';
  // Deliberately omit stats/observedYear: the product default itself is tested.
  await openDemo(page, './#/world?paused=1');
  await waitForRealWorld(page);
  await expect.poll(() => contextInUrl(page).get('stats')).toBe('observed');
  await expect.poll(() => contextInUrl(page).get('observedYear')).toBe('2024');
  expect(contextInUrl(page).get('year')).toBe('2026');
  expect(contextInUrl(page).get('paused')).toBe('1');
  await expect(page.getByRole('combobox', { name: 'Год наблюдений', exact: true })).toHaveValue('2024');
  await expect(page.getByRole('button', { name: 'Запустить движение', exact: true })).toBeVisible();
  const summary = page.getByTestId('observed-summary');
  await expect(summary).toBeVisible();
  await expect(page.getByTestId('observed-summary-population')).toHaveText(/1\s*177\s*058/);
  await expect(page.getByTestId('population-value')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  if (portrait) {
    const sheet = page.locator('.detail-panel');
    const collapsed = await stableBox(sheet);
    await qa.record('mobile-collapsed-sheet-box', collapsed);
    await qa.capture('01a-default-observed-2024-world-collapsed');
    await page.getByRole('button', { name: 'Развернуть или свернуть сводку', exact: true }).click();
    await expect(sheet).toHaveClass(/expanded/);
    const expanded = await stableBox(sheet);
    expect(expanded.height).toBeGreaterThan(collapsed.height + 100);
    await qa.record('mobile-expanded-sheet-box', expanded);
  }
  await qa.capture('01-default-observed-2024-world');

  await navigate(page, 'Аналитика', 'analytics');
  const analytics = page.getByTestId('observed-analytics');
  await expect(analytics).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(page.getByTestId('demo-analytics')).toHaveCount(0);
  await expect(page.getByTestId('observed-population')).toContainText(/1\s*177\s*058/);
  const year = page.getByRole('combobox', { name: 'Год официальной статистики', exact: true });
  await expect(year).toHaveValue('2024');
  const ages = page.getByTestId('observed-age-table');
  await expect(ages.locator('tbody tr')).toHaveCount(21);
  await expect(ages).toContainText('100+');
  await expect(page.getByTestId('observed-age-chart').getByRole('img', {
    name: 'Возрастно-половая структура на 01.01.2024', exact: true,
  })).toBeVisible();
  await expect(page.getByTestId('observed-age-chart').locator('[data-age-band] rect')).toHaveCount(40);
  await expect(page.getByTestId('observed-open-age')).toHaveText(/100\+/);
  await expect(page.getByTestId('observed-history-table')).toContainText('2023');
  await expectNoHorizontalOverflow(page);
  await qa.capture('02-observed-2024-full-pyramid');
  await qa.record('observed-2024-chart-box', await revealFullPyramid(page));
  await qa.capture('02a-observed-2024-chart-in-view');

  await year.selectOption('2023');
  await expect(page.getByTestId('observed-population')).toContainText(/1\s*182\s*517/);
  await expect.poll(() => contextInUrl(page).get('observedYear')).toBe('2023');
  await expect(page.getByRole('combobox', { name: 'Год наблюдений', exact: true })).toHaveValue('2023');
  expect(contextInUrl(page).get('year'), 'Observed year must not move the fictional demographic clock').toBe('2026');
  await expect(ages.locator('tbody tr')).toHaveCount(18);
  await expect(ages).toContainText('85+');
  await expect(page.getByTestId('observed-age-chart').locator('[data-age-band] rect')).toHaveCount(34);
  await expect(page.getByTestId('observed-open-age')).toHaveText(/85\+/);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(analytics).toBeVisible();
  await expect(year).toHaveValue('2023');
  await expect(page.getByRole('combobox', { name: 'Год наблюдений', exact: true })).toHaveValue('2023');
  await expect(page.getByTestId('observed-population')).toContainText(/1\s*182\s*517/);
  expect(contextInUrl(page).get('stats')).toBe('observed');
  expect(contextInUrl(page).get('year')).toBe('2026');
  await expectNoHorizontalOverflow(page);
  await qa.capture('03-observed-2023-restored');
  await qa.record('observed-2023-chart-box', await revealFullPyramid(page));
  await qa.capture('03a-observed-2023-restored-chart-in-view');
  if (portrait) { await qa.assertHealthy(); return; }

  const downloaded = page.waitForEvent('download');
  await page.getByTestId('observed-export').click();
  const download = await downloaded;
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  if (!path) throw new Error('The actual observed CSV download did not produce a file.');
  const rows = csvRows(await readFile(path, 'utf8'));
  expect(rows.length).toBeGreaterThan(36);
  expect(new Set(rows.map(row => row.representation))).toEqual(new Set(['observed_reference']));
  for (const row of rows) {
    expect(row.dataset_id).toBeTruthy();
    expect(row.oktmo).toBeTruthy();
    expect(row.source_ids).toBeTruthy();
    expect(row.source_urls).toMatch(/^https?:\/\//);
    expect(Number(row.year)).toBeLessThanOrEqual(2024);
    expect(row.as_of).toBe(`${row.year}-01-01`);
  }
  const totals = (asYear: string, sex: string) => rows.find(row => row.year === asYear && row.age_band === 'all' && row.sex === sex);
  const historyTotals = rows.filter(row => row.age_band === 'all' && row.sex === 'total');
  expect(historyTotals.map(row => row.year).sort()).toEqual(['2021', '2022', '2023', '2024']);
  const publishedSexTotals = rows.filter(row => row.age_band === 'all' && row.sex !== 'total');
  expect(publishedSexTotals).toHaveLength(4);
  expect(new Set(publishedSexTotals.map(row => row.year))).toEqual(new Set(['2023', '2024']));
  expect(totals('2024', 'total')?.population).toBe('1177058');
  expect(totals('2024', 'male')?.population).toBe('529412');
  expect(totals('2024', 'female')?.population).toBe('647646');
  expect(totals('2023', 'total')?.population).toBe('1182517');
  expect(totals('2023', 'male')?.population).toBe('532357');
  expect(totals('2023', 'female')?.population).toBe('650160');
  const detail = rows.filter(row => row.age_band !== 'all');
  expect(detail).toHaveLength(36); // 18 published 2023 bins, separately by sex; final bin is 85+.
  expect(new Set(detail.map(row => row.year))).toEqual(new Set(['2023']));
  expect(new Set(detail.map(row => row.age_band)).size).toBe(18);
  expect(detail.reduce((sum, row) => sum + Number(row.population), 0)).toBe(1182517);
  expect(detail.filter(row => row.sex === 'male').reduce((sum, row) => sum + Number(row.population), 0)).toBe(532357);
  expect(detail.filter(row => row.sex === 'female').reduce((sum, row) => sum + Number(row.population), 0)).toBe(650160);
  expect(rows.some(row => row.year === '2026' || row.population === '8246')).toBe(false);
  await qa.record('observed-csv-evidence', { filename: download.suggestedFilename(), rowCount: rows.length,
    selectedYear: '2023', ageRows: detail.length, rows });

  await analytics.getByRole('button', { name: 'Модельные персонажи', exact: true }).click();
  await expect(page.getByTestId('demo-analytics')).toBeVisible();
  await expect(page.getByTestId('observed-analytics')).toHaveCount(0);
  await expect.poll(() => contextInUrl(page).get('stats')).toBe('fictional');
  expect(contextInUrl(page).get('observedYear')).toBe('2023');
  await expect(page.getByTestId('analytics-population')).toContainText(/8\s*246/);
  await qa.capture('04-explicit-fictional-source');
  await navigate(page, 'Живой мир', 'world');
  await waitForRealWorld(page);
  await expect(page.getByTestId('population-value')).toHaveText(/8\s*246/);
  await expect(page.getByTestId('observed-summary')).toHaveCount(0);

  await page.goBack();
  await expect(page.getByTestId('demo-analytics')).toBeVisible();
  expect(contextInUrl(page).get('stats')).toBe('fictional');
  expect(contextInUrl(page).get('observedYear')).toBe('2023');
  await page.goBack();
  await waitForRealWorld(page);
  await expect(page.getByTestId('observed-summary-population')).toHaveText(/1\s*177\s*058/);
  expect(contextInUrl(page).get('stats')).toBe('observed');
  expect(contextInUrl(page).get('observedYear')).toBe('2024');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForRealWorld(page);
  await expect(page.getByTestId('observed-summary-population')).toHaveText(/1\s*177\s*058/);
  await qa.capture('05-back-restores-observed-source');
  await qa.assertHealthy();
});
