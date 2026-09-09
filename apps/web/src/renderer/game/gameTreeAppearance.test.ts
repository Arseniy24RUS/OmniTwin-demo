import {describe,expect,it} from 'vitest';
import {createGameTreeCanopy,gameTreeAppearance} from './gameTreeAppearance';

describe('deterministic illustrative tree appearance',()=>{
  it('varies canopy family, aspect and muted color without using source botanical claims',()=>{
    const forms=Array.from({length:100},(_,i)=>gameTreeAppearance(`source-tree:${i}`));
    expect(new Set(forms.map(form=>form.family)).size).toBe(2);
    expect(new Set(forms.map(form=>form.leafColor)).size).toBeGreaterThan(5);
    expect(new Set(forms.map(form=>(form.scaleX/form.scaleZ).toFixed(2))).size).toBeGreaterThan(20);
    expect(gameTreeAppearance('source-tree:19')).toEqual(forms[19]);
  });
  it('keeps every canopy variant inside its previously cleared horizontal and vertical envelope',()=>{
    const geometry=[createGameTreeCanopy(0),createGameTreeCanopy(1)];
    for(let index=0;index<100;index++){
      const form=gameTreeAppearance(`source-tree:${index}`),points=geometry[form.family]!.getAttribute('position');
      for(let i=0;i<points.count;i++){
        expect(Math.hypot(points.getX(i)*form.scaleX,points.getZ(i)*form.scaleZ)).toBeLessThanOrEqual(1.00001);
        const height=points.getY(i)*form.scaleY+form.offsetY;
        expect(height).toBeGreaterThanOrEqual(0);expect(height).toBeLessThanOrEqual(1.00001);
      }
    }
    geometry.forEach(item=>item.dispose());
  });
});
