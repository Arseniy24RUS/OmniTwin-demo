import {buildVerifiedCityBuildings,type VerifiedCityBuildingOptions} from './verifiedCityBuildings';
import type {CityCellV2,CityRoadV2} from './data/CityPackV2';
import type {VerifiedCityBuildingSnapshot} from '../renderer/verifiedCityBuildingTypes';

/** One current geometry set. Immutable verified cells, never a nationwide cache. */
export class RetainedCityGeometry {
  private cells=new Map<string,CityCellV2>();
  private key='';
  private inventory:VerifiedCityBuildingOptions['sourceCoverage'];
  private result:{buildings:VerifiedCityBuildingSnapshot;roads:readonly CityRoadV2[]}|null=null;
  builds=0;
  update(options:VerifiedCityBuildingOptions){
    const key=[options.datasetVersion,...options.viewport?.bbox??[],...(options.sourceCoverage?.bounds??[])].join('|');
    const same=this.result&&key===this.key&&options.sourceCoverage?.cells===this.inventory?.cells
      &&options.cells.length===this.cells.size&&options.cells.every(cell=>this.cells.get(cell.key)===cell);
    if(same)return this.result!;
    this.key=key;this.inventory=options.sourceCoverage;this.cells=new Map(options.cells.map(cell=>[cell.key,cell]));
    this.result={buildings:buildVerifiedCityBuildings(options),roads:options.cells.flatMap(cell=>cell.roads)};
    this.builds++;return this.result;
  }
}
