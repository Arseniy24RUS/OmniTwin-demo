/** Bound the simulated path interval, not just its wall-clock duration.
 * Four simulated seconds at16x would turn intersections into long straight chords.
 * Work is still bounded by the scene's sole scheduler (maximum60 ticks/second).
 */
export function motionSamplingPolicy(speed:number){
  if(!Number.isFinite(speed)||speed<=0)throw new RangeError('Movement speed must be finite and positive');
  return {cadenceMs:200/Math.min(16,speed),horizonSeconds:.25};
}
