/** Body orientation only. Route positions, traffic queues and source headings
 * remain untouched; the scalar simulation clock drives every rendered sample. */
export const GAME_HEADING_POLICY=Object.freeze({representation:'visual_synthesis',maxRadiansPerSecond:Math.PI*2/3,minimumDurationSeconds:.16});
export interface GameHeadingState{from:number;delta:number;start:number;duration:number;target:number;lastSample:number;epoch?:number|string}
const TAU=Math.PI*2;
export function shortestHeadingDelta(from:number,to:number):number{
  const wrapped=((to-from+Math.PI)%TAU+TAU)%TAU-Math.PI;return wrapped===-Math.PI?Math.PI:wrapped;
}
export function sampleGameHeading(state:Pick<GameHeadingState,'from'|'delta'|'start'|'duration'>,time:number):number{
  const alpha=Math.min(1,Math.max(0,(time-state.start)/Math.max(.0001,state.duration)));
  return state.from+state.delta*alpha*alpha*(3-2*alpha);
}
/** A sample can retarget an ongoing turn without restarting an unchanged one.
 * Explicit seek/context revisions reset immediately, even for a tiny time seek. */
export function updateGameHeading(state:GameHeadingState|undefined,target:number,time:number,epoch?:number|string):GameHeadingState{
  if(!Number.isFinite(target)||!Number.isFinite(time))throw Error('Invalid actor heading sample');
  target=shortestHeadingDelta(0,target);
  if(!state)return {from:target,delta:0,start:time,duration:0,target,lastSample:time,epoch};
  if(state.epoch!==epoch||time<state.lastSample||epoch===undefined&&time-state.lastSample>30){
    Object.assign(state,{from:target,delta:0,start:time,duration:0,target,lastSample:time,epoch});return state;
  }
  state.lastSample=time;
  if(Math.abs(shortestHeadingDelta(state.target,target))<1e-6)return state;
  const from=shortestHeadingDelta(0,sampleGameHeading(state,time)),delta=shortestHeadingDelta(from,target);
  // Cubic easing peaks at 1.5 * angle/duration. Account for that factor so the
  // advertised limit is the actual maximum, including a source endpoint reversal.
  Object.assign(state,{from,delta,start:time,duration:Math.max(GAME_HEADING_POLICY.minimumDurationSeconds,1.5*Math.abs(delta)/GAME_HEADING_POLICY.maxRadiansPerSecond),target});
  return state;
}
