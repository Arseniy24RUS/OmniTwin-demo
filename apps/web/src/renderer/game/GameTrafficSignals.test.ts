import {describe,expect,it} from 'vitest';
import {Matrix4,Vector3} from 'three';
import {GameTrafficSignals,type GameTrafficSignalSnapshot} from './GameTrafficSignals';

const snapshot=(aspect:'red'|'amber'|'green'='red'):GameTrafficSignalSnapshot=>({junctions:[{
  id:'junction-a',point:[0,0],radiusMeters:7,phase:'vehicle',heldForOccupancy:false,
  approaches:[{id:'north',kind:'vehicle',stopPoint:[0,10],signalPoint:[3.5,10],heading:0,aspect,waiting:1,occupied:0},
    {id:'walk',kind:'pedestrian',stopPoint:[-8,0],signalPoint:null,heading:90,aspect:'red',waiting:1,occupied:0}],
}]});

describe('source-controlled traffic signal props',()=>{
  it('draws only approved roadside positions, with physical housings and no obstacle on the stop path',()=>{
    const signals=new GameTrafficSignals();signals.update(snapshot());
    expect(signals.telemetry.heads).toBe(1);expect(signals.telemetry.omittedPlacements).toBe(1);
    expect(signals.telemetry.draws).toBe(3);
    const matrix=new Matrix4();
    const pole=signals.object.children[0] as import('three').InstancedMesh;
    pole.getMatrixAt(0,matrix);const position=new Vector3().setFromMatrixPosition(matrix);
    expect(position.x).toBe(3.5);expect(position.z).toBe(10);expect(position.y).toBeGreaterThan(1);
    expect(signals.telemetry.retainedBytes).toBeLessThan(1024*1024);signals.dispose();
  });
  it('updates aspects without rebuilding geometry and remains still when the controller is paused',()=>{
    const signals=new GameTrafficSignals();signals.update(snapshot());
    const before={...signals.telemetry};signals.update(snapshot());
    expect(signals.telemetry.geometryUpdates).toBe(before.geometryUpdates);
    expect(signals.telemetry.aspectUpdates).toBe(before.aspectUpdates);
    signals.update(snapshot('green'));
    expect(signals.telemetry.geometryUpdates).toBe(before.geometryUpdates);
    expect(signals.telemetry.aspectUpdates).toBe(before.aspectUpdates+1);
    expect(signals.telemetry.green).toBe(1);expect(signals.telemetry.red).toBe(0);signals.dispose();
  });
  it('caps display props independently of the controller and reports omitted heads',()=>{
    const value=snapshot();value.junctions[0]!.approaches=Array.from({length:300},(_,i)=>({...value.junctions[0]!.approaches[0]!,id:String(i),signalPoint:[i*4,10]}));
    const signals=new GameTrafficSignals();signals.update(value);
    expect(signals.telemetry.heads).toBe(256);expect(signals.telemetry.omittedPlacements).toBe(44);
    expect(signals.telemetry.truncated).toBe(true);signals.dispose();
  });
  it('does not display a stale green indication after a malformed controller snapshot',()=>{
    const signals=new GameTrafficSignals();signals.update(snapshot('green'));
    const invalid=snapshot();invalid.junctions[0]!.approaches[0]!.heading=NaN;
    signals.update(invalid);
    expect(signals.telemetry.state).toBe('error_hidden');expect(signals.object.visible).toBe(false);
    expect(signals.telemetry.heads).toBe(0);expect(signals.telemetry.lastError).toBe('Invalid signal approach');
    signals.update(snapshot());expect(signals.object.visible).toBe(true);expect(signals.telemetry.green).toBe(0);
    expect(signals.telemetry.lastError).toBeNull();
    signals.dispose();expect(signals.telemetry.retainedBytes).toBe(0);
  });
  it('reports ambiguous junction identity without exposing stale signal heads',()=>{
    const signals=new GameTrafficSignals(),value=snapshot();
    value.junctions.push({...value.junctions[0]!,point:[20,0],approaches:[{...value.junctions[0]!.approaches[0]!,id:'other-physical-approach'}]});
    signals.update(value);
    expect(signals.telemetry.state).toBe('error_hidden');expect(signals.telemetry.lastError).toBe('Duplicate signal junction identity');
    expect(signals.telemetry.heads).toBe(0);signals.dispose();
  });
});
