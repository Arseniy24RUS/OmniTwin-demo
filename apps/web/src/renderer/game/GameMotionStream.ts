interface MotionWindow {readonly requestId:number;readonly columns:{readonly previousTime:number;readonly currentTime:number}}
interface Request {readonly requestId:number;readonly timeSeconds:number;readonly horizonSeconds:number}
// Touching intervals preserve exact predicted→actual endpoints at signal
// release, route entry and endpoint reversal. Overlapping .2/.25 intervals can
// re-interpolate a late reply at a different position (up to .8 m in fixtures).
const STEP=.25,HORIZON=.25,MAX_READY=5,EPSILON=1e-7;

/** Ordered, bounded presentation buffer. The existing scene scheduler owns time;
 * worker replies only add complete actor/signal windows. Under load the shared
 * actor clock holds at verified coverage, never extrapolates or catches up in a
 * jump. Its lag relative to the independent world clock is explicit. */
export class GameMotionStream<T extends MotionWindow> {
  private readonly ready:T[]=[];
  private pending:Request|null=null;
  private nextId=1;
  private nextTime:number;
  private time:number;
  private end:number;
  private displayed=false;
  private lastWall:number|null=null;
  private playing=false;
  private lag=0;
  private underflow=false;
  private catchupMultiplier=1;
  constructor(startSeconds:number){
    if(!Number.isFinite(startSeconds))throw Error('Invalid motion start time');
    this.nextTime=this.time=this.end=startSeconds;
  }
  request():Request|null{
    if(this.pending||this.ready.length>=MAX_READY||this.nextTime-this.time>STEP*(MAX_READY-1)+EPSILON)return null;
    return this.pending={requestId:this.nextId++,timeSeconds:this.nextTime,horizonSeconds:HORIZON};
  }
  accept(frame:T):void{
    const request=this.pending;
    if(!request||frame.requestId!==request.requestId)throw Error('Unexpected motion request reply');
    const {previousTime,currentTime}=frame.columns;
    if(!Number.isFinite(previousTime)||!Number.isFinite(currentTime)
      ||Math.abs(previousTime-request.timeSeconds)>EPSILON
      ||Math.abs(currentTime-previousTime-request.horizonSeconds)>EPSILON)throw Error('Invalid motion reply interval');
    this.ready.push(frame);this.nextTime=request.timeSeconds+STEP;this.pending=null;
  }
  tick(wallMs:number,authoritativeSeconds:number,playing:boolean,speed:number):{timeSeconds:number;frames:T[]}{
    if(![wallMs,authoritativeSeconds,speed].every(Number.isFinite)||speed<=0)throw Error('Invalid motion clock');
    const delta=this.lastWall===null||!this.playing||!playing||!this.displayed?0:Math.max(0,wallMs-this.lastWall)/1000*speed;
    // Update even on underflow: a late reply must not consume the whole stalled
    // wall interval and teleport every actor forward at once.
    this.lastWall=wallMs;this.playing=playing;
    const available=this.ready.at(-1)?.columns.currentTime??this.end;
    // Recover ordinary worker latency gradually using the same safe motion and
    // signal timeline. This explicit <=10% presentation pacing never changes
    // source routes/speeds or jumps past a missing slice. It cannot compensate
    // for sustained solver overload, which remains visible as lag/underflow.
    const extra=playing?Math.min(delta*.1,Math.max(0,authoritativeSeconds-this.time-delta-.15),Math.max(0,available-this.time-delta)):0;
    this.catchupMultiplier=delta>0?1+extra/delta:1;
    const target=Math.min(this.time+delta+extra,authoritativeSeconds);
    this.time=Math.max(this.time,Math.min(target,authoritativeSeconds,available));
    this.lag=Math.max(0,authoritativeSeconds-this.time);
    this.underflow=playing&&target>available+EPSILON;
    const frames:T[]=[];
    while(this.ready.length&&this.ready[0]!.columns.previousTime<=this.time+EPSILON){
      const frame=this.ready.shift()!;frames.push(frame);this.end=frame.columns.currentTime;this.displayed=true;
    }
    return {timeSeconds:this.time,frames};
  }
  get diagnostics(){return {mode:'worker_buffered' as const,bufferedFrames:this.ready.length,inFlight:Boolean(this.pending),
    displayed:this.displayed,presentationSeconds:this.time,availableUntilSeconds:this.ready.at(-1)?.columns.currentTime??this.end,
    lagSeconds:this.lag,underflow:this.underflow,catchupMultiplier:this.catchupMultiplier,
    maximumCatchupMultiplier:1.1,maximumBufferedFrames:MAX_READY,stepSeconds:STEP,horizonSeconds:HORIZON};}
}
