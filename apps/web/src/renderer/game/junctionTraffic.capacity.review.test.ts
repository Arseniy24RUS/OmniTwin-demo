import {describe,expect,it} from 'vitest';
import {JunctionTraffic,type JunctionPath} from './junctionTraffic';

describe('independent junction physical-approach capacity review',()=>{
  it('does not stop a whole view because one physical corridor has33 overlapping route variants',()=>{
    // Synthetic metric intervals isolate the source-variant dimension. These
    // are33 distinct source polylines, all on ONE directed supporting line;
    // the shared pedestrian corridor adds longitudinal conflict, no new streets.
    const paths:JunctionPath[]=Array.from({length:33},(_,index)=>({key:`car-route-${index}`,kind:'vehicle',
      points:[[index,0],[100+index,0]],atGrade:true}));
    paths.push({key:'walk-corridor',kind:'pedestrian',points:[[0,0],[150,0]],atGrade:true});
    const junctions=new JunctionTraffic();junctions.sync(paths,1);
    expect(junctions.readSignals().diagnostics.overflow).toBe(0);
    const cap=junctions.constrain([{id:'already-driving',pathKey:'car-route-0',distance:50,desired:51,fresh:false,entered:true}],1).get('already-driving')!;
    expect(cap.visible).toBe(true);
    expect(cap.distance).toBe(51);
  });
});
