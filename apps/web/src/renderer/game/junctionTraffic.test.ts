import { describe, expect, it } from 'vitest';
import { JunctionTraffic, type JunctionPath, type JunctionActor } from './junctionTraffic';

const horizontal: JunctionPath = { key: 'east', kind: 'vehicle', points: [[-40, 0], [40, 0]], atGrade: true };
const vertical: JunctionPath = { key: 'south', kind: 'vehicle', points: [[0, -40], [0, 40]], atGrade: true };
const actor = (id: string, pathKey: string, distance: number, desired = distance, fresh = false): JunctionActor =>
  ({ id, pathKey, distance, desired, fresh, entered: true });

describe('source junction coordination', () => {
  it('regulates longitudinal sharing on the same grade-separated source corridor without adding a transverse ground crossing',()=>{
    const traffic=new JunctionTraffic(),bridge={...horizontal,atGrade:false,sourceCorridorKey:'verified-bridge-road'},walker={...bridge,key:'bridge-walk',kind:'pedestrian' as const};
    traffic.sync([bridge,walker,vertical],1);
    const caps=traffic.constrain([actor('old-walker','bridge-walk',20),actor('fresh-car','east',20,21,true),actor('unrelated-ground-car','south',32,34)],1);
    expect(caps.get('old-walker')!.distance).toBe(20);
    expect(caps.get('fresh-car')!.visible&&Math.abs(caps.get('fresh-car')!.distance-20)<5).toBe(false);
    expect(caps.get('unrelated-ground-car')!.distance).toBe(34);
    const unrelated=new JunctionTraffic();unrelated.sync([bridge,{...walker,sourceCorridorKey:'different-grade-road'}],1);
    expect(unrelated.readSignals().junctions).toHaveLength(0);
  });
  it('upgrades retained topology metadata when verified grade and roadside clearance arrive',()=>{
    const traffic=new JunctionTraffic();traffic.sync([{...horizontal,atGrade:undefined},vertical],0);
    expect(traffic.readSignals().junctions.every(node=>node.approaches.every(approach=>approach.signalPoint===null))).toBe(true);
    traffic.sync([{...horizontal,signalOffsetMeters:3.4,roadHalfWidthMeters:3},vertical],5,()=>true);
    expect(traffic.readSignals().junctions.some(node=>node.approaches.some(approach=>approach.signalPoint!==null))).toBe(true);
  });
  it('does not let an unverified geometry alias disable a verified bridge reservation',()=>{
    const traffic=new JunctionTraffic(),points=[[-40,0],[40,0]] as const;
    const car:JunctionPath={key:'verified-car',kind:'vehicle',points,atGrade:false,sourceCorridorKey:'verified-bridge'};
    const walk:JunctionPath={...car,key:'verified-walk',kind:'pedestrian'};
    traffic.sync([car,{...car,key:'unverified-alias',atGrade:undefined,sourceCorridorKey:undefined},walk],21);
    const caps=traffic.constrain([actor('car','verified-car',40,41),actor('walk','verified-walk',40,40,true)],21);
    expect(caps.get('car')!.distance).toBe(41);
    expect(caps.get('walk')!.visible&&Math.abs(caps.get('walk')!.distance-40)<3).toBe(false);
  });
  it('rechecks upstream occupancy when a downstream stop moves a fresh entrant backwards',()=>{
    const points=[[573.5845973836973,-127.20899668944752],[582.1211032493582,-127.56483116755938],
      [615.4731808617063,-128.93257021851718],[618.4520657245284,-130.88966097590372],
      [639.837791361689,-132.757793867408],[644.5379508403194,-134.5147290917821],
      [653.8048868975939,-137.9618825027581],[664.1960502917418,-145.62346855214355],
      [682.4250471943551,-145.96818463565359],[685.4928539905012,-101.50003104819835]] as const;
    const traffic=new JunctionTraffic();traffic.sync(['vehicle','pedestrian'].flatMap(kind=>[
      {key:`${kind}-forward`,kind:kind as 'vehicle'|'pedestrian',points},
      {key:`${kind}-reverse`,kind:kind as 'vehicle'|'pedestrian',points:[...points].reverse()}]),42475);
    const caps=traffic.constrain([actor('incumbent','vehicle-reverse',52.19291060672468),
      actor('entrant','pedestrian-reverse',85.78350071756097,85.78350071756097,true)],42476.92);
    expect(caps.get('incumbent')!.distance).toBe(52.19291060672468);
    expect(caps.get('entrant')!.visible&&Math.abs(caps.get('entrant')!.distance-52.19291060672468)<3).toBe(false);
  });
  it('reports a waiting actor exactly at its red stop line',()=>{
    const traffic=new JunctionTraffic();traffic.sync([horizontal,vertical],0);
    traffic.constrain([actor('south','south',33)],1);
    expect(traffic.readSignals().junctions[0]!.approaches.some(approach=>approach.waiting===1)).toBe(true);
  });
  it('does not install a junction at a bend traversed in both directions on the same source corridor',()=>{
    const traffic=new JunctionTraffic(),points=[[-40,0],[0,0],[0,40]] as const;
    traffic.sync([{...horizontal,key:'forward-bend',points},{...horizontal,key:'reverse-bend',points:[...points].reverse()}],0);
    expect(traffic.readSignals().junctions).toHaveLength(0);
  });
  it('omits a roadside prop whose nominal footprint falls on another actual vehicle corridor',()=>{
    const traffic=new JunctionTraffic();
    traffic.sync([{...horizontal,signalOffsetMeters:4,roadHalfWidthMeters:3},vertical,
      {...horizontal,key:'adjacent',points:[[-40,4],[40,4]]}],0,()=>true);
    const heads=traffic.readSignals().junctions.flatMap(node=>node.approaches).filter(approach=>approach.roadHalfWidthMeters===3);
    expect(heads.length).toBeGreaterThan(0);expect(heads.every(head=>head.signalPoint===null)).toBe(true);
  });
  it('holds a crossing vehicle before the conflict zone while the permitted vehicle passes', () => {
    const traffic = new JunctionTraffic(); traffic.sync([horizontal, vertical], 0);
    const caps = traffic.constrain([actor('east-car', 'east', 32, 34), actor('south-car', 'south', 32, 34)], 1);
    expect(caps.get('east-car')!.distance).toBe(34);
    expect(caps.get('south-car')!.distance).toBeLessThanOrEqual(33);
  });
  it('gives pedestrians a separate phase and drains an occupied vehicle zone before releasing them', () => {
    const traffic = new JunctionTraffic(); traffic.sync([horizontal, { ...vertical, key: 'walk', kind: 'pedestrian' }], 0);
    const red = traffic.constrain([actor('walker', 'walk', 30, 40)], 1);
    expect(red.get('walker')!.distance).toBeLessThan(40);
    const occupied = traffic.constrain([actor('car', 'east', 40, 41), actor('walker', 'walk', 30, 40)], 21);
    expect(occupied.get('walker')!.distance).toBeLessThan(40);
    const clear = traffic.constrain([actor('car', 'east', 52, 53), actor('walker', 'walk', 30, 40)], 21);
    expect(clear.get('walker')!.distance).toBe(40);
  });
  it('retains physical occupancy across a phase boundary and gives incumbents priority over fresh overlaps', () => {
    const traffic = new JunctionTraffic(); traffic.sync([horizontal, vertical], 0);
    const caps = traffic.constrain([actor('old', 'east', 40, 41), actor('new', 'south', 40, 41, true)], 11);
    expect(caps.get('old')!.distance).toBe(41);
    expect(caps.get('new')!.distance).toBeLessThanOrEqual(33);
    expect(traffic.readSignals().junctions[0]!.heldForOccupancy).toBe(true);
  });
  it('keeps topology and signal phase through transient source membership refreshes', () => {
    const traffic = new JunctionTraffic(); traffic.sync([horizontal, vertical], 0);
    traffic.constrain([], 4); const before = traffic.readSignals();
    traffic.sync([horizontal], 5); traffic.constrain([], 4);
    expect(traffic.readSignals().junctions).toEqual(before.junctions);
  });
  it('uses displayed lane offsets, rejects grade-separated paths, and reports bounded overflow explicitly', () => {
    const traffic = new JunctionTraffic(); traffic.sync([{ ...horizontal, points: [[-40, 2], [40, 2]] }, vertical], 0);
    expect(traffic.readSignals().junctions[0]!.point).toEqual([0, 2]);
    const bridge = new JunctionTraffic(); bridge.sync([horizontal, { ...vertical, atGrade: false }], 0);
    expect(bridge.readSignals().junctions).toHaveLength(0);
    const bounded = new JunctionTraffic({ maxSegments: 1 }); bounded.sync([horizontal, vertical], 0);
    expect(bounded.readSignals().diagnostics.overflow).toBeGreaterThan(0);
    expect(bounded.constrain([actor('car', 'east', 1, 2)], 1).get('car')!.distance).toBe(1);
    expect(() => traffic.sync([{ ...horizontal, points: [[0, 0], [NaN, 0]] }], 0)).toThrow();
  });
});
