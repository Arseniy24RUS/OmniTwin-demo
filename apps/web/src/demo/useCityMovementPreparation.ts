import { useCallback, useEffect, useRef, useState } from 'react';
import type { RendererViewportSnapshot } from '../renderer/types';
import type { DemoContextV1 } from './types';
import type { StaticDemoProvider } from './data/StaticDemoProvider';
import type { MovementReadiness } from './data/CityDemoProviderV2';
import { movementContextKey } from './data/movementContinuity';

type PreparationProvider = Pick<StaticDemoProvider, 'prepareViewport'> & { readonly movementReadiness?: MovementReadiness };
export type CityMovementHandoff = 'overview' | 'preparing_detail' | 'detail_ready';
export interface CityMovementPreparationOptions {
  provider: PreparationProvider;
  context: DemoContextV1;
  viewport?: RendererViewportSnapshot | null;
  /** Settled viewport identity; omit to use viewport.revision or the camera pose. */
  revision?: string | number;
  onPrepared?: () => void;
  frameActorCount?: number;
}
export function cityMovementHandoff(individualRequested:boolean,resourcesReady:boolean,frameActorCount:number):CityMovementHandoff {
  return !individualRequested?'overview':resourcesReady&&Number.isFinite(frameActorCount)&&frameActorCount>0?'detail_ready':'preparing_detail';
}
/** Overview marks remain schematic flows; they never become fake resident IDs. */
export function retainCityOverviewFlows<T>(mode:CityMovementHandoff,current:T|null,previous:T|null):T|null {
  return mode==='detail_ready'?null:mode==='preparing_detail'?previous??current:current??previous;
}
/** UI clocks may wrap at midnight while provider validity is unwrapped. */
function timeNearWindow(minutes:number,start:number):number {
  return minutes>=0&&minutes<1440?minutes+Math.round((start-minutes)/1440)*1440:minutes;
}
function fresh(readiness:MovementReadiness|null,contextKey:string,minutes:number):boolean {
  const committed=readiness?.committed;if(!committed||committed.contextKey!==contextKey)return false;
  const now=timeNearWindow(minutes,committed.validFromMinutes);
  return now>=committed.validFromMinutes-1e-8&&now<=committed.validUntilMinutes+1e-8;
}
interface PreparationState {
  provider:PreparationProvider|null; scopeKey:string; resolved:boolean;
  status:'loading'|'ready'|'error'; error:string; preparedRevision:number;
}

/**
 * Serialize viewport preparation independently of presentation-clock renders.
 * Only provider/semantic-context/settled-viewport changes abort a request.
 * A slow result keeps its original validity; follow-up reads the latest clock.
 */
export function useCityMovementPreparation(options:CityMovementPreparationOptions) {
  const {provider,context,viewport}=options;
  const contextKey=movementContextKey(context);
  const individualRequested=context.camera.zoom>=15.5;
  const camera=viewport?.camera??context.camera;
  const viewportKey=options.revision??viewport?.revision??JSON.stringify([camera.longitude,camera.latitude,camera.zoom,camera.pitch,camera.bearing]);
  const scopeKey=JSON.stringify([contextKey,viewportKey,individualRequested]);
  const latest=useRef({...options,scopeKey,contextKey,individualRequested});
  latest.current={...options,scopeKey,contextKey,individualRequested};
  const machine=useRef<{pump:(force?:boolean)=>void}|null>(null);
  const revisions=useRef(0);
  const [state,setState]=useState<PreparationState>({provider:null,scopeKey:'',resolved:false,status:'loading',error:'',preparedRevision:0});

  useEffect(()=>{
    let alive=true,inFlight=false,resolved=false,failed=false;
    let controller:AbortController|null=null;
    const matching=()=>alive&&latest.current.provider===provider&&latest.current.scopeKey===scopeKey;
    const needsRefresh=()=>{
      const current=latest.current;if(!resolved)return true;
      if(!current.individualRequested)return false;
      const readiness=provider.movementReadiness;
      // Legacy providers hold their complete small dataset, not a temporal pool.
      if(!readiness)return false;
      if(!fresh(readiness,current.contextKey,current.context.presentationMinutes))return true;
      const committed=readiness.committed!;
      return committed.validUntilMinutes-timeNearWindow(current.context.presentationMinutes,committed.validFromMinutes)<=0.5+1e-8;
    };
    const pump=(force=false)=>{
      if(!matching()||inFlight||failed&&!force||!force&&!needsRefresh())return;
      const current=latest.current;
      const requestContext={...current.context,camera:current.viewport?.camera??current.context.camera};
      const requestViewport=current.viewport??undefined;
      controller=new AbortController();const activeController=controller;
      inFlight=true;failed=false;
      setState(previous=>({...previous,provider,scopeKey,resolved,status:'loading',error:''}));
      void (async()=>{
        try {
          await provider.prepareViewport(requestContext,activeController.signal,requestViewport);
          if(!matching()||activeController.signal.aborted)return;
          resolved=true;const preparedRevision=++revisions.current;
          setState({provider,scopeKey,resolved:true,status:'ready',error:'',preparedRevision});
          latest.current.onPrepared?.();
        }catch(error){
          if(!matching()||activeController.signal.aborted)return;
          failed=true;
          setState(previous=>({...previous,provider,scopeKey,resolved,status:'error',error:error instanceof Error?error.message:'Городские данные временно недоступны'}));
        }finally{
          if(matching()){
            inFlight=false;controller=null;
            // One serialized follow-up at the newest time. Never shift an old
            // committed window or restart the same expired timestamp forever.
            if(!failed&&requestContext.presentationMinutes!==latest.current.context.presentationMinutes&&needsRefresh()){
              void Promise.resolve().then(()=>pump());
            }
          }
        }
      })();
    };
    machine.current={pump};pump(true);
    return()=>{alive=false;controller?.abort();if(machine.current?.pump===pump)machine.current=null;};
  },[provider,scopeKey]);

  // Clock updates request work but do not own its lifetime/AbortController.
  const clockBucket=Math.floor(context.presentationMinutes*12);
  useEffect(()=>{machine.current?.pump();},[scopeKey,clockBucket,context.playing,context.speed]);
  const retry=useCallback(()=>machine.current?.pump(true),[]);
  const sameScope=state.provider===provider&&state.scopeKey===scopeKey;
  const readiness=provider.movementReadiness??null;
  const resourcesReady=sameScope&&state.resolved&&(!individualRequested||!readiness||fresh(readiness,contextKey,context.presentationMinutes));
  // Expired retention means some new entrants may still be missing, not that
  // already committed residents lost their canonical current-time positions.
  // Provider/context/settled-camera changes invalidate this independently of time.
  const lastCommittedRenderable=sameScope&&state.resolved&&(!individualRequested||!readiness||readiness.committed?.contextKey===contextKey);
  const updating=lastCommittedRenderable&&(!resourcesReady||state.status==='loading');
  const handoff=cityMovementHandoff(individualRequested,lastCommittedRenderable,options.frameActorCount??0);
  return {status:sameScope?state.status:'loading' as const,error:sameScope?state.error:'',readiness,resourcesReady,lastCommittedRenderable,updating,
    detailReady:handoff==='detail_ready',handoff,preparedRevision:state.preparedRevision,retry};
}
