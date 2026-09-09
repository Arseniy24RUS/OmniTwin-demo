import {it,expect} from 'vitest';
import {RetainedCityGeometry} from './retainedCityGeometry';
import type {CityCellV2} from './data/CityPackV2';
it('keeps verified snapshot and road arrays through presence refreshes with the same immutable cells',()=>{
  const cell:CityCellV2={contract:'DemoCityCellV2',key:'16/1/1',bbox:[61,55,62,56],buildings:[],roads:[]};
  const cache=new RetainedCityGeometry();
  const input={datasetVersion:'v1',cells:[cell],viewport:{bbox:[61.1,55.1,61.2,55.2] as const}};
  const first=cache.update(input);
  expect(cache.update({...input,cells:[cell],viewport:{bbox:[61.1,55.1,61.2,55.2]}})).toBe(first);
  expect(cache.builds).toBe(1);
  expect(cache.update({...input,cells:[{...cell}]})).not.toBe(first);
  expect(cache.builds).toBe(2);
  expect(cache.update({...input,datasetVersion:'v2'})).not.toBe(first);
});
it('rechecks coverage when viewport bounds change even with retained cells',()=>{
  const cache=new RetainedCityGeometry();
  const first=cache.update({datasetVersion:'v1',cells:[],viewport:{bbox:[61,55,62,56]}});
  expect(cache.update({datasetVersion:'v1',cells:[],viewport:{bbox:[60,54,62,56]}})).not.toBe(first);
});
it('reuses the proven complete source rectangle through camera motion inside the same cells',()=>{
  const cell:CityCellV2={contract:'DemoCityCellV2',key:'16/1/1',bbox:[61,55,62,56],buildings:[],roads:[]};
  const cache=new RetainedCityGeometry();
  const input={datasetVersion:'v1',cells:[cell],viewport:{bbox:[61.1,55.1,61.2,55.2] as const}};
  const first=cache.update(input);
  expect(first.buildings.coverage).toBe('complete_viewport');
  expect(first.buildings.coverageBounds).toEqual(cell.bbox);
  for(let n=0;n<100;n++)expect(cache.update({...input,viewport:{bbox:[61.3+n/1000,55.3,61.5+n/1000,55.5]}})).toBe(first);
  expect(cache.builds).toBe(1);
  expect(cache.update({...input,viewport:{bbox:[60.9,55.1,61.2,55.2]}})).not.toBe(first);
});
it('invalidates retained geometry when a caller tightens the source limits',()=>{
  const cell:CityCellV2={contract:'DemoCityCellV2',key:'16/1/1',bbox:[61,55,62,56],buildings:[],roads:[]};
  const cache=new RetainedCityGeometry(),input={datasetVersion:'v1',cells:[cell],viewport:{bbox:[61.1,55.1,61.2,55.2] as const}};
  const first=cache.update(input);
  expect(cache.update({...input,maxCells:0})).not.toBe(first);
});
it('does not reuse a complete view across an unloaded hole between retained cells',()=>{
  const cells:CityCellV2[]=[
    {contract:'DemoCityCellV2',key:'left',bbox:[61,55,61.2,56],buildings:[],roads:[]},
    {contract:'DemoCityCellV2',key:'right',bbox:[61.4,55,61.6,56],buildings:[],roads:[]},
  ];
  const cache=new RetainedCityGeometry(),input={datasetVersion:'v1',cells,viewport:{bbox:[61.05,55.1,61.15,55.2] as const}};
  const left=cache.update(input);
  expect(left.buildings.coverage).toBe('complete_viewport');
  const hole=cache.update({...input,viewport:{bbox:[61.25,55.1,61.35,55.2]}});
  expect(hole).not.toBe(left);
  expect(hole.buildings.coverage).not.toBe('complete_viewport');
});
