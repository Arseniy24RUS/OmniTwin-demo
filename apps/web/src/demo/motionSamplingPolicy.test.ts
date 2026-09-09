import {expect,it} from 'vitest';
import {motionSamplingPolicy} from '../renderer/game/motionSamplingPolicy';
it('keeps the ordinary5Hz uploads and does not turn16x turns into4second chords',()=>{
  expect(motionSamplingPolicy(1)).toEqual({cadenceMs:200,horizonSeconds:.25});
  expect(motionSamplingPolicy(16)).toEqual({cadenceMs:12.5,horizonSeconds:.25});
  for(const speed of [1,4,16])expect(motionSamplingPolicy(speed).cadenceMs/1000*speed).toBeLessThan(motionSamplingPolicy(speed).horizonSeconds);
});
it('rejects invalid speed and bounds requested sampling cadence',()=>{
  for(const speed of [0,-1,NaN,Infinity])expect(()=>motionSamplingPolicy(speed)).toThrow();
  expect(motionSamplingPolicy(100).cadenceMs).toBe(12.5);
});
