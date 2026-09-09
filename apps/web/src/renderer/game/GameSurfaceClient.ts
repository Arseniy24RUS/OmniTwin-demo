import type {GameSurfaceJob,GameSurfacePreparedResult,GameSurfaceRequest,GameSurfaceResponse} from './gameSurfaceProtocol';

type Kind=GameSurfaceJob['kind'];
interface Pending {job:GameSurfaceJob;revision:number}
export interface GameSurfacePort {
  postMessage(message:GameSurfaceRequest):void;
  addEventListener(type:'message',listener:(event:MessageEvent<GameSurfaceResponse>)=>void):void;
  addEventListener(type:'error'|'messageerror',listener:(event:Event)=>void):void;
  removeEventListener(type:'message',listener:(event:MessageEvent<GameSurfaceResponse>)=>void):void;
  removeEventListener(type:'error'|'messageerror',listener:(event:Event)=>void):void;
  terminate():void;
}
export interface GameSurfaceAppliedResult {job:GameSurfaceJob;result:GameSurfacePreparedResult}
const KINDS=new Set<Kind>(['roads','landCover','landUseGround','vegetation','courtyardGround','buildingContacts']);

/** One stateless preparation flight and at most one latest input per surface.
 * Source updates never enqueue an unbounded trail of obsolete camera jobs.
 * Rendering owns the committed objects; a failed/obsolete result cannot clear
 * them, run the geometry compiler on main, or create another render loop. */
export class GameSurfaceClient {
  private readonly pending=new Map<Kind,Pending>();
  private readonly latest=new Map<Kind,number>();
  private flight:{requestId:number;entries:Pending[];started:number}|null=null;
  private nextRequest=1;
  private revision=0;
  private disposed=false;
  private failure:string|null=null;
  private posts=0;
  private discarded=0;
  private maxPostMs=0;
  private maxRoundTripMs=0;
  private lastPreparation:Extract<GameSurfaceResponse,{type:'prepared'}>['telemetry']|null=null;
  constructor(private readonly port:GameSurfacePort,private readonly options:{
    onResults:(results:readonly GameSurfaceAppliedResult[])=>void;
    onError:(message:string,jobs:readonly GameSurfaceJob[])=>void;
    now?:()=>number;
  }){
    port.addEventListener('message',this.receive);
    port.addEventListener('error',this.onPortError);port.addEventListener('messageerror',this.onPortError);
  }
  private now(){return this.options.now?.()??performance.now();}
  request(jobs:readonly GameSurfaceJob[]):void{
    if(this.disposed)return;
    if(!jobs.length||jobs.length>6||new Set(jobs.map(job=>job.kind)).size!==jobs.length||jobs.some(job=>!KINDS.has(job.kind)))throw Error('Invalid surface job inventory');
    if(this.failure){this.options.onError(this.failure,jobs);return;}
    for(const job of jobs){const revision=++this.revision;this.latest.set(job.kind,revision);this.pending.set(job.kind,{job,revision});}
    this.pump();
  }
  private pump():void{
    if(this.disposed||this.failure||this.flight||!this.pending.size)return;
    const entries=[...this.pending.values()];this.pending.clear();
    const requestId=this.nextRequest++,started=this.now();this.flight={requestId,entries,started};
    try{
      this.port.postMessage({type:'prepare',requestId,generation:1,jobs:entries.map(entry=>entry.job)});
      this.posts++;this.maxPostMs=Math.max(this.maxPostMs,this.now()-started);
    }catch(error){this.fail(error instanceof Error?error.message:'Surface worker message failed');}
  }
  private receive=(event:MessageEvent<GameSurfaceResponse>)=>{
    if(this.disposed||this.failure)return;
    const response=event.data,flight=this.flight;
    if(!flight||response.requestId!==flight.requestId)return;
    if(response.generation!==1){this.fail('Surface generation mismatch');return;}
    this.maxRoundTripMs=Math.max(this.maxRoundTripMs,this.now()-flight.started);
    if(response.type!=='prepared'){this.fail('message'in response?response.message:'Unexpected surface worker response');return;}
    this.lastPreparation=response.telemetry??null;
    const kinds=new Set(response.results.map(result=>result.kind));
    if(response.results.length!==flight.entries.length||kinds.size!==flight.entries.length||flight.entries.some(entry=>!kinds.has(entry.job.kind))){
      this.fail('Surface result inventory mismatch');return;
    }
    this.flight=null;
    const current:GameSurfaceAppliedResult[]=[];
    for(const result of response.results){
      const entry=flight.entries.find(value=>value.job.kind===result.kind)!;
      if(this.latest.get(result.kind)!==entry.revision){this.discarded++;continue;}
      current.push({job:entry.job,result});
    }
    try{if(current.length)this.options.onResults(current);}
    catch(error){this.fail(error instanceof Error?error.message:'Surface application failed');return;}
    this.pump();
  };
  private fail(message:string):void{
    if(this.disposed||this.failure)return;
    this.failure=message.slice(0,180);
    const jobs=new Map<Kind,GameSurfaceJob>();
    for(const entry of [...(this.flight?.entries??[]),...this.pending.values()])jobs.set(entry.job.kind,entry.job);
    this.flight=null;this.pending.clear();this.latest.clear();this.options.onError(this.failure,[...jobs.values()]);
  }
  private onPortError=()=>this.fail('Surface worker unavailable');
  get diagnostics(){return{mode:'worker_prepared' as const,inFlight:Boolean(this.flight),pendingKinds:[...this.pending.keys()],
    maximumPendingKinds:6,postedMessages:this.posts,discardedResults:this.discarded,maxPostMs:this.maxPostMs,
    maxRoundTripMs:this.maxRoundTripMs,lastPreparation:this.lastPreparation,error:this.failure};}
  dispose():void{
    if(this.disposed)return;this.disposed=true;
    this.port.removeEventListener('message',this.receive);this.port.removeEventListener('error',this.onPortError);this.port.removeEventListener('messageerror',this.onPortError);
    this.port.terminate();this.flight=null;this.pending.clear();this.latest.clear();
  }
}
