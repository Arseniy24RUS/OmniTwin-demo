import {GameMotionStream} from './GameMotionStream';
import type {GameMotionRequest,GameMotionResponse,GameMotionSource,GameMotionSourceDiagnostics} from './gameMotionProtocol';
import type {GameActorColumns} from './GameActors';

type Sample=Extract<GameMotionResponse,{type:'sample'}>;
export type GameMotionDisplayFrame=Sample&{diagnostics:GameMotionSourceDiagnostics};
export interface GameMotionPort {
  postMessage(message:GameMotionRequest):void;
  addEventListener(type:'message',listener:(event:MessageEvent<GameMotionResponse>)=>void):void;
  addEventListener(type:'error'|'messageerror',listener:(event:Event)=>void):void;
  removeEventListener(type:'message',listener:(event:MessageEvent<GameMotionResponse>)=>void):void;
  removeEventListener(type:'error'|'messageerror',listener:(event:Event)=>void):void;
  terminate():void;
}
interface Flight {wireId:number;generation:number;revision:number;sampleId?:number;started:number;source?:GameMotionSource}
/** Persistent worker transport. One outstanding message, one coalesced source
 * update, five compact sample windows. No geometry/traffic calculation, timers
 * or independent render loop on the browser's main thread. */
export class GameMotionClient {
  private stream:GameMotionStream<GameMotionDisplayFrame>;
  private generation=1;
  private revision=0;
  private configuredRevision=0;
  private nextWireId=1;
  private flight:Flight|null=null;
  private pendingSource:{revision:number;source:GameMotionSource}|null=null;
  private latestSource:GameMotionSource|null=null;
  private acknowledgedSource:GameMotionSource|null=null;
  private readonly sources=new Map<number,GameMotionSourceDiagnostics>();
  private readonly membership=new Map<number,Pick<GameActorColumns,'ids'|'kinds'|'seeds'|'pickable'>>();
  private playing=false;
  private hasPlayed=false;
  private disposed=false;
  private failure:string|null=null;
  private displayed:GameMotionDisplayFrame|null=null;
  private roundTripMaxMs=0;
  private postMaxMs=0;
  private posted=0;
  private firstSampleRequested=false;
  private latestSeconds:number;
  constructor(private readonly port:GameMotionPort,startSeconds:number,private readonly options:{
    onDirty:()=>void;onError:(message:string)=>void;now?:()=>number;
  }){
    this.stream=new GameMotionStream(startSeconds);
    this.latestSeconds=startSeconds;
    port.addEventListener('message',this.receive);port.addEventListener('error',this.onPortError);port.addEventListener('messageerror',this.onPortError);
  }
  private now(){return this.options.now?.()??performance.now();}
  setSource(source:GameMotionSource):void{
    if(this.disposed)return;
    // A cold paused page may publish its empty loading inventory before real
    // actors arrive. There is no displayed traffic to preserve in that case;
    // discard empty lookahead and initialize the first real inventory at the
    // frozen time. Never use this reset for already displayed participants.
    if(!this.playing&&this.latestSource?.entities.length===0&&source.entities.length>0
      &&(this.displayed?.columns.ids.length??0)===0)this.beginGeneration(this.latestSeconds);
    this.latestSource=source;this.pendingSource={revision:++this.revision,source};this.pump();
  }
  private beginGeneration(startSeconds:number):void{
    this.generation++;this.stream=new GameMotionStream(startSeconds);this.configuredRevision=0;this.displayed=null;
    this.latestSeconds=startSeconds;this.firstSampleRequested=false;
    this.hasPlayed=false;
    this.acknowledgedSource=null;
    this.sources.clear();this.membership.clear();
    this.pendingSource=null;
  }
  reset(startSeconds:number):void{
    if(this.disposed)return;
    this.beginGeneration(startSeconds);
    if(this.latestSource)this.pendingSource={revision:++this.revision,source:this.latestSource};
    // The old flight finishes once; its generation can never reach the screen.
    // Coalescing repeated seeks here also bounds the worker's message queue.
    this.pump();
  }
  tick(wallMs:number,authoritativeSeconds:number,playing:boolean,speed:number){
    if(this.disposed)return {timeSeconds:this.stream.diagnostics.presentationSeconds,frames:[] as GameMotionDisplayFrame[]};
    this.playing=playing;
    this.hasPlayed ||= playing;
    this.latestSeconds=authoritativeSeconds;
    const tick=this.stream.tick(wallMs,authoritativeSeconds,playing,speed);
    for(const frame of tick.frames)this.displayed=frame;
    this.pump();return tick;
  }
  private post(message:GameMotionRequest,sampleId?:number,source?:GameMotionSource):void{
    const start=this.now();this.flight={wireId:message.requestId,generation:message.generation,
      revision:'sourceRevision'in message?message.sourceRevision:0,sampleId,started:start,source};
    try{this.port.postMessage(message);this.posted++;this.postMaxMs=Math.max(this.postMaxMs,this.now()-start);}
    catch(error){this.fail(error instanceof Error?error.message:'Movement worker message failed');}
  }
  private pump():void{
    if(this.disposed||this.failure||this.flight)return;
    if(this.pendingSource){
      const pending=this.pendingSource;this.pendingSource=null;
      const envelope={type:'configure' as const,requestId:this.nextWireId++,generation:this.generation,sourceRevision:pending.revision};
      const base=this.acknowledgedSource;
      // React/source providers publish immutable field values. Compare with
      // the last ACKNOWLEDGED inventory: coalesced or in-flight sources are not
      // valid delta bases. Camera updates then avoid cloning unchanged city
      // polygons and route graphs on the rendering thread.
      const message:GameMotionRequest=base?{...envelope,baseSourceRevision:this.configuredRevision,
        sourcePatch:Object.fromEntries((Object.keys(pending.source) as (keyof GameMotionSource)[])
          .filter(key=>pending.source[key]!==base[key]).map(key=>[key,pending.source[key]]))}:{...envelope,source:pending.source};
      this.post(message,undefined,pending.source);return;
    }
    if(!this.configuredRevision||!this.playing&&(this.stream.diagnostics.displayed||this.stream.diagnostics.bufferedFrames>0))return;
    // Worker/module startup is loading time, not an instruction to animate the
    // city seconds in the past forever. Only the first, never-displayed window
    // is anchored here; live source updates never re-anchor retained traffic.
    if(!this.firstSampleRequested){this.stream=new GameMotionStream(this.latestSeconds);this.firstSampleRequested=true;}
    const request=this.stream.request();if(!request)return;
    this.post({type:'sample',requestId:this.nextWireId++,generation:this.generation,sourceRevision:this.configuredRevision,
      timeSeconds:request.timeSeconds,horizonSeconds:request.horizonSeconds},request.requestId);
  }
  private receive=(event:MessageEvent<GameMotionResponse>)=>{
    if(this.disposed||this.failure)return;
    const response=event.data,flight=this.flight;
    if(!flight||response.requestId!==flight.wireId)return;
    this.flight=null;this.roundTripMaxMs=Math.max(this.roundTripMaxMs,this.now()-flight.started);
    if(response.generation!==this.generation||flight.generation!==this.generation){this.pump();return;}
    if(response.type==='error'||response.type==='rejected'){this.fail(response.message);return;}
    if(response.sourceRevision!==flight.revision){this.fail('Movement source revision mismatch');return;}
    if(response.type==='configured'){
      this.acknowledgedSource=flight.source??null;
      this.configuredRevision=response.sourceRevision;this.sources.clear();this.sources.set(response.sourceRevision,response.diagnostics);
      for(const key of this.membership.keys())if(key!==response.sourceRevision)this.membership.delete(key);
      // Cold paused loading has never advanced the retained solver beyond the
      // frozen time. Refresh that same instant as partial source pages arrive,
      // preserving queues and already known identities. After actual playback
      // starts, its future windows instead stay ordered through a later pause.
      if(!this.hasPlayed&&!this.playing){this.stream=new GameMotionStream(this.latestSeconds);this.firstSampleRequested=false;}
    }else if(response.type==='sample'&&flight.sampleId!==undefined){
      const diagnostics=this.sources.get(response.sourceRevision);
      if(!diagnostics){this.fail('Movement source diagnostics unavailable');return;}
      // Structured clone creates new membership arrays on each sample. Retain
      // these small immutable columns by source revision so GameActors can keep
      // its meshes, canonical pick mappings and LOD membership cache.
      const columns=response.columns,key=response.sourceRevision;
      let membership=this.membership.get(key);
      if(!membership){membership={ids:columns.ids,kinds:columns.kinds,seeds:columns.seeds,pickable:columns.pickable};this.membership.set(key,membership);}
      else if(membership.ids.length!==columns.ids.length||membership.kinds.length!==columns.kinds.length||membership.seeds.length!==columns.seeds.length
        ||Boolean(membership.pickable)!==Boolean(columns.pickable)||membership.pickable?.length!==columns.pickable?.length
        ||membership.ids.some((id,i)=>id!==columns.ids[i]||membership!.kinds[i]!==columns.kinds[i]||membership!.seeds[i]!==columns.seeds[i]||membership!.pickable?.[i]!==columns.pickable?.[i])){
        this.fail('Movement membership changed without a source revision');return;
      }
      Object.assign(columns,membership,{membershipRevision:`${this.generation}:${key}`});
      try{this.stream.accept({...response,requestId:flight.sampleId,diagnostics});}
      catch(error){this.fail(error instanceof Error?error.message:'Invalid movement window');return;}
      // These maps also cover the five queued samples and current display.
      while(this.sources.size>8)this.sources.delete(this.sources.keys().next().value!);
      while(this.membership.size>8)this.membership.delete(this.membership.keys().next().value!);
      this.options.onDirty();
    }else{this.fail('Unexpected movement worker reply');return;}
    // Completion can refill a bounded queue without waiting for another render;
    // this does not add a RAF, timer, or advance the actor presentation clock.
    this.pump();
  };
  private fail(message:string){this.failure=message;this.flight=null;this.options.onError(message);}
  private onPortError=()=>this.fail('Movement worker unavailable');
  get frame(){return this.displayed;}
  get diagnostics(){return {...this.stream.diagnostics,generation:this.generation,sourceRevision:this.revision,
    configuredRevision:this.configuredRevision,displayedRevision:this.displayed?.sourceRevision??0,
    sourcePending:Boolean(this.pendingSource)||this.configuredRevision!==this.revision||this.displayed?.sourceRevision!==this.revision,
    roundTripMaxMs:this.roundTripMaxMs,postMaxMs:this.postMaxMs,postedMessages:this.posted,error:this.failure};}
  dispose():void{
    if(this.disposed)return;this.disposed=true;this.port.removeEventListener('message',this.receive);
    this.port.removeEventListener('error',this.onPortError);this.port.removeEventListener('messageerror',this.onPortError);
    this.port.terminate();this.sources.clear();this.membership.clear();this.pendingSource=null;this.latestSource=null;
    this.acknowledgedSource=null;
    this.flight=null;this.displayed=null;this.stream=new GameMotionStream(this.stream.diagnostics.presentationSeconds);
  }
}
