import {buildVerifiedCityBuildings,type VerifiedCityBuildingOptions} from './verifiedCityBuildings';
import type {CityCellV2,CityRoadV2} from './data/CityPackV2';
import type {VerifiedCityBuildingSnapshot} from '../renderer/verifiedCityBuildingTypes';

/** One current geometry set. Immutable verified cells, never a nationwide cache. */
export class RetainedCityGeometry {
  private cells=new Map<string,CityCellV2>();
  private key='';
  private viewportKey='';
  private inventory:VerifiedCityBuildingOptions['sourceCoverage'];
  private result:{buildings:VerifiedCityBuildingSnapshot;roads:readonly CityRoadV2[]}|null=null;
  builds=0;
  update(options:VerifiedCityBuildingOptions){
    const key=[options.datasetVersion,...(options.sourceCoverage?.bounds??[]),options.maxCells,options.maxBuildings,options.maxVertices].join('|');
    const viewportKey=options.viewport?.bbox.join('|')??'';
    const same=this.result&&key===this.key&&options.sourceCoverage?.cells===this.inventory?.cells
      &&options.cells.length===this.cells.size&&options.cells.every(cell=>this.cells.get(cell.key)===cell);
    const bounds=this.result?.buildings.coverageBounds,view=options.viewport?.bbox;
    const covered=this.result?.buildings.coverage==='complete_viewport'&&bounds&&view&&view.every(Number.isFinite)
      &&view[0]<view[2]&&view[1]<view[3]&&view[0]>=bounds[0]&&view[1]>=bounds[1]&&view[2]<=bounds[2]&&view[3]<=bounds[3];
    // Reuse only an already proved complete rectangle, never a loaded-cell bbox
    // that could contain an unverified interior hole.
    if(same&&(viewportKey===this.viewportKey||covered))return this.result!;
    this.key=key;this.viewportKey=viewportKey;this.inventory=options.sourceCoverage;this.cells=new Map(options.cells.map(cell=>[cell.key,cell]));
    this.result={buildings:buildVerifiedCityBuildings(options),roads:options.cells.flatMap(cell=>cell.roads)};
    this.builds++;return this.result;
  }
}
