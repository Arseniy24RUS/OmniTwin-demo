import {describe,it,expect} from 'vitest';
import {GamePresentationClock} from '../renderer/game/gameClock';

describe('game presentation clock',()=>{
  it('does not rewind when counts, profile or telemetry rerender unchanged clock props',()=>{
    const input={seconds:690*60,playing:true,speed:1,seekRevision:0};
    const clock=new GamePresentationClock(input,0);
    for(const wall of [100,200,500,900]){
      clock.update(input,wall);
      expect(clock.read(wall)).toBeCloseTo(input.seconds+wall/1000,7);
    }
  });
  it('preserves fractional progress while pausing and changing speed',()=>{
    const input={seconds:100,playing:true,speed:1,seekRevision:0};
    const clock=new GamePresentationClock(input,0);
    clock.update({...input,playing:false},750);
    expect(clock.read(3000)).toBe(100.75);
    clock.update({...input,speed:16},3000);
    expect(clock.read(3250)).toBe(104.75);
  });
  it('accepts an authoritative clock tick and explicit seeks',()=>{
    const input={seconds:100,playing:true,speed:1,seekRevision:0};
    const clock=new GamePresentationClock(input,0);
    clock.update({...input,seconds:101},1000);
    expect(clock.read(1500)).toBe(101.5);
    clock.update({...input,seconds:80,seekRevision:1},1500);
    expect(clock.read(1750)).toBe(80.25);
  });
  it.each([1,16])('retains fractional progress through pause/resume and the next parent tick at %sx',speed=>{
    const input={seconds:100,playing:true,speed,seekRevision:0};
    const clock=new GamePresentationClock(input,0);
    clock.update({...input,playing:false},750);
    clock.update(input,3000);
    const before=clock.read(4000);
    clock.update({...input,seconds:100+speed},4000);
    expect(clock.read(4000)).toBe(before);
    expect(clock.read(4250)).toBe(100+2*speed);
  });
  it('does not lose old-rate progress at the next tick after a speed change',()=>{
    const input={seconds:100,playing:true,speed:16,seekRevision:0};
    const clock=new GamePresentationClock(input,0);
    clock.update({...input,speed:1},750);
    clock.update({...input,speed:1,seconds:101},1750);
    expect(clock.read(1750)).toBe(113);
    clock.update({...input,speed:1,seconds:99,seekRevision:1},1750);
    expect(clock.read(2000)).toBe(99.25);
  });
});
