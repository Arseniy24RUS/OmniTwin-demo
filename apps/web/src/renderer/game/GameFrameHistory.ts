/** Bounded DEV-only evidence of actual MapLibre renders. No RAF, timers or DOM writes. */
export class GameFrameHistory {
  private readonly times:Float64Array;
  private sequence=0;
  constructor(capacity=2048){
    if(!Number.isInteger(capacity)||capacity<2||capacity>16384)throw Error('Invalid frame history capacity');
    this.times=new Float64Array(capacity);
  }
  record(timeMs:number):void{
    if(!Number.isFinite(timeMs)||timeMs<0)throw Error('Invalid frame timestamp');
    this.times[this.sequence%this.times.length]=timeMs;this.sequence++;
  }
  read(afterSequence=this.sequence,nowMs=performance.now()){
    if(!Number.isSafeInteger(afterSequence)||afterSequence<0||afterSequence>this.sequence)throw Error('Invalid frame history cursor');
    const oldestSequence=Math.max(1,this.sequence-this.times.length+1);
    const from=Math.max(afterSequence+1,oldestSequence),samples:{sequence:number;timeMs:number}[]=[];
    for(let sequence=from;sequence<=this.sequence;sequence++)samples.push({sequence,timeMs:this.times[(sequence-1)%this.times.length]!});
    return {sequence:this.sequence,oldestSequence,dropped:afterSequence+1<oldestSequence,nowMs,samples};
  }
}
