import {Matrix4} from 'three';
import {ecefToLocalMatrix,localToMercatorMatrix,type GameOrigin} from './cameraAdapter';

/** Standard tile ENU -> the flat Mercator city, expressed in the renderer's ECEF frame.
 * A raw tangent-frame union curves downward by metres between districts. */
export function flatCatalogCellTransform(cell:GameOrigin,global:GameOrigin):number[]{
  const enuToEus=new Matrix4().set(1,0,0,0, 0,0,1,0, 0,-1,0,0, 0,0,0,1);
  return ecefToLocalMatrix(global).invert().multiply(localToMercatorMatrix(global).invert())
    .multiply(localToMercatorMatrix(cell)).multiply(enuToEus).elements;
}
