import { test, expect, navigate, waitForRealWorld, expectNoHorizontalOverflow, contextInUrl } from './qa';

test('mobile city-scale building, roster and analytics preserve the same population', async ({page,qa}) => {
  const entry='./#/world?dataset=omnitwin-fictional-city-v2&scenario=baseline&year=2026&territory=RU-CHE-SET&minutes=690&paused=1&speed=1&weather=clear&lon=61.40520435&lat=55.164788&zoom=17.3&pitch=25&bearing=-24&stats=fictional';
  await page.goto(entry);
  await expect(page.getByTestId('demo-city')).toHaveAttribute('data-population-state','ready',{timeout:60000});
  await waitForRealWorld(page);
  await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-exact-building-source-status','ready');
  await expectNoHorizontalOverflow(page);
  await qa.capture('01-mobile-city');
  const box=(await page.locator('canvas').boundingBox())!;
  // Native roof click; no selection injection or stand-in geometry.
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  const inspector=page.getByTestId('selection-inspector');
  await expect(inspector).toContainText('ТРК «Куба»');
  await expect.poll(async()=>Number((await page.getByTestId('building-present-now').innerText()).replace(/\s/g,''))).toBe(1621);
  await expect(inspector.locator('.roster-row')).toHaveCount(50);
  await expectNoHorizontalOverflow(page);
  await qa.capture('02-mobile-building');
  await inspector.getByRole('button',{name:'Следующая страница жителей здания'}).click();
  await expect(inspector.locator('.roster-row').first()).toHaveAttribute('data-person-id','demo2-p-0054660');
  await inspector.locator('.roster-row').first().click();
  await expect(inspector).toContainText('Наталья Волкова');
  await expectNoHorizontalOverflow(page);
  await qa.capture('03-mobile-resident');
  await page.getByRole('button',{name:'Закрыть профиль',exact:true}).click();
  await navigate(page,'Аналитика','analytics');
  await expect(page.getByTestId('demo-analytics')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(contextInUrl(page).get('dataset')).toBe('omnitwin-fictional-city-v2');
  await expectNoHorizontalOverflow(page);
  await qa.capture('04-mobile-analytics');
  await page.goBack();
  await waitForRealWorld(page);
  await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-material-atlas-ready','true');
  await qa.capture('05-mobile-back');
  await qa.assertHealthy();
});
