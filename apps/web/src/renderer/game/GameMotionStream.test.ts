import {describe,expect,it} from 'vitest';
import {GameMotionStream} from './GameMotionStream';

const frame=(requestId:number,time:number)=>({requestId,columns:{previousTime:time,currentTime:time+.25},signals:`signals-${requestId}`});
describe('bounded asynchronous motion presentation',()=>{
  it('keeps the render callback free of solver work and has only one request in flight',()=>{
    const stream=new GameMotionStream<ReturnType<typeof frame>>(100);
    expect(stream.request()).toEqual({requestId:1,timeSeconds:100,horizonSeconds:.25});
    expect(stream.request()).toBeNull();
    stream.tick(0,100,true,1);
    expect(stream.tick(150,100.15,true,1).timeSeconds).toBe(100);
    stream.accept(frame(1,100));
    const shown=stream.tick(150,100.15,true,1);
    expect(shown.frames.map(f=>f.signals)).toEqual(['signals-1']);
    expect(shown.timeSeconds).toBe(100);
    expect(stream.request()!.timeSeconds).toBeCloseTo(100.25);
  });
  it('clamps all actor animation at the safe frontier and resumes without a time jump',()=>{
    const stream=new GameMotionStream<ReturnType<typeof frame>>(0);
    stream.request();stream.accept(frame(1,0));stream.tick(0,0,true,1);
    expect(stream.tick(1000,1,true,1).timeSeconds).toBe(.25);
    expect(stream.diagnostics.underflow).toBe(true);
    const request=stream.request()!;stream.accept(frame(request.requestId,request.timeSeconds));
    const resumed=stream.tick(1000,1,true,1);
    expect(resumed.timeSeconds).toBe(.25);
    expect(resumed.frames[0]!.columns.previousTime).toBeCloseTo(.25);
    expect(stream.tick(1010,1.01,true,1).timeSeconds).toBeCloseTo(.261);
    expect(stream.diagnostics.lagSeconds).toBeCloseTo(.749);
  });
  it('does not install a future frame or its signal snapshot before its timestamp',()=>{
    const stream=new GameMotionStream<ReturnType<typeof frame>>(10);
    stream.request();stream.accept(frame(1,10));stream.tick(0,10,true,1);
    const next=stream.request()!;stream.accept(frame(next.requestId,next.timeSeconds));
    expect(stream.tick(100,10.1,true,1).frames).toEqual([]);
    const shown=stream.tick(305,10.305,true,1);
    expect(shown.frames.map(f=>f.signals)).toEqual(['signals-2']);
    expect(shown.timeSeconds).toBeCloseTo(10.305);
  });
  it('freezes while paused, tolerates an outstanding reply, and resumes from the frozen position',()=>{
    const stream=new GameMotionStream<ReturnType<typeof frame>>(0);
    stream.request();stream.accept(frame(1,0));stream.tick(0,0,true,1);
    stream.tick(100,.1,true,1);
    const next=stream.request()!;
    stream.tick(100,.1,false,1);stream.accept(frame(next.requestId,next.timeSeconds));
    expect(stream.tick(5000,.1,false,1)).toMatchObject({timeSeconds:.1,frames:[]});
    expect(stream.tick(5000,.1,true,1).timeSeconds).toBe(.1);
    expect(stream.tick(5010,.11,true,1).timeSeconds).toBeCloseTo(.11);
  });
  it('bounds ready buffers and reports accelerated-time underflow rather than extrapolating across a crossing',()=>{
    const stream=new GameMotionStream<ReturnType<typeof frame>>(0);
    stream.tick(0,0,true,16);
    for(let i=0;i<5;i++){const r=stream.request()!;expect(r).not.toBeNull();stream.accept(frame(r.requestId,r.timeSeconds));}
    expect(stream.request()).toBeNull();
    expect(stream.tick(0,0,true,16).frames).toHaveLength(1);
    const tick=stream.tick(1000,16,true,16);
    expect(tick.timeSeconds).toBeCloseTo(1.25);
    expect(tick.frames).toHaveLength(4);
    expect(stream.diagnostics).toMatchObject({underflow:true,bufferedFrames:0});
  });
  it('rejects malformed, repeated, unordered and disconnected replies',()=>{
    const stream=new GameMotionStream<ReturnType<typeof frame>>(0);
    stream.request();
    expect(()=>stream.accept(frame(2,0))).toThrow(/request/);
    expect(()=>stream.accept(frame(1,3))).toThrow(/interval/);
    stream.accept(frame(1,0));
    expect(()=>stream.accept(frame(1,0))).toThrow(/request/);
  });
  it('recovers latency gradually on the same timeline without exceeding the explicit pacing bound',()=>{
    const stream=new GameMotionStream<ReturnType<typeof frame>>(0);
    stream.request();stream.accept(frame(1,0));stream.tick(0,.3,true,1);
    const second=stream.request()!;stream.accept(frame(second.requestId,second.timeSeconds));
    const shown=stream.tick(100,.4,true,1);
    expect(shown.timeSeconds).toBeCloseTo(.11);
    expect(stream.diagnostics.catchupMultiplier).toBeCloseTo(1.1);
    expect(stream.diagnostics.lagSeconds).toBeCloseTo(.29);
    const held=stream.tick(200,.4,false,1);
    expect(held.timeSeconds).toBe(shown.timeSeconds);
    expect(stream.diagnostics.catchupMultiplier).toBe(1);
  });
  it('never advances past authoritative time or reports missing time that is not requested',()=>{
    const stream=new GameMotionStream<ReturnType<typeof frame>>(0);
    stream.request();stream.accept(frame(1,0));stream.tick(0,0,true,16);
    expect(stream.tick(100,.1,true,16).timeSeconds).toBe(.1);
    expect(stream.diagnostics.underflow).toBe(false);
  });
});
