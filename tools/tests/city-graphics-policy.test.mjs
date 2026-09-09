import test from 'node:test';
import assert from 'node:assert/strict';
import {isSettledCityGraphics} from '../qa/city-graphics-policy.mjs';
const ready=()=>({source:12,bankState:'canonical',bankPending:false,state:'rendering',mesh:8,renderedVisibleTiles:2,
 loading:false,actorsState:'ready',actorsVisible:true,shadowReady:true,
 shaders:{pending:0,queued:0,failed:0,pendingObjects:0,environmentReady:true},
 motionWorker:{mode:'worker_buffered',displayed:true,underflow:false,error:null},
 surfaceWorker:{mode:'worker_prepared',inFlight:false,pendingKinds:[],error:null},
 surfaceRefresh:{dirty:false,failures:0}});
test('settling includes actual late surface and shader jobs, not only the tile frontier',()=>{
 assert.equal(isSettledCityGraphics(ready()),true);
 for(const patch of [{surfaceWorker:{...ready().surfaceWorker,inFlight:true}},{surfaceWorker:{...ready().surfaceWorker,pendingKinds:['roads']}},
  {shaders:{...ready().shaders,pendingObjects:1}},{shaders:{...ready().shaders,environmentReady:false}}])assert.equal(isSettledCityGraphics({...ready(),...patch}),false);
});
test('settling rejects unready worker display, context failure and missing diagnostics',()=>{
 for(const patch of [{motionWorker:{...ready().motionWorker,displayed:false}},{motionWorker:{...ready().motionWorker,error:'worker failed'}},
  {state:'context_lost'},{surfaceWorker:null},{shaders:null},{shadowReady:false},{surfaceRefresh:{dirty:true,failures:0}}])assert.equal(isSettledCityGraphics({...ready(),...patch}),false);
});
test('ready native/mesh accounting alone is insufficient to claim settled actors or worker results',()=>{
 for(const patch of [{actorsState:'loading'},{actorsVisible:false},{loading:true},{surfaceWorker:{...ready().surfaceWorker,error:'source too large'}},
  {motionWorker:{...ready().motionWorker,underflow:true}},{shaders:{...ready().shaders,failed:1}}])assert.equal(isSettledCityGraphics({...ready(),...patch}),false);
});
