/** Shared by the browser predicate and offline tests; no DOM/module closures. */
export function isSettledCityGraphics(value){
 const shader=value?.shaders,motion=value?.motionWorker,surface=value?.surfaceWorker,refresh=value?.surfaceRefresh;
 return Boolean(value&&value.source>0&&value.bankState==='canonical'&&!value.bankPending&&value.state==='rendering'&&value.mesh>0&&value.renderedVisibleTiles>0
  &&!value.loading&&value.actorsState==='ready'&&value.actorsVisible&&value.shadowReady
  &&shader&&shader.pending===0&&shader.queued===0&&shader.failed===0&&shader.pendingObjects===0&&shader.environmentReady===true
  &&motion?.mode==='worker_buffered'&&motion.displayed===true&&motion.underflow===false&&!motion.error
  &&surface?.mode==='worker_prepared'&&surface.inFlight===false&&Array.isArray(surface.pendingKinds)&&surface.pendingKinds.length===0&&!surface.error
  &&refresh?.dirty===false&&refresh.failures===0);
}
