export interface GameShaderPreparation {promise:Promise<void>;cancel:()=>void}
type Status='queued'|'pending'|'ready'|'failed';
interface Entry<T>{value:T;status:Status;cancel?:(()=>void)}
/** Ownership stays outside this controller. A key becomes eligible only after
 * its entire colour/depth preparation resolves; cancellation never promotes it. */
export class GameShaderReadiness<T>{
 private readonly entries=new Map<string,Entry<T>>();private disposed=false;private failures=0;private lastError:string|null=null;
 constructor(private readonly options:{prepare:(value:T)=>GameShaderPreparation;onChange:(key:string,status:Status)=>void;maxPending:number;maxEntries:number}){
  if(!Number.isInteger(options.maxPending)||options.maxPending<1||options.maxPending>2||!Number.isInteger(options.maxEntries)||options.maxEntries<options.maxPending)throw Error('Invalid shader preparation budget');
 }
 stage(key:string,value:T):void{
  if(this.disposed)throw Error('Shader readiness disposed');if(this.entries.has(key))return;
  if(!key||this.entries.size>=this.options.maxEntries)throw Error('Shader entry budget exceeded');
  this.entries.set(key,{value,status:'queued'});this.pump();
 }
 isReady(key:string):boolean{return this.entries.get(key)?.status==='ready';}
 retainWhilePending(keys:readonly string[]):string[]{const {pending,queued}=this.diagnostics;return pending+queued?keys.filter(key=>this.isReady(key)):[];}
 release(key:string):void{const entry=this.entries.get(key);if(!entry)return;this.entries.delete(key);entry.cancel?.();this.pump();}
 dispose():void{if(this.disposed)return;this.disposed=true;for(const entry of this.entries.values())entry.cancel?.();this.entries.clear();}
 get diagnostics(){let pending=0,queued=0,ready=0;for(const entry of this.entries.values()){if(entry.status==='pending')pending++;if(entry.status==='queued')queued++;if(entry.status==='ready')ready++;}return{pending,queued,ready,failed:this.failures,lastError:this.lastError};}
 private pump():void{
  if(this.disposed)return;
  for(const [key,entry]of this.entries){
   if(this.diagnostics.pending>=this.options.maxPending)break;if(entry.status!=='queued')continue;
   entry.status='pending';
   const finish=(error?:unknown)=>{if(this.disposed||this.entries.get(key)!==entry)return;
    entry.cancel=undefined;entry.status=error?'failed':'ready';if(error){this.failures++;this.lastError=error instanceof Error?error.message:String(error);}
    this.options.onChange(key,entry.status);this.pump();};
   try{const job=this.options.prepare(entry.value);entry.cancel=job.cancel;void job.promise.then(()=>finish(),finish);}catch(error){finish(error);}
  }
 }
}
