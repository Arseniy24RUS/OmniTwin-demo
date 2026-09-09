import {describe,expect,it} from 'vitest';
import {gamePixelRatio} from './gamePixelRatio';

describe('shared canvas display resolution',()=>{
  it('keeps the actual narrow high-DPI user view sharp without exceeding its pixel budget',()=>{
    expect(gamePixelRatio('medium',2.25,494,674)).toBe(2);
  });
  it('does not supersample a normal display and bounds large high-DPI canvases',()=>{
    expect(gamePixelRatio('medium',1,1280,800)).toBe(1);
    const ratio=gamePixelRatio('medium',3,2560,1440);
    expect(ratio*ratio*2560*1440).toBeLessThanOrEqual(4_194_304);
  });
  it('uses an explicit lower pixel budget for performance quality',()=>{
    expect(gamePixelRatio('low',2.25,494,674)).toBe(1);
    const ratio=gamePixelRatio('low',3,2560,1440);
    expect(ratio*ratio*2560*1440).toBeLessThanOrEqual(1_048_576);
  });
});
