import {describe,it,expect} from 'vitest';
import {Matrix4,Vector3} from 'three';
import {ecefToLocalMatrix,localToMercatorMatrix} from './cameraAdapter';
import {flatCatalogCellTransform} from './catalogProjection';
describe('catalog cells on the shared Mercator plane',()=>{
  it('keeps buildings on ground and at their own source origin across distant districts',()=>{
    const global={longitude:61.39466,latitude:55.1654,altitude:0};
    for(const cell of [{longitude:61.28,latitude:55.29,altitude:0},{longitude:61.48,latitude:55.05,altitude:0}]){
      const transform=new Matrix4().fromArray(flatCatalogCellTransform(cell,global));
      const actual=new Vector3().applyMatrix4(transform).applyMatrix4(ecefToLocalMatrix(global));
      const expected=new Vector3().applyMatrix4(localToMercatorMatrix(cell)).applyMatrix4(localToMercatorMatrix(global).invert());
      expect(actual.distanceTo(expected)).toBeLessThan(1e-7);expect(Math.abs(actual.y)).toBeLessThan(1e-7);
      const roof=new Vector3(0,0,30).applyMatrix4(transform).applyMatrix4(ecefToLocalMatrix(global));
      expect(roof.y).toBeCloseTo(30*Math.cos(global.latitude*Math.PI/180)/Math.cos(cell.latitude*Math.PI/180),6);
    }
  });
});
