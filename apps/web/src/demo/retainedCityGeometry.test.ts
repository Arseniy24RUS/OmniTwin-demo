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
