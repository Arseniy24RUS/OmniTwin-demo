import {describe,expect,it,vi} from 'vitest';
import {BoxGeometry,DoubleSide,Group,Mesh,MeshStandardMaterial} from 'three';
import {GameObjectShaderReadiness} from './GameObjectShaderReadiness';

function fixture(){const jobs:{resolve:()=>void;reject:(e:Error)=>void;cancel:ReturnType<typeof vi.fn>;objects:readonly object[]}[]=[];
 const changed=vi.fn(),gate=new GameObjectShaderReadiness({maxObjects:32,onChange:changed,prepare:objects=>{
  let resolve!:()=>void,reject!:(e:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
  const cancel=vi.fn(()=>reject(new Error('cancelled')));jobs.push({resolve,reject,cancel,objects});return{promise,cancel};
 }});return{gate,jobs,changed};}
const mesh=()=>new Mesh(new BoxGeometry(),new MeshStandardMaterial());
const tick=async()=>{await Promise.resolve();await Promise.resolve();};
describe('late auxiliary object shader ownership',()=>{
 it('withholds a late surface before both render passes while an incumbent remains visible',async()=>{
  const f=fixture(),root=new Group(),old=mesh();root.add(old);f.gate.stage([root]);expect(old.visible).toBe(false);
  f.jobs[0]!.resolve();await tick();expect(old.visible).toBe(true);
  const next=mesh();root.add(next);f.gate.stage([root]);expect(old.visible).toBe(true);expect(next.visible).toBe(false);expect(f.gate.isReady(root)).toBe(false);
  next.visible=true;f.gate.enforce();expect(next.visible).toBe(false);
  f.jobs[1]!.resolve();await tick();expect(next.visible).toBe(true);expect(f.gate.isReady(root)).toBe(true);
 });
 it('reuses the same material and vertex layout across geometry and source refreshes',async()=>{
  const f=fixture(),root=new Group(),item=mesh();root.add(item);f.gate.stage([root]);f.jobs[0]!.resolve();await tick();
  item.geometry=new BoxGeometry(2,3,4);for(let i=0;i<30;i++)f.gate.stage([root]);
  expect(f.jobs).toHaveLength(1);expect(item.visible).toBe(true);expect(f.gate.diagnostics.pendingMeshes).toBe(0);
  const replacement=new Mesh(new BoxGeometry(),item.material);root.remove(item);root.add(replacement);f.gate.stage([root]);
  expect(f.jobs).toHaveLength(1);expect(replacement.visible).toBe(true);
 });
 it('cancels stale batches after replacement and cannot re-admit disposed objects',async()=>{
  const f=fixture(),root=new Group(),first=mesh();root.add(first);f.gate.stage([root]);root.remove(first);
  const second=mesh();root.add(second);f.gate.stage([root]);expect(f.jobs[0]!.cancel).toHaveBeenCalledOnce();
  f.jobs[0]!.resolve();await tick();expect(second.visible).toBe(false);f.jobs[1]!.resolve();await tick();
  expect(second.visible).toBe(true);expect(f.gate.diagnostics.readyMeshes).toBe(1);
 });
 it('prepares replacement caster depth ownership even when its pooled colour material is ready',async()=>{
  const f=fixture(),root=new Group(),first=mesh();first.castShadow=true;root.add(first);f.gate.stage([root]);f.jobs[0]!.resolve();await tick();
  const next=new Mesh(new BoxGeometry(),first.material);next.castShadow=true;root.remove(first);root.add(next);f.gate.stage([root]);
  expect(f.jobs).toHaveLength(2);expect(next.visible).toBe(false);f.jobs[1]!.resolve();await tick();expect(next.visible).toBe(true);
 });
 it('keeps failed new surfaces hidden and preserves explicit owner-hidden visibility',async()=>{
  const f=fixture(),root=new Group(),item=mesh();item.visible=false;root.add(item);f.gate.stage([root]);f.jobs[0]!.resolve();await tick();expect(item.visible).toBe(false);
  item.material=new MeshStandardMaterial();f.gate.stage([root]);f.jobs[1]!.reject(Error('driver link failed'));await tick();
  expect(item.visible).toBe(false);expect(f.gate.diagnostics.failedMeshes).toBe(1);expect(f.gate.diagnostics.lastError).toContain('driver link failed');
 });
 it('does not loop when Three precompile increments transparent material versions',async()=>{
  let finish!:()=>void;const item=mesh(),prepare=vi.fn(()=>{item.material.needsUpdate=true;return{promise:new Promise<void>(resolve=>{finish=resolve;}),cancel:vi.fn()};});
  const gate=new GameObjectShaderReadiness({prepare,onChange:vi.fn(),maxObjects:8});gate.stage([item]);finish();await tick();gate.stage([item]);expect(prepare).toHaveBeenCalledOnce();
  item.material.needsUpdate=true;gate.stage([item]);expect(prepare).toHaveBeenCalledTimes(2);
 });
 it('does not restage double-sided transparent actors after Three ordinary render bumps',async()=>{
  const f=fixture(),item=mesh();item.material.transparent=true;item.material.side=DoubleSide;
  f.gate.stage([item]);f.jobs[0]!.resolve();await tick();
  for(let frame=0;frame<10;frame++){item.material.needsUpdate=true;item.material.needsUpdate=true;f.gate.stage([item]);}
  expect(f.jobs).toHaveLength(1);expect(item.visible).toBe(true);
  item.material.defines={VISUAL_VARIANT:1};f.gate.stage([item]);expect(f.jobs).toHaveLength(2);
 });
 it('bounds object inventory and cancels without owning geometry/material disposal',async()=>{
  const f=fixture(),item=mesh(),geometryDispose=vi.spyOn(item.geometry,'dispose'),materialDispose=vi.spyOn(item.material,'dispose');
  f.gate.stage([item]);f.gate.dispose();await tick();expect(f.jobs[0]!.cancel).toHaveBeenCalledOnce();expect(item.visible).toBe(true);
  expect(geometryDispose).not.toHaveBeenCalled();expect(materialDispose).not.toHaveBeenCalled();expect(f.gate.diagnostics.pendingMeshes).toBe(0);
  const limited=new GameObjectShaderReadiness({maxObjects:1,prepare:vi.fn(),onChange:vi.fn()});expect(()=>limited.stage([mesh(),mesh()])).toThrow(/budget/);
 });
});
