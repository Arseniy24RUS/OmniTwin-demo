import type { Page } from '@playwright/test';
import { test, expect, waitForRealWorld } from './qa';

const pose = (lon: number, lat: number, zoom = 16.7, minutes = 600) =>
  `./#/world?dataset=omnitwin-fictional-city-v2&scenario=baseline&year=2026&territory=RU-CHE-SET&minutes=${minutes}&paused=1&speed=1&weather=clear&lon=${lon}&lat=${lat}&zoom=${zoom}&pitch=55&bearing=-24&stats=fictional`;

async function settledCity(page: Page) {
  await expect(page.getByTestId('demo-city')).toHaveAttribute('data-population-state', 'ready', { timeout: 60000 });
  await waitForRealWorld(page);
  const world=page.getByTestId('world-canvas');
  await expect(world).toHaveAttribute('data-material-atlas-ready','true');
  await expect(world).toHaveAttribute('data-map-tiles-loaded','true');
  await expect(world).toHaveAttribute('data-map-idle','true');
}

test('city-scale people and cars have native picks and coherent passenger profiles', async ({page,qa})=>{
  await page.goto(pose(61.405,55.16,16.7,690));
  await settledCity(page);
  const world=page.getByTestId('world-canvas');
  const box=(await page.locator('canvas').boundingBox())!;
  await qa.capture('01-city-actors-before-picking');
  for(const kind of ['person','vehicle'] as const) {
    const hints=JSON.parse(await world.getAttribute('data-demo-actor-pick-candidates')??'[]') as Array<{id:string;kind:string;x:number;y:number}>;
    const attempts:unknown[]=[];let selected:string|null=null;
    for(const hint of hints.filter(item=>item.kind===kind).slice(0,32)) {
      const x=box.x+hint.x,y=box.y+hint.y;
      if(!await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.tagName==='CANVAS',{x,y}))continue;
      const prior=Number(await world.getAttribute('data-deck-click-pick-attempts'));
      await page.mouse.click(x,y);
      await expect.poll(async()=>Number(await world.getAttribute('data-deck-click-pick-attempts')),{timeout:2000}).toBeGreaterThan(prior);
      const status=await world.getAttribute('data-deck-click-pick-status');
      const id=await world.getAttribute('data-deck-click-pick-logical-id');
      attempts.push({hint,status,id});
      if(status==='hit'&&id?.startsWith(kind==='person'?'demo2-p-':'demo2-v-')){selected=id;break;}
      const close=page.getByRole('button',{name:'Закрыть профиль',exact:true});
      if(await close.isVisible())await close.click();
    }
    await qa.record(`native-${kind}-picking`,{attempts,selected});
    expect(selected,`An actually exposed ${kind} must have a native pick`).not.toBeNull();
    const inspector=page.getByTestId('selection-inspector');
    await expect(inspector).toContainText(kind==='person'?'Профиль жителя':'Пассажиры автомобиля');
    expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('selected')).toBe(`${kind}:${selected}`);
    if(kind==='person')await expect(inspector.getByRole('button',{name:'Показать на карте',exact:true})).toBeVisible();
    else {
      const passengers=inspector.locator('.roster-row');
      await expect(passengers.first()).toBeVisible();
      const seats=(await inspector.locator('.occupancy-stat strong').innerText()).split('/').map(Number);
      expect(await passengers.count()).toBe(seats[0]);
      expect(seats[0]).toBeLessThanOrEqual(seats[1]!);
    }
    await qa.capture(`02-native-${kind}-profile`);
    if(kind==='vehicle') {
      await inspector.locator('.roster-row').first().click();
      await expect(inspector).toContainText('Профиль жителя');
      await expect(inspector.locator('.presence')).toContainText(/В автомобиле|Едет|В машине/);
      await qa.capture('03-actual-passenger-profile');
    }
    await page.getByRole('button',{name:'Закрыть профиль',exact:true}).click();
  }
  await qa.assertHealthy();
});

test('city building presence has full rosters, visitors and consistent selected residents', async ({ page, qa }) => {
  const sites = [
    {name:'residential-svobody-77',lon:61.412266,lat:55.1672497,residents:2991,
      times:[{minutes:690,total:640,first:'demo2-p-0014222',second:'demo2-p-0319883'},
        {minutes:1100,total:1836,first:'demo2-p-0000824',second:'demo2-p-0022676'}]},
    {name:'mall-kuba',lon:61.40520435,lat:55.164788,residents:0,
      times:[{minutes:690,total:1621,visitors:191,first:'demo2-p-0004467',second:'demo2-p-0054660'},
        {minutes:1100,total:1608,visitors:1332,first:'demo2-p-0001699',second:'demo2-p-0065060'}]},
  ];
  for(const site of sites) for(const timing of site.times) {
    await page.goto(pose(site.lon,site.lat,17.3,timing.minutes).replace('pitch=55','pitch=35'));
    await settledCity(page);
    const canvas=page.locator('canvas');const box=(await canvas.boundingBox())!;
    // Source building center is the camera target. Selection is an actual
    // canvas click, never a synthetic selected= URL or direct runtime call.
    await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
    const inspector=page.getByTestId('selection-inspector');
    await expect(inspector).toContainText('Жизнь здания');
    await expect.poll(async()=>Number((await page.getByTestId('building-present-now').innerText()).replace(/\s/g,'')),{timeout:30000}).toBe(timing.total);
    const rows=inspector.locator('.roster-row');
    await expect(rows).toHaveCount(50);
    await expect(rows.first()).toHaveAttribute('data-person-id',timing.first);
    if('visitors' in timing) {
      const visitors=inspector.locator('dl div').filter({has:page.getByText('Посетителей сейчас',{exact:true})}).locator('dd');
      expect(Number((await visitors.innerText()).replace(/\s/g,''))).toBe(timing.visitors);
    }
    await qa.capture(`${site.name}-${timing.minutes}-presence`);
    await inspector.getByRole('button',{name:'Следующая страница жителей здания'}).click();
    await expect(rows.first()).toHaveAttribute('data-person-id',timing.second);
    expect((await page.getByTestId('building-roster-page').innerText()).replace(/\s/g,'')).toBe(`51–100из${timing.total}`);
    await qa.capture(`${site.name}-${timing.minutes}-page-two`);
    await rows.first().click();
    await expect(inspector).toContainText('Профиль жителя');
    await expect(inspector.getByRole('button',{name:'Показать на карте'})).toBeVisible();
    expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('selected')).toBe(`person:${timing.second}`);
    await expect(inspector.locator('.presence')).toContainText(site.name.startsWith('residential')?'Дома':/На работе|В гостевом посещении/);
    await qa.capture(`${site.name}-${timing.minutes}-resident`);
  }
  await qa.assertHealthy();
});

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

test('city-scale camera rotation, near LOD and playback retain materials and become idle', async ({page,qa})=>{
  await page.goto(pose(61.405,55.16,16.7,690));
  await settledCity(page);
  const world=page.getByTestId('world-canvas');
  await qa.capture('01-city-scale-before-motion');
  const box=(await page.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x+box.width*.45,box.y+box.height*.4);
  await page.mouse.wheel(0,-650);
  await expect.poll(async()=>Number(await world.getAttribute('data-camera-zoom'))).toBeGreaterThan(17);
  await expect(world).toHaveAttribute('data-camera-settled','true');
  await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);
  await page.mouse.down({button:'right'});
  for(let step=1;step<=8;step++)await page.mouse.move(box.x+box.width*.5+step*12,box.y+box.height*.5-step*2,{steps:2});
  await qa.capture('02-city-scale-right-rotation-held');
  await page.mouse.up({button:'right'});
  await settledCity(page);
  await qa.capture('03-city-scale-after-rotation');
  await page.getByRole('button',{name:'Запустить движение',exact:true}).click();
  const before=await world.getAttribute('data-living-position-hash');
  await expect.poll(()=>world.getAttribute('data-living-position-hash')).not.toBe(before);
  await page.waitForTimeout(2000);
  // Read-only renderer measurement instrumentation, never altered tiles/data/canvas.
  const measured=await page.evaluate(()=>{
    const hook=(window as unknown as {__OMNITWIN_PERFORMANCE_QA__?:{startEpoch:(name:string)=>void}}).__OMNITWIN_PERFORMANCE_QA__;
    hook?.startEpoch('actor_motion');return Boolean(hook);
  });
  await page.waitForTimeout(5000);
  if(measured)await qa.record('actor-motion-contaminated-diagnostic',await page.evaluate(()=>(window as unknown as {__OMNITWIN_PERFORMANCE_QA__:{stopEpoch:()=>unknown}}).__OMNITWIN_PERFORMANCE_QA__.stopEpoch()));
  await qa.capture('04-city-scale-actual-moving-actors');
  await page.getByRole('button',{name:'Приостановить движение',exact:true}).click();
  await expect(world).toHaveAttribute('data-map-tiles-loaded','true');
  await expect(world).toHaveAttribute('data-map-idle','true');
  await expect.poll(async()=>{
    const start=Number(await world.getAttribute('data-map-render-revision'));
    await page.waitForTimeout(800);return Number(await world.getAttribute('data-map-render-revision'))-start;
  },{timeout:20000}).toBeLessThanOrEqual(1);
  const start=Number(await world.getAttribute('data-map-render-revision'));
  await page.waitForTimeout(2200);
  const count=Number(await world.getAttribute('data-map-render-revision'))-start;
  await qa.record('city-scale-paused-service-frames',{count,windowMs:2200});
  expect(count).toBeLessThanOrEqual(2);
  await qa.assertHealthy();
});
