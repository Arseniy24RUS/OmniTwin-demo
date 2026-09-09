import {
  BoxGeometry,BufferGeometry,CircleGeometry,Color,CylinderGeometry,DoubleSide,Group,
  InstancedMesh,Matrix4,MeshBasicMaterial,MeshStandardMaterial,Quaternion,Vector3,
} from 'three';

type Point=readonly [number,number];
export interface GameTrafficSignalApproach {
  id:string;kind:'vehicle'|'pedestrian';stopPoint:Point;heading:number;
  /** A controller-approved roadside location; null explicitly omits the prop. */
  signalPoint?:Point|null;
  aspect:'red'|'amber'|'green';waiting:number;occupied:number;
}
export interface GameTrafficSignalSnapshot {
  junctions:{id:string;point:Point;radiusMeters:number;phase:'vehicle'|'pedestrian'|'clearance';
    heldForOccupancy:boolean;approaches:GameTrafficSignalApproach[]}[];
}
const CAP=256,UP=new Vector3(0,1,0);
const ON={red:new Color('#ff3623'),amber:new Color('#ffbb25'),green:new Color('#52ed83')};
const OFF={red:new Color('#28120e'),amber:new Color('#29200d'),green:new Color('#10291a')};
function bytes(geometry:BufferGeometry){return Object.values(geometry.attributes).reduce((sum,a)=>sum+a.array.byteLength,0)+(geometry.index?.array.byteLength??0);}
const point=(p:Point)=>Array.isArray(p)&&p.length===2&&p.every(n=>Number.isFinite(n)&&Math.abs(n)<1_000_000);

/** Three bounded instanced draws. Signal aspects come only from the traffic
 * controller: no independent timer, guessed phase, scheduler or route obstacle. */
export class GameTrafficSignals {
  readonly object=new Group();
  readonly telemetry={representation:'visual_synthesis' as const,state:'empty' as 'empty'|'ready'|'error_hidden'|'disposed',
    heads:0,draws:0,red:0,amber:0,green:0,omittedPlacements:0,truncated:false,
    geometryUpdates:0,aspectUpdates:0,retainedBytes:0,lastError:null as string|null};
  private readonly dark=new MeshStandardMaterial({color:'#22292b',roughness:.65,metalness:.35});
  private readonly light=new MeshBasicMaterial({color:0xffffff,side:DoubleSide,toneMapped:false});
  private readonly poles=new InstancedMesh(new CylinderGeometry(.055,.075,1,6),this.dark,CAP);
  private readonly housings=new InstancedMesh(new BoxGeometry(1,1,1),this.dark,CAP);
  private readonly lenses=new InstancedMesh(new CircleGeometry(.11,10),this.light,CAP*3);
  private geometrySignature='';
  private aspectSignature='';
  private disposed=false;

  constructor(){
    this.object.name='coordinated-traffic-signals';this.object.userData.provenance='visual_synthesis';
    this.poles.name='roadside-signal-poles';this.housings.name='signal-housings';this.lenses.name='controller-signal-aspects';
    for(const mesh of [this.poles,this.housings,this.lenses]){mesh.count=0;mesh.frustumCulled=false;mesh.castShadow=false;this.object.add(mesh);}
    // Allocate colors once; changing a phase never allocates a new geometry.
    this.lenses.setColorAt(0,OFF.red);
    this.telemetry.retainedBytes=2*([this.poles,this.housings,this.lenses].reduce((sum,mesh)=>sum+bytes(mesh.geometry)+mesh.instanceMatrix.array.byteLength,0)
      +(this.lenses.instanceColor?.array.byteLength??0));
    this.object.visible=false;
  }

  update(snapshot:GameTrafficSignalSnapshot):void {
    if(this.disposed)return;
    try{
      if(!snapshot||!Array.isArray(snapshot.junctions)||snapshot.junctions.length>256)throw Error('Invalid signal junction inventory');
      const approaches:GameTrafficSignalApproach[]=[],keys=new Set<string>(),junctionIds=new Set<string>();let omitted=0,truncated=false,seen=0;
      for(const junction of snapshot.junctions){
        if(!junction.id||!point(junction.point)||!Array.isArray(junction.approaches)||junction.approaches.length>4096)throw Error('Invalid signal junction');
        if(junctionIds.has(junction.id))throw Error('Duplicate signal junction identity');
        junctionIds.add(junction.id);
        for(const approach of junction.approaches){
          if(++seen>4096)throw Error('Signal approach work limit');
          const key=`${junction.id}:${approach.id}`;
          if(keys.has(key)||!approach.id||!['vehicle','pedestrian'].includes(approach.kind)||!['red','amber','green'].includes(approach.aspect)
            ||!point(approach.stopPoint)||!Number.isFinite(approach.heading))throw Error('Invalid signal approach');
          keys.add(key);
          if(!approach.signalPoint){omitted++;continue;}
          if(!point(approach.signalPoint))throw Error('Invalid roadside signal location');
          if(approaches.length===CAP){omitted++;truncated=true;continue;}
          approaches.push(approach);
        }
      }
      const geometrySignature=JSON.stringify(approaches.map(a=>[a.id,a.kind,a.signalPoint,a.heading]));
      const aspectSignature=JSON.stringify(approaches.map(a=>[a.kind,a.aspect]));
      const geometryChanged=geometrySignature!==this.geometrySignature;
      if(geometryChanged){
        const matrix=new Matrix4(),rotation=new Quaternion(),position=new Vector3(),scale=new Vector3();let lensIndex=0;
        for(let i=0;i<approaches.length;i++){
          const a=approaches[i]!,ped=a.kind==='pedestrian',height=ped?2.35:3.45,center=height-.16;
          const [x,z]=a.signalPoint!;rotation.identity();position.set(x,height/2,z);scale.set(1,height,1);
          this.poles.setMatrixAt(i,matrix.compose(position,rotation,scale));
          // Local +Z faces the driver approaching the source stop point.
          rotation.setFromAxisAngle(UP,-a.heading*Math.PI/180);
          position.set(x,center,z);scale.set(ped?.34:.40,ped?.62:.94,.25);
          this.housings.setMatrixAt(i,matrix.compose(position,rotation,scale));
          const front=new Vector3(0,0,.133).applyQuaternion(rotation);
          for(const y of ped?[.16,-.16]:[.28,0,-.28]){
            position.set(x+front.x,center+y,z+front.z);scale.setScalar(ped?.86:1);
            this.lenses.setMatrixAt(lensIndex++,matrix.compose(position,rotation,scale));
          }
        }
        this.poles.count=this.housings.count=approaches.length;this.lenses.count=lensIndex;
        for(const mesh of [this.poles,this.housings,this.lenses])mesh.instanceMatrix.needsUpdate=true;
        this.geometrySignature=geometrySignature;this.telemetry.geometryUpdates++;
      }
      if(geometryChanged||aspectSignature!==this.aspectSignature){
        let index=0;
        for(const a of approaches){
          const aspects:('red'|'amber'|'green')[]=a.kind==='pedestrian'?['red','green']:['red','amber','green'];
          for(const aspect of aspects)this.lenses.setColorAt(index++,a.aspect===aspect?ON[aspect]:OFF[aspect]);
        }
        if(this.lenses.instanceColor)this.lenses.instanceColor.needsUpdate=true;
        this.aspectSignature=aspectSignature;this.telemetry.aspectUpdates++;
      }
      Object.assign(this.telemetry,{state:approaches.length?'ready':'empty',heads:approaches.length,draws:approaches.length?3:0,omittedPlacements:omitted,truncated,lastError:null,
        red:approaches.filter(a=>a.aspect==='red').length,amber:approaches.filter(a=>a.aspect==='amber').length,green:approaches.filter(a=>a.aspect==='green').length});
      this.object.visible=approaches.length>0;
    }catch(error){this.object.visible=false;Object.assign(this.telemetry,{state:'error_hidden',heads:0,draws:0,green:0,amber:0,red:0,omittedPlacements:0,truncated:false,
      lastError:error instanceof Error?error.message.slice(0,160):'Signal display failed'});}
  }

  dispose():void {
    if(this.disposed)return;this.disposed=true;
    for(const mesh of [this.poles,this.housings,this.lenses]){mesh.geometry.dispose();mesh.dispose();}
    this.dark.dispose();this.light.dispose();this.object.clear();this.object.visible=false;
    Object.assign(this.telemetry,{state:'disposed',heads:0,draws:0,red:0,amber:0,green:0,retainedBytes:0,lastError:null});
  }
}
