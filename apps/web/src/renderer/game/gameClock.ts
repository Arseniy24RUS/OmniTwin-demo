export interface GameClockInput {seconds:number;playing:boolean;speed:number;seekRevision:number}

/** Authoritative clock props are samples, not a command to rewind on every render. */
export class GamePresentationClock {
  private input:GameClockInput;
  private seconds:number;
  private wall:number;
  constructor(input:GameClockInput,wall:number){this.input={...input};this.seconds=input.seconds;this.wall=wall;}
  get playing(){return this.input.playing;}
  get speed(){return this.input.speed;}
  read(wall:number){return this.seconds+(this.input.playing?Math.max(0,wall-this.wall)/1000*this.input.speed:0);}
  update(input:GameClockInput,wall:number){
    const sampleChanged=input.seconds!==this.input.seconds||input.seekRevision!==this.input.seekRevision;
    const controlsChanged=input.playing!==this.input.playing||input.speed!==this.input.speed;
    if(sampleChanged||controlsChanged){
      const progressed=this.read(wall);
      const explicitSeek=input.seekRevision!==this.input.seekRevision;
      // Periodic parent samples can lag after a control change or timer jitter.
      // Only a seek (or an edited paused sample) may rewind rendered time.
      this.seconds=explicitSeek?input.seconds:sampleChanged
        ?(!this.input.playing&&!input.playing?input.seconds:Math.max(progressed,input.seconds))
        :progressed;
      this.wall=wall;this.input={...input};
    }
  }
}
