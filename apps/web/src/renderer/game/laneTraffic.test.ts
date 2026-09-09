import { describe, expect, it } from 'vitest';
import { LaneTraffic, type LaneTrafficVehicle } from './laneTraffic';

const path = [[0, 0], [300, 0]] as const;
const car = (id: string, distance: number, sourceSpeed = 8): LaneTrafficVehicle => ({ id, routeKey: 'source-edge-forward',
  path, sourceDistance: distance, sourceTime: 0, sourceSpeed, laneSpeed: 8 });
const distance = (traffic: LaneTraffic, time: number, id: string) => traffic.sampleWindow(time, .2).previous.get(id)!.distance;
describe('retained lane presentation traffic', () => {
  it('rechecks junction occupancy after the lane queue moves a fresh car back into the crossing',()=>{
    const traffic=new LaneTraffic(),horizontal=[[-40,0],[40,0]] as const,vertical=[[0,-40],[0,40]] as const;
    const leader={...car('leader',48,0),path:horizontal,laneSpeed:0,sourceTime:11};
    const crossing={...car('crossing',40,0),path:vertical,laneSpeed:0,sourceTime:11};
    traffic.sync([leader,crossing]);traffic.sampleWindow(11,0);
    traffic.sync([leader,crossing,{...car('new',50,0),path:horizontal,laneSpeed:0,sourceTime:11}]);
    const sample=traffic.sampleWindow(11,.2),entrant=sample.previous.get('new')!,incumbent=sample.previous.get('crossing')!;
    expect(incumbent.distance).toBe(40);
    expect(sample.previous.get('leader')!.distance).toBe(48);
    expect(!entrant.visible||Math.hypot(entrant.point[0]-incumbent.point[0],entrant.point[1]-incumbent.point[1])>=5).toBe(true);
    expect(sample.next.get('new')!.point).toEqual(entrant.point);
  });
  it('does not anticipate a green light inside the interpolation horizon',()=>{
    const traffic=new LaneTraffic();traffic.sync([{...car('east',0),path:[[-40,0],[40,0]]},
      {...car('south',33),path:[[0,-40],[0,40]]}]);
    traffic.sampleWindow(0);traffic.sampleWindow(9.9,0);
    const red=traffic.sampleWindow(9.9,.2);
    expect(red.next.get('south')!.point).toEqual(red.previous.get('south')!.point);
    expect(traffic.readSignals().junctions[0]!.phase).toBe('clearance');
    const green=traffic.sampleWindow(10.1,.2);
    expect(green.previous.get('south')!.distance).toBeCloseTo(red.previous.get('south')!.distance);
    expect(green.next.get('south')!.distance).toBeGreaterThan(green.previous.get('south')!.distance);
  });
  it('stops a red vehicle before a crossing and propagates its stop through the eight-metre follower queue', () => {
    const traffic = new LaneTraffic();
    traffic.sync([{ ...car('east', 20), path: [[-40, 0], [40, 0]] },
      { ...car('south-front', 20), path: [[0, -40], [0, 40]] },
      { ...car('south-rear', 10), path: [[0, -40], [0, 40]] }]);
    traffic.sampleWindow(0);
    for (let time = .1; time <= 7; time += .1) {
      const frame = traffic.sampleWindow(time).previous, a = frame.get('east')!, b = frame.get('south-front')!, c = frame.get('south-rear')!;
      expect(b.distance).toBeLessThanOrEqual(33.00001);
      expect(b.distance - c.distance).toBeGreaterThanOrEqual(8 - 1e-5);
      if (a.visible && b.visible) expect(Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1])).toBeGreaterThan(5);
    }
  });
  it('retains pedestrian waiting through source refresh, pause and seek without changing source membership', () => {
    const traffic = new LaneTraffic(), inputs: LaneTrafficVehicle[] = [
      { ...car('car', 0, 2), laneSpeed: 2, path: [[-40, 0], [40, 0]] },
      { ...car('walker', 20, 1.4), kind: 'pedestrian', laneSpeed: 1.4, path: [[0, -40], [0, 40]] }];
    traffic.sync(inputs); const initial = traffic.sampleWindow(0);
    const before = traffic.sampleWindow(5); traffic.sync(inputs.map(input => ({ ...input, sourceDistance: input.sourceDistance + input.sourceSpeed * 5, sourceTime: 5 })));
    expect([...traffic.sampleWindow(5).previous]).toEqual([...before.previous]);
    const paused = traffic.sampleWindow(5); expect([...paused.previous]).toEqual([...traffic.sampleWindow(5).previous]);
    traffic.sampleWindow(17); expect(traffic.sampleWindow(17).previous.get('walker')!.distance).toBeLessThan(40);
    traffic.reset(); traffic.sync(inputs); expect([...traffic.sampleWindow(0).previous]).toEqual([...initial.previous]);
    traffic.sync([inputs[0]!]); expect(traffic.readProbe().pedestrians).toHaveLength(0);
  });
  it('gives a faster rear and slower leader one lane speed without an initial teleport or catch-up', () => {
    const traffic = new LaneTraffic(); traffic.sync([car('leader', 80, 7), car('rear', 40, 10)]);
    expect(distance(traffic, 0, 'leader')).toBe(80); expect(distance(traffic, 0, 'rear')).toBe(40);
    const result = traffic.sampleWindow(5, .2);
    expect(result.previous.get('leader')!.distance).toBeCloseTo(120);
    expect(result.previous.get('rear')!.distance).toBeCloseTo(80);
    expect(result.next.get('leader')!.distance - result.previous.get('leader')!.distance).toBeCloseTo(1.6);
    expect(result.next.get('rear')!.distance - result.previous.get('rear')!.distance).toBeCloseTo(1.6);
  });
  it('places converging new members behind retained cars without moving an existing vehicle backwards', () => {
    const traffic = new LaneTraffic(); traffic.sync([car('existing', 60)]); distance(traffic, 1, 'existing');
    traffic.sync([{ ...car('existing', 68), sourceTime: 1 }, { ...car('entrant-a', 69), sourceTime: 1 }, { ...car('entrant-b', 69), sourceTime: 1 }]);
    const sample = traffic.sampleWindow(1, .2).previous;
    expect(sample.get('existing')!.distance).toBeCloseTo(68);
    expect(sample.get('entrant-a')!.distance).toBeLessThanOrEqual(60);
    expect(sample.get('entrant-a')!.distance - sample.get('entrant-b')!.distance).toBeGreaterThanOrEqual(8);
  });
  it('retains phase across five-second provider rebuilds despite different individual source speeds', () => {
    const traffic = new LaneTraffic(); traffic.sync([car('a', 70, 7), car('b', 30, 10)]);
    const before = traffic.sampleWindow(5, .2);
    traffic.sync([{ ...car('a', 105, 7), sourceTime: 5 }, { ...car('b', 80, 10), sourceTime: 5 }]);
    const after = traffic.sampleWindow(5, .2);
    expect([...after.previous]).toEqual([...before.previous]); expect([...after.next]).toEqual([...before.next]);
  });
  it('preserves body clearance at dense entry, pause, speed changes and the route endpoint', () => {
    const traffic = new LaneTraffic(); traffic.sync([car('a', 290), car('b', 286), car('c', 282)]);
    for (const time of [0, 0, .2, 3.4, 3.4, 7]) {
      const values = [...traffic.sampleWindow(time, .25).previous.values()].filter(v => v.visible);
      for (let i = 1; i < values.length; i++) expect(Math.abs(values[i]!.distance - values[i - 1]!.distance)).toBeGreaterThanOrEqual(8 - 1e-6);
    }
  });
  it('removes absent IDs immediately, and deterministic seek resets do not retain future positions', () => {
    const traffic = new LaneTraffic(); traffic.sync([car('a', 70), car('b', 30)]); const first = traffic.sampleWindow(1, .2);
    traffic.sampleWindow(9, .2); traffic.reset(); traffic.sync([car('a', 70), car('b', 30)]);
    expect([...traffic.sampleWindow(1, .2).previous]).toEqual([...first.previous]);
    traffic.sync([car('b', 30)]); expect(traffic.sampleWindow(1, .2).previous.has('a')).toBe(false);
  });
  it('deduplicates exact coincident source paths while respecting an existing opposite lane offset', () => {
    const traffic = new LaneTraffic(); traffic.sync([car('a', 60), { ...car('b', 63), routeKey: 'other-source-edge' },
      { ...car('offset', 63), path: [[0, 3], [300, 3]] }]);
    const sample = traffic.sampleWindow(0, .2).previous;
    expect(Math.abs(sample.get('a')!.distance - sample.get('b')!.distance)).toBeGreaterThanOrEqual(8);
    expect(sample.get('offset')!.distance).toBe(63);
  });
  it('queues on an exact shared directed segment even when source routes start elsewhere', () => {
    const traffic = new LaneTraffic(); traffic.sync([car('a', 60), { ...car('b', 62), path: [[-20, -20], [0, 0], [300, 0]], sourceDistance: 62 + Math.hypot(20, 20) }]);
    const sample = traffic.sampleWindow(0, .2).previous;
    const xA = sample.get('a')!.point[0], xB = sample.get('b')!.point[0];
    expect(Math.abs(xA - xB)).toBeGreaterThanOrEqual(8 - 1e-6);
  });
  it('keeps the body envelope clear through a source corner without backing up a retained follower', () => {
    const traffic = new LaneTraffic(), bend = [[0, 0], [100, 0], [100, 100]] as const;
    traffic.sync([{ ...car('leader', 96), path: bend }, { ...car('follower', 88), path: bend }]);
    let previous = -Infinity;
    for (let time = 0; time <= 3; time += .1) {
      const sample = traffic.sampleWindow(time, .2).previous, a = sample.get('leader')!, b = sample.get('follower')!;
      expect(b.distance).toBeGreaterThanOrEqual(previous - 1e-8); previous = b.distance;
      expect(Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1])).toBeGreaterThanOrEqual(8 - 1e-6);
    }
  });
  it('joins only overlapping collinear source segment intervals despite different source splitting', () => {
    const traffic = new LaneTraffic(); traffic.sync([car('a', 60), { ...car('split', 62), path: [[0, 0], [100, 0], [300, 0]] },
      { ...car('parallel', 62), path: [[0, .01], [300, .01]] }]);
    const sample = traffic.sampleWindow(0, .2).previous;
    expect(Math.abs(sample.get('a')!.point[0] - sample.get('split')!.point[0])).toBeGreaterThanOrEqual(8 - 1e-6);
    expect(sample.get('parallel')!.distance).toBe(62);
  });
  it('unifies actual V2 speed-bucket edges by their common source geometry',()=>{
    const traffic=new LaneTraffic();traffic.sync([{...car('slow',80,7),routeKey:'presence:road:car:speed-7:once',laneSpeed:7},
      {...car('fast',40,10),routeKey:'presence:road:car:speed-10:once',laneSpeed:10}]);
    traffic.sampleWindow(0);const frame=traffic.sampleWindow(5);
    expect(frame.previous.get('slow')!.distance).toBeCloseTo(115);expect(frame.previous.get('fast')!.distance).toBeCloseTo(75);
    expect(frame.previous.get('slow')!.speed).toBe(7);expect(frame.previous.get('fast')!.speed).toBe(7);
  });
  it('turns a source ping-pong vehicle at its endpoint without a position jump or hidden lone actor',()=>{
    const traffic=new LaneTraffic();traffic.sync([{...car('a',90,10),path:[[0,0],[100,0]],laneSpeed:10,traversal:'ping_pong',sourceDirection:'forward'}]);
    let previous=90;
    for(let time=0;time<=2;time+=.1){const frame=traffic.sampleWindow(time,.2).previous.get('a')!;
      expect(frame.visible).toBe(true);expect(Math.abs(frame.point[0]-previous)).toBeLessThanOrEqual(1.00001);previous=frame.point[0];}
    expect(traffic.sampleWindow(2).previous.get('a')!.point[0]).toBeCloseTo(90,4);
    expect(traffic.sampleWindow(2).previous.get('a')!.heading).toBeCloseTo(270);
  });
  it('retains ping-pong display phase when a five-second source refresh crosses a turn',()=>{
    const traffic=new LaneTraffic(),a={...car('a',90,10),path:[[0,0],[100,0]] as const,laneSpeed:10,traversal:'ping_pong' as const,sourceDirection:'forward' as const};
    traffic.sync([a]);traffic.sampleWindow(0);const before=traffic.sampleWindow(5);
    traffic.sync([{...a,sourceTime:5,sourceDistance:40,sourceDirection:'reverse'}]);const after=traffic.sampleWindow(5);
    expect([...after.previous]).toEqual([...before.previous]);expect([...after.next]).toEqual([...before.next]);
    expect(traffic.readProbe().sourceReanchors).toBe(0);
  });
  it('holds a reversed narrow-lane leg at the same source endpoint until the active direction drains',()=>{
    const traffic=new LaneTraffic();traffic.sync([80,60].map((distance,i)=>({...car(String(i),distance,10),path:[[0,0],[100,0]] as const,
      laneSpeed:10,traversal:'ping_pong' as const,sourceDirection:'forward' as const,singleLaneKey:'source-narrow'})));
    let observedWait=false;
    for(let time=0;time<=12;time+=.2){const values=[...traffic.sampleWindow(time,.2).previous.values()];
      observedWait ||= values.some(value=>!value.visible);const visible=values.filter(value=>value.visible);
      if(visible.length===2)expect(Math.abs(visible[0]!.point[0]-visible[1]!.point[0])).toBeGreaterThanOrEqual(8-1e-5);}
    expect(observedWait).toBe(true);expect(traffic.readProbe().managedVehicles).toBe(2);
    expect([...traffic.sampleWindow(12).previous.values()].some(value=>value.visible&&value.heading===270)).toBe(true);
  });
});
