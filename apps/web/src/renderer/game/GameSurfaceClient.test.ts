import {describe,expect,it,vi} from 'vitest';
import {GameSurfaceClient,type GameSurfacePort} from './GameSurfaceClient';
import type {GameSurfaceJob,GameSurfaceRequest,GameSurfaceResponse} from './gameSurfaceProtocol';
class Port implements GameSurfacePort {
  messages:GameSurfaceRequest[]=[];listeners=new Map<string,Set<(event:never)=>void>>();terminated=false;
  postMessage(message:GameSurfaceRequest){this.messages.push(message);}
  addEventListener(type:string,listener:(event:never)=>void){const list=this.listeners.get(type)??new Set();list.add(listener);this.listeners.set(type,list);}
  removeEventListener(type:string,listener:(event:never)=>void){this.listeners.get(type)?.delete(listener);}
  terminate(){this.terminated=true;}
  reply(message:GameSurfaceResponse){for(const fn of this.listeners.get('message')??[])fn({data:message} as never);}
  complete(index:number){const message=this.messages[index]!;this.reply({type:'prepared',requestId:message.requestId,generation:message.generation,
    results:message.jobs.map(job=>({kind:job.kind,status:'retained' as const,reason:'loading' as const}))} as GameSurfaceResponse);}
}
const origin={longitude:61.4,latitude:55.16};
const land=(revision:number):GameSurfaceJob=>({kind:'landCover',features:[],options:{origin,datasetVersion:`source-${revision}`},previousRetainedBytes:0});
const road=(revision:number):GameSurfaceJob=>({kind:'roads',roads:[],options:{origin,bounds:[61,55,62,56],buildings:null,loading:revision<0}});
describe('bounded surface preparation client',()=>{
  it('coalesces a hundred camera refreshes without applying an obsolete surface or starving another kind',()=>{
    const port=new Port(),applied=vi.fn(),errors=vi.fn(),client=new GameSurfaceClient(port,{onResults:applied,onError:errors});
    client.request([land(0)]);
    for(let i=1;i<=100;i++)client.request([land(i),road(i)]);
    expect(port.messages).toHaveLength(1);expect(client.diagnostics.pendingKinds).toEqual(['landCover','roads']);
    port.complete(0);expect(applied).not.toHaveBeenCalled();expect(port.messages).toHaveLength(2);
    expect(port.messages[1]!.jobs).toEqual([land(100),road(100)]);
    port.complete(1);expect(applied).toHaveBeenCalledOnce();expect(applied.mock.calls[0]![0].map((row:{job:GameSurfaceJob})=>row.job)).toEqual([land(100),road(100)]);
    expect(client.diagnostics.discardedResults).toBe(1);expect(client.diagnostics.inFlight).toBe(false);expect(errors).not.toHaveBeenCalled();client.dispose();
  });
  it('keeps the current independent family when only another result has been superseded',()=>{
    const port=new Port(),applied=vi.fn(),client=new GameSurfaceClient(port,{onResults:applied,onError:vi.fn()});
    client.request([land(1),road(1)]);client.request([land(2)]);port.complete(0);
    expect(applied.mock.calls[0]![0].map((row:{job:GameSurfaceJob})=>row.job.kind)).toEqual(['roads']);
    expect(port.messages[1]!.jobs).toEqual([land(2)]);port.complete(1);expect(applied).toHaveBeenCalledTimes(2);client.dispose();
  });
  it('fails closed on a corrupt result inventory and reports retained jobs without a synchronous fallback',()=>{
    const port=new Port(),applied=vi.fn(),errors=vi.fn(),client=new GameSurfaceClient(port,{onResults:applied,onError:errors});
    client.request([land(1),road(1)]);port.reply({type:'prepared',requestId:1,generation:1,results:[]} as GameSurfaceResponse);
    expect(applied).not.toHaveBeenCalled();expect(errors.mock.calls[0]![1]).toEqual([land(1),road(1)]);
    expect(client.diagnostics.error).toContain('inventory');client.request([land(2)]);expect(port.messages).toHaveLength(1);
    expect(errors.mock.calls[1]![1]).toEqual([land(2)]);client.dispose();
  });
  it('ignores unrelated replies and releases all queued work/listeners on disposal',()=>{
    const port=new Port(),applied=vi.fn(),client=new GameSurfaceClient(port,{onResults:applied,onError:vi.fn()});
    client.request([land(1)]);client.request([road(2)]);
    port.reply({type:'prepared',requestId:999,generation:1,results:[]} as GameSurfaceResponse);expect(client.diagnostics.inFlight).toBe(true);
    client.dispose();port.complete(0);client.request([land(3)]);
    expect(port.terminated).toBe(true);expect([...port.listeners.values()].every(set=>!set.size)).toBe(true);
    expect(client.diagnostics.inFlight).toBe(false);expect(client.diagnostics.pendingKinds).toEqual([]);expect(applied).not.toHaveBeenCalled();expect(port.messages).toHaveLength(1);
  });
});
