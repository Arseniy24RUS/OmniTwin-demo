import {describe,expect,it,vi} from 'vitest';
import {GameShaderReadiness} from './GameShaderReadiness';
import {chooseBuildingFrontier} from './buildingFrontier';

const deferred=()=>{let resolve!:()=>void,reject!:(error:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
describe('complete shader readiness before canonical ownership',()=>{
 it('keeps a slow replacement unready while the existing committed program stays drawable',async()=>{
  const old=deferred(),next=deferred(),onChange=vi.fn();
  const gate=new GameShaderReadiness<string>({prepare:value=>({promise:value==='old'?old.promise:next.promise,cancel:vi.fn()}),onChange,maxPending:2,maxEntries:8});
  gate.stage('old','old');old.resolve();await settle();expect(gate.isReady('old')).toBe(true);
  gate.stage('next','next');expect(gate.isReady('next')).toBe(false);expect(gate.isReady('old')).toBe(true);
  expect(gate.diagnostics.pending).toBe(1);next.resolve();await settle();expect(gate.isReady('next')).toBe(true);expect(gate.diagnostics.ready).toBe(2);
 });
 it('requires all main, scratch-colour and shadow passes, including rejection',async()=>{
  const main=deferred(),scratch=deferred(),shadow=deferred();
  const gate=new GameShaderReadiness<string>({prepare:()=>({promise:Promise.all([main.promise,scratch.promise,shadow.promise]).then(()=>{}),cancel:vi.fn()}),onChange:vi.fn(),maxPending:2,maxEntries:8});
  gate.stage('cell','cell');main.resolve();scratch.resolve();await settle();expect(gate.isReady('cell')).toBe(false);
  shadow.reject(Error('shadow link failed'));await settle();expect(gate.isReady('cell')).toBe(false);expect(gate.diagnostics.failed).toBe(1);expect(gate.diagnostics.lastError).toContain('shadow link failed');
 });
 it('bounds active work, deduplicates keys and starts the next job only after completion',async()=>{
  const jobs=[deferred(),deferred(),deferred()],prepare=vi.fn((value:number)=>({promise:jobs[value]!.promise,cancel:vi.fn()}));
  const gate=new GameShaderReadiness<number>({prepare,onChange:vi.fn(),maxPending:2,maxEntries:3});
  gate.stage('a',0);gate.stage('b',1);gate.stage('c',2);gate.stage('a',0);
  expect(prepare).toHaveBeenCalledTimes(2);expect(gate.diagnostics.pending).toBe(2);expect(gate.diagnostics.queued).toBe(1);expect(()=>gate.stage('overflow',3)).toThrow(/budget/);
  jobs[0]!.resolve();await settle();expect(prepare).toHaveBeenCalledTimes(3);expect(gate.diagnostics.pending).toBe(2);
 });
 it('never promotes a disposed or replaced generation after an old async job resolves',async()=>{
  const first=deferred(),second=deferred(),cancel=vi.fn(),change=vi.fn();let call=0;
  const gate=new GameShaderReadiness<string>({prepare:()=>({promise:call++?second.promise:first.promise,cancel}),onChange:change,maxPending:2,maxEntries:8});
  gate.stage('cell','old');gate.release('cell');gate.stage('cell','new');first.resolve();await settle();expect(gate.isReady('cell')).toBe(false);
  gate.dispose();const count=change.mock.calls.length;second.resolve();await settle();expect(gate.isReady('cell')).toBe(false);expect(cancel).toHaveBeenCalledTimes(2);expect(change).toHaveBeenCalledTimes(count);expect(gate.diagnostics.pending).toBe(0);
 });
 it('records synchronous preparation failure and preserves previously ready entries',async()=>{
  const gate=new GameShaderReadiness<string>({prepare:value=>{if(value==='bad')throw Error('compile rejected');return{promise:Promise.resolve(),cancel:vi.fn()};},onChange:vi.fn(),maxPending:2,maxEntries:8});
  gate.stage('old','good');await settle();gate.stage('bad','bad');await settle();expect(gate.isReady('old')).toBe(true);expect(gate.isReady('bad')).toBe(false);expect(gate.diagnostics.failed).toBe(1);
 });
 it('does not retain ready entries across many evicted cells',async()=>{
  const gate=new GameShaderReadiness<number>({prepare:()=>({promise:Promise.resolve(),cancel:vi.fn()}),onChange:vi.fn(),maxPending:2,maxEntries:3});
  for(let index=0;index<200;index++){const key=String(index);gate.stage(key,index);await settle();expect(gate.diagnostics.ready).toBe(1);gate.release(key);expect(gate.diagnostics.ready).toBe(0);}
  expect(gate.diagnostics.pending).toBe(0);expect(gate.diagnostics.queued).toBe(0);
 });
 it('retains old detail only while compilation waits, then permits a coarse zoom-out frontier',async()=>{
  const pending=deferred();
  const gate=new GameShaderReadiness<string>({prepare:value=>({promise:value==='loading'?pending.promise:Promise.resolve(),cancel:vi.fn()}),onChange:vi.fn(),maxPending:2,maxEntries:4});
  gate.stage('coarse','ready');gate.stage('detail','ready');await settle();gate.stage('loading','loading');
  const inventory=[{key:'coarse',parentKey:null,canonicalIds:['a','b'],drawable:true},{key:'detail',parentKey:'coarse',canonicalIds:['a'],drawable:true}];
  expect(chooseBuildingFrontier(inventory,['coarse',...gate.retainWhilePending(['detail'])],'',true).tileKeys).toEqual(['detail']);
  pending.resolve();await settle();expect(chooseBuildingFrontier(inventory,['coarse',...gate.retainWhilePending(['detail'])],'',true).tileKeys).toEqual(['coarse']);
 });
});
