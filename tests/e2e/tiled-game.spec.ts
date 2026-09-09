import {test,expect,waitForRealWorld} from './qa';

const pose='./#/world?graphics=tiled_game&dataset=omnitwin-fictional-city-v2&scenario=baseline&year=2026&territory=RU-CHE-SET&minutes=690&paused=1&speed=1&weather=clear&lon=61.39466&lat=55.1654&zoom=18&pitch=55&bearing=-70&stats=observed';
test('streamed quarter, courtyard and motion remain real and depth-correct',async({page,qa})=>{
  await page.goto(pose.replace('graphics=tiled_game','graphics=native_map'));
  await waitForRealWorld(page);
  await expect(page.getByTestId('world-canvas')).toHaveAttribute('data-map-tiles-loaded','true');
  await qa.capture('00-native-before-same-camera');
  await page.goto(pose);
  const world=page.getByTestId('world-canvas');
  await expect(world).toHaveAttribute('data-city-graphics','tiled_game');
  await expect.poll(async()=>{
    const d=JSON.parse(await world.getAttribute('data-game-diagnostics')??'{}');
    return d.visible&&d.actorsState==='ready'&&!d.loading&&d.renderedVisibleTiles>0;
  },{timeout:60000}).toBe(true);
  await expect(page.getByTestId('demo-city')).toHaveAttribute('data-population-state','ready',{timeout:60000});
  // Same-document native→game navigation must reload the mode-specific provider.
  await expect(page.getByText('Маршруты квартала · локальная проверка',{exact:true})).toBeVisible();
  await expect.poll(async()=>JSON.parse(await world.getAttribute('data-game-sidewalk-preview')??'{}').guardReady).toBe(true);
  expect(JSON.parse(await world.getAttribute('data-game-sidewalk-preview')??'{}').uncheckedActors).toBe(0);
  await expect(page.locator('canvas')).toHaveCount(1);
  await qa.capture('01-quarter');
  const box=(await page.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x+box.width*.40,box.y+box.height*.55);
  await page.mouse.wheel(0,-460);
  await page.waitForTimeout(1800);
  await qa.capture('02-courtyard');
  await page.mouse.move(box.x+box.width*.5,box.y+box.height*.50);
  await page.mouse.down({button:'right'});
  await page.mouse.move(box.x+box.width*.5+95,box.y+box.height*.50-12,{steps:12});
  await qa.capture('03-during-right-drag');
  await page.mouse.up({button:'right'});
  await page.waitForTimeout(700);
  await qa.capture('04-after-right-drag');
  await expect(world).toHaveAttribute('data-game-visible','true');
  // Real rendered MapLibre frames, not a separate RAF counter or desired target FPS.
  await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(2000);
  const times=await page.evaluate(async()=>{
    const el=document.querySelector('[data-testid="world-canvas"]')!;
    const timestamps:number[]=[];
    const observer=new MutationObserver(()=>timestamps.push(performance.now()));
    observer.observe(el,{attributes:true,attributeFilter:['data-game-frames']});
    await new Promise(resolve=>setTimeout(resolve,5000));observer.disconnect();return timestamps;
  });
  await page.getByTestId('play-toggle').click();
  const intervals=times.slice(1).map((t,i)=>t-times[i]!);const sorted=[...intervals].sort((a,b)=>a-b);
  const quantile=(p:number)=>sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))]??Infinity;
  let slowRun=0,longestSlowRunMs=0;
  for(const interval of intervals){slowRun=interval>33.4?slowRun+interval:0;longestSlowRunMs=Math.max(longestSlowRunMs,slowRun);}
  const perf={classification:'contaminated_diagnostic',samples:times.length,
    fps:(times.length-1)*1000/(times.at(-1)!-times[0]!),medianFps:1000/quantile(.5),p95Ms:quantile(.95),p99Ms:quantile(.99),longestSlowRunMs};
  await qa.record('actual-motion-performance',perf);
  await page.waitForTimeout(1200);
  const start=Number(await world.getAttribute('data-game-frames'));await page.waitForTimeout(2100);
  const paused=Number(await world.getAttribute('data-game-frames'))-start;
  await qa.record('event-driven-pause',{frames:paused,windowMs:2100});
  await qa.capture('05-after-motion-paused');
  expect(paused).toBeLessThanOrEqual(2);
  const before=page.url();await page.reload();
  await expect(world).toHaveAttribute('data-game-visible','true',{timeout:60000});
  await expect.poll(async()=>JSON.parse(await world.getAttribute('data-game-diagnostics')??'{}').loading).toBe(false);
  // Geometry readiness alone is not a stable living-city reload: population
  // chunks can still be preparing while every building is already visible.
  await expect(page.getByTestId('demo-city')).toHaveAttribute('data-population-state','ready',{timeout:60000});
  await expect.poll(async()=>Number(await world.getAttribute('data-deck-pedestrians')),{timeout:60000}).toBeGreaterThan(0);
  await expect.poll(async()=>JSON.parse(await world.getAttribute('data-game-diagnostics')??'{}').actorsState).toBe('ready');
  await qa.capture('06-reload');
  expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('graphics')).toBe('tiled_game');
  await qa.record('reload-context',{before,after:page.url()});
  await qa.assertHealthy();
  expect(qa.console.filter(e=>/GL_INVALID|WebGL.*lost|shader error|VALIDATE_STATUS/i.test(e.text))).toEqual([]);
  expect(perf.medianFps).toBeGreaterThanOrEqual(30);
  expect(perf.p95Ms).toBeLessThanOrEqual(33.4);
  expect(perf.p99Ms).toBeLessThanOrEqual(50);
  expect(perf.longestSlowRunMs).toBeLessThanOrEqual(500);
});

test('real mobile layout preserves a single game canvas and analytics navigation',async({page,qa})=>{
  // Layout only: this is not a claim about real-phone GPU performance.
  await page.setViewportSize({width:390,height:844});
  await page.goto(pose);
  const world=page.getByTestId('world-canvas');
  await expect(world).toHaveAttribute('data-game-visible','true',{timeout:60000});
  await expect.poll(async()=>JSON.parse(await world.getAttribute('data-game-diagnostics')??'{}').loading).toBe(false);
  await expect(page.getByTestId('demo-city')).toHaveAttribute('data-population-state','ready',{timeout:60000});
  await expect(page.locator('canvas')).toHaveCount(1);
  await qa.capture('mobile-quarter');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await qa.record('device-scope',{realPhone:false,layoutEmulation:true,performanceClaim:false});
  await qa.assertHealthy();
});

test.describe('recorded overview-to-courtyard movement',()=>{
  test('overview flows survive real wheel approach and 16x playback',async({page,qa})=>{
    await page.goto(pose.replace('zoom=18','zoom=14.3'));
    const world=page.getByTestId('world-canvas');
    await expect(world).toHaveAttribute('data-game-map-mode','native_basemap',{timeout:60000});
    await expect.poll(async()=>Number(await world.getAttribute('data-deck-aggregate-road-flows')),{timeout:60000}).toBeGreaterThan(256);
    await expect(world).toHaveAttribute('data-map-tiles-loaded','true');
    await expect(page.getByText('Общий план · базовая карта',{exact:true})).toBeVisible();
    await page.waitForTimeout(500);
    await qa.capture('07-overview-source-flows');
    const box=(await page.locator('canvas').boundingBox())!;
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    for(let n=0;n<7;n++){
      const z=Number(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('zoom'));
      if(z>=18.2)break;
      await page.mouse.wheel(0,-450);await page.waitForTimeout(750);
    }
    await expect(world).toHaveAttribute('data-game-visible','true',{timeout:30000});
    await expect(page.getByTestId('demo-city')).toHaveAttribute('data-population-state','ready',{timeout:30000});
    await page.getByRole('combobox',{name:'Скорость движения',exact:true}).selectOption('16');
    await page.getByTestId('play-toggle').click();
    await page.waitForTimeout(6000);
    await page.getByTestId('play-toggle').click();
    await expect.poll(async()=>Number(await world.getAttribute('data-deck-pedestrians'))).toBeGreaterThan(0);
    await qa.capture('08-after-16x');
    await qa.record('recording',{enabled:process.env.OMNITWIN_DEMO_QA_VIDEO==='1',kind:'actual Playwright WebM',size:'1280x720',performanceClaim:false,realWheel:true});
    await qa.assertHealthy();
  });
});
