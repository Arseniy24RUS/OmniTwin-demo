export interface GameSurfaceRefreshOptions {
  setActive(active:boolean):void;
  isReady():boolean;
  flush():void;
  onError?(error:unknown):void;
}
/** Dirty work belongs to the existing frame scheduler, never a second timer/RAF. */
export class GameSurfaceRefresh {
  readonly telemetry={dirty:false,invalidations:0,flushes:0,failures:0,lastFlushMs:-Infinity,minimumIntervalMs:250};
  private disposed=false;
  constructor(private readonly options:GameSurfaceRefreshOptions){}
  mark():void{
    if(this.disposed)return;this.telemetry.dirty=true;this.telemetry.invalidations++;
    if(this.options.isReady())this.options.setActive(true);
  }
  frame(now:number):void{
    if(this.disposed)return;
    if(!this.telemetry.dirty||!this.options.isReady()){this.options.setActive(false);return;}
    if(now-this.telemetry.lastFlushMs<this.telemetry.minimumIntervalMs){this.options.setActive(true);return;}
    this.telemetry.dirty=false;this.telemetry.lastFlushMs=now;this.telemetry.flushes++;
    try{this.options.flush()}catch(error){this.telemetry.failures++;this.options.onError?.(error)}
    this.options.setActive(this.telemetry.dirty);
  }
  dispose():void{this.disposed=true;this.telemetry.dirty=false;this.options.setActive(false)}
}
