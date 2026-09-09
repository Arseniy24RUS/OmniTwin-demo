// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONTEXT } from './navigation';
import { movementContextKey, movementWindow } from './data/movementContinuity';
import type { MovementReadiness } from './data/CityDemoProviderV2';
import type { DemoContextV1 } from './types';
import { cityMovementHandoff, retainCityOverviewFlows, useCityMovementPreparation, type CityMovementPreparationOptions } from './useCityMovementPreparation';

afterEach(cleanup);
const context:DemoContextV1={...DEFAULT_CONTEXT,datasetId:'omnitwin-fictional-city-v2',presentationMinutes:720,playing:true,speed:16,camera:{...DEFAULT_CONTEXT.camera,zoom:17}};
function fixture(){
  let readiness:MovementReadiness={pendingGeneration:null,committed:null,lastError:null};
  const calls:Array<{context:DemoContextV1;signal?:AbortSignal;finish:()=>void;fail:()=>void}>=[];
  const provider={get movementReadiness(){return readiness;},prepareViewport:vi.fn((value:DemoContextV1,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
    const generation=calls.length+1;readiness={...readiness,pendingGeneration:generation};
    calls.push({context:value,signal,finish:()=>{readiness={pendingGeneration:null,lastError:null,committed:{generation,contextKey:movementContextKey(value),viewportRevision:null,bounds:null,status:'ready',...movementWindow(value.presentationMinutes)}};resolve();},fail:()=>reject(new Error('fixture unavailable'))});
  }))};
  const options:CityMovementPreparationOptions={provider,context,revision:'view-a',frameActorCount:2};
  return{provider,calls,options};
}
describe('serialized city movement preparation',()=>{
  it.each([4,16])('does not abort slow preparation at %sx and immediately follows an expired completion using latest time',async speed=>{
    const f=fixture();const onPrepared=vi.fn();const hook=renderHook(props=>useCityMovementPreparation(props),{initialProps:{...f.options,context:{...context,speed},onPrepared}});
    expect(f.calls).toHaveLength(1);
    for(const minutes of [720.5,721,723])hook.rerender({...f.options,context:{...context,speed,presentationMinutes:minutes},onPrepared});
    expect(f.calls).toHaveLength(1);expect(f.calls[0]!.signal?.aborted).toBe(false);
    await act(async()=>f.calls[0]!.finish());
    expect(f.calls).toHaveLength(2);expect(f.calls[1]!.context.presentationMinutes).toBe(723);
    expect(hook.result.current.resourcesReady).toBe(false);
    expect(hook.result.current.readiness?.committed?.validUntilMinutes).toBe(722);
    await act(async()=>f.calls[1]!.finish());
    expect(hook.result.current).toMatchObject({status:'ready',resourcesReady:true,detailReady:true,handoff:'detail_ready'});
    expect(onPrepared).toHaveBeenCalledTimes(2);
  });
  it('refreshes with thirty simulation seconds remaining, preserving valid detail during the request',async()=>{
    const f=fixture();const hook=renderHook(props=>useCityMovementPreparation(props),{initialProps:f.options});await act(async()=>f.calls[0]!.finish());
    hook.rerender({...f.options,context:{...context,presentationMinutes:721.4}});expect(f.calls).toHaveLength(1);
    hook.rerender({...f.options,context:{...context,presentationMinutes:721.5}});expect(f.calls).toHaveLength(2);
    expect(hook.result.current).toMatchObject({status:'loading',resourcesReady:true,detailReady:true});
    await act(async()=>f.calls[1]!.finish());expect(hook.result.current.status).toBe('ready');
  });
  it('aborts only scope changes/unmount and ignores obsolete completion callbacks',async()=>{
    const f=fixture();const oldCallback=vi.fn(),newCallback=vi.fn();const hook=renderHook(props=>useCityMovementPreparation(props),{initialProps:{...f.options,onPrepared:oldCallback}});
    hook.rerender({...f.options,context:{...context,weather:'rain'},onPrepared:newCallback});expect(f.calls).toHaveLength(1);
    hook.rerender({...f.options,revision:'view-b',onPrepared:newCallback});expect(f.calls[0]!.signal?.aborted).toBe(true);expect(f.calls).toHaveLength(2);
    await act(async()=>f.calls[0]!.finish());expect(oldCallback).not.toHaveBeenCalled();expect(newCallback).not.toHaveBeenCalled();
    await act(async()=>f.calls[1]!.finish());expect(newCallback).toHaveBeenCalledTimes(1);
    hook.rerender({...f.options,revision:'view-c',onPrepared:newCallback});hook.unmount();expect(f.calls[2]!.signal?.aborted).toBe(true);
  });
  it('keeps the last good render on a failed refresh and does not retry on every clock tick',async()=>{
    const f=fixture();const hook=renderHook(props=>useCityMovementPreparation(props),{initialProps:f.options});await act(async()=>f.calls[0]!.finish());
    hook.rerender({...f.options,context:{...context,presentationMinutes:721.5}});await act(async()=>f.calls[1]!.fail());
    expect(hook.result.current).toMatchObject({status:'error',resourcesReady:true,detailReady:true});
    hook.rerender({...f.options,context:{...context,presentationMinutes:721.6}});expect(f.calls).toHaveLength(2);
    act(()=>hook.result.current.retry());expect(f.calls).toHaveLength(3);
  });
  it('retains same-scope actors after temporal freshness expires, but never across a changed context or viewport',async()=>{
    const f=fixture();const hook=renderHook(props=>useCityMovementPreparation(props),{initialProps:f.options});await act(async()=>f.calls[0]!.finish());
    hook.rerender({...f.options,context:{...context,presentationMinutes:721.5}});
    hook.rerender({...f.options,context:{...context,presentationMinutes:723}});
    expect(hook.result.current).toMatchObject({resourcesReady:false,lastCommittedRenderable:true,updating:true,handoff:'detail_ready'});
    const changed={...f.options,context:{...context,year:2027,presentationMinutes:723}};
    hook.rerender(changed);
    expect(hook.result.current).toMatchObject({resourcesReady:false,lastCommittedRenderable:false,handoff:'preparing_detail'});
    expect(f.calls[1]!.signal?.aborted).toBe(true);
    await act(async()=>f.calls[2]!.finish());expect(hook.result.current.lastCommittedRenderable).toBe(true);
    hook.rerender({...changed,revision:'different-source-cells'});
    expect(hook.result.current.lastCommittedRenderable).toBe(false);
  });
  it('treats legacy providers as ready without a minute-driven refetch loop',async()=>{
    const provider={prepareViewport:vi.fn(async()=>{})};const options={provider,context,frameActorCount:1};
    const hook=renderHook(props=>useCityMovementPreparation(props),{initialProps:options});await act(async()=>{});
    hook.rerender({...options,context:{...context,presentationMinutes:900}});
    expect(provider.prepareViewport).toHaveBeenCalledTimes(1);expect(hook.result.current.resourcesReady).toBe(true);
  });
  it('keeps a valid generation across the midnight UI wrap and reloads changed demographic context',async()=>{
    const f=fixture();const options={...f.options,context:{...context,presentationMinutes:1439.5}};
    const hook=renderHook(props=>useCityMovementPreparation(props),{initialProps:options});await act(async()=>f.calls[0]!.finish());
    hook.rerender({...options,context:{...context,presentationMinutes:.2}});expect(f.calls).toHaveLength(1);expect(hook.result.current.resourcesReady).toBe(true);
    hook.rerender({...options,context:{...context,presentationMinutes:.2,year:2027}});expect(f.calls).toHaveLength(2);expect(hook.result.current.resourcesReady).toBe(false);
  });
});
describe('semantic overview/detail handoff',()=>{
  it('holds overview until resources and actual actor output are both available',()=>{
    expect(cityMovementHandoff(false,true,10)).toBe('overview');
    expect(cityMovementHandoff(true,false,10)).toBe('preparing_detail');
    expect(cityMovementHandoff(true,true,0)).toBe('preparing_detail');
    expect(cityMovementHandoff(true,true,10)).toBe('detail_ready');
    const old={id:'previous-source-flow'},next={id:'new-source-flow'};
    expect(retainCityOverviewFlows('preparing_detail',next,old)).toBe(old);
    expect(retainCityOverviewFlows('preparing_detail',null,old)).toBe(old);
    expect(retainCityOverviewFlows('overview',next,old)).toBe(next);
    expect(retainCityOverviewFlows('detail_ready',next,old)).toBeNull();
  });
});
