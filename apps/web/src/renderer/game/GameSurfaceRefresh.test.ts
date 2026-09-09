import {describe,expect,it,vi} from 'vitest';
import {FrameScheduler} from '../runtime/FrameScheduler';
import {GameSurfaceRefresh} from './GameSurfaceRefresh';

describe('shared-render surface refresh',()=>{
  it('retains surfaces throughout a camera gesture and coalesces all dirty work after it ends',()=>{
    let interacting=true;
    const flush=vi.fn(),active=vi.fn();
    const refresh=new GameSurfaceRefresh({setActive:active,isReady:()=>true,isInteracting:()=>interacting,flush});
    for(let now=0;now<=3000;now+=16){refresh.mark();refresh.frame(now)}
    expect(flush).not.toHaveBeenCalled();
    expect(refresh.telemetry.dirty).toBe(true);
    expect(active).toHaveBeenLastCalledWith(false);
    interacting=false;refresh.mark();refresh.frame(3016);
    expect(flush).toHaveBeenCalledOnce();
    expect(refresh.telemetry.dirty).toBe(false);
    refresh.frame(6000);expect(flush).toHaveBeenCalledOnce();
  });
  it('flushes arriving sources during continuous playback without an idle event, at most every 250ms',()=>{
    const active=vi.fn(),times:number[]=[];let now=0;
    const refresh=new GameSurfaceRefresh({setActive:active,isReady:()=>true,flush:()=>times.push(now)});
    for(now=0;now<=1000;now+=25){refresh.mark();refresh.frame(now)}
    expect(times).toEqual([0,250,500,750,1000]);expect(refresh.telemetry.flushes).toBe(5);
  });
  it('uses the existing scheduler reason and requests no frames once a paused source has settled',()=>{
    let refresh:GameSurfaceRefresh;const scheduled: (()=>void)[]=[],repaint=vi.fn(),flush=vi.fn();
    const scheduler=new FrameScheduler({repaint,onFrame:f=>refresh.frame(f.nowMs),schedule:callback=>{scheduled.push(callback);return callback},cancelSchedule:()=>{},
      readPresentationState:()=>({presentationMinutes:0,absolutePresentationSeconds:0,paused:true,baseRateSecondsPerWallSecond:1,speedMultiplier:1,reducedMotion:false,sceneTimeZone:'UTC',environment:null})});
    refresh=new GameSurfaceRefresh({setActive:active=>scheduler.setReasonActive('data',active),isReady:()=>true,flush});
    refresh.mark();scheduler.recordRender(0);expect(flush).toHaveBeenCalledOnce();expect(scheduler.snapshot().continuousReasons).toEqual([]);
    const count=repaint.mock.calls.length;for(const callback of scheduled)callback();
    refresh.frame(1000);refresh.frame(2000);expect(repaint).toHaveBeenCalledTimes(count);expect(flush).toHaveBeenCalledOnce();scheduler.dispose();
  });
  it('retains dirtiness while a source is loading and coalesces late React/source changes',()=>{
    let ready=false;const flush=vi.fn(),active=vi.fn();const refresh=new GameSurfaceRefresh({setActive:active,isReady:()=>ready,flush});
    refresh.mark();refresh.frame(0);expect(flush).not.toHaveBeenCalled();expect(active).toHaveBeenLastCalledWith(false);
    ready=true;refresh.mark();refresh.frame(10);refresh.mark();refresh.mark();refresh.frame(100);expect(flush).toHaveBeenCalledOnce();
    refresh.frame(260);expect(flush).toHaveBeenCalledTimes(2);expect(refresh.telemetry.dirty).toBe(false);
  });
  it('keeps an invalidation raised during a flush and stops retries after a handled failure',()=>{
    let refresh:GameSurfaceRefresh;const failure=vi.fn(),active=vi.fn();let calls=0;
    refresh=new GameSurfaceRefresh({setActive:active,isReady:()=>true,flush:()=>{if(++calls===1)refresh.mark();else throw Error('source unavailable')},onError:failure});
    refresh.mark();refresh.frame(0);expect(refresh.telemetry.dirty).toBe(true);refresh.frame(250);
    expect(failure).toHaveBeenCalledOnce();expect(refresh.telemetry.dirty).toBe(false);expect(active).toHaveBeenLastCalledWith(false);
    refresh.frame(500);expect(calls).toBe(2);refresh.dispose();refresh.mark();refresh.frame(1000);expect(calls).toBe(2);
  });
});
