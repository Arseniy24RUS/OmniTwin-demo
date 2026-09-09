import {expect,it} from 'vitest';
import {overviewRoads} from '../renderer/game/overviewRoads';
it('keeps geographically separate clipped road pieces but removes duplicated style passes',()=>{
  const road={type:'Feature' as const,id:1,properties:{class:'primary'},geometry:{type:'LineString' as const,coordinates:[[61,55],[61.01,55]]}};
  const other={...road,geometry:{...road.geometry,coordinates:[[61.1,55],[61.11,55]]}};
  expect(overviewRoads([road,road,other])).toHaveLength(2);
  expect(overviewRoads([{...road,properties:{class:'path'}}])).toHaveLength(0);
});
