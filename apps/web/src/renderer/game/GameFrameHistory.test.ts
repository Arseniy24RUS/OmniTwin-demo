import {describe,it,expect} from 'vitest';
import {GameFrameHistory} from './GameFrameHistory';

describe('actual-render timestamp history',()=>{
  it('reads every frame after a cursor, including long stalls, without sampling the scene',()=>{
    const history=new GameFrameHistory();history.record(10);
    const cursor=history.read().sequence;
    for(const t of [20,40,550,570])history.record(t);
    expect(history.read(cursor,600)).toMatchObject({sequence:5,dropped:false,nowMs:600,
      samples:[{sequence:2,timeMs:20},{sequence:3,timeMs:40},{sequence:4,timeMs:550},{sequence:5,timeMs:570}]});
  });
  it('explicitly reports overwritten evidence instead of presenting a partial tail as the whole window',()=>{
    const history=new GameFrameHistory(3);for(let t=1;t<=6;t++)history.record(t*10);
    expect(history.read(0).dropped).toBe(true);
    expect(history.read(3)).toMatchObject({dropped:false,oldestSequence:4,samples:[{sequence:4,timeMs:40},{sequence:5,timeMs:50},{sequence:6,timeMs:60}]});
  });
  it('returns detached records and rejects impossible cursors',()=>{
    const history=new GameFrameHistory();history.record(10);
    const value=history.read(0);value.samples[0]!.timeMs=999;
    expect(history.read(0).samples[0]!.timeMs).toBe(10);
    expect(()=>history.read(2)).toThrow();expect(()=>history.read(-1)).toThrow();
    expect(history.read().samples).toEqual([]);
  });
});
