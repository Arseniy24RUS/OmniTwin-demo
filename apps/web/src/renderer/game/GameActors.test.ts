import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GAME_ACTOR_CAPS, GAME_ACTOR_VERTEX_SHADER, GameActors, gameActorBodyMix, gameActorPose, type GameActorColumns, type GameActorManifest } from './GameActors';

const assets = new URL('../../../public/assets/game-actors-v1/', import.meta.url);
async function manifest() { return JSON.parse(await readFile(new URL('manifest.json', assets), 'utf8')) as GameActorManifest & { licenses: { url: string; sha256: string; spdx: string }[] }; }
function columns(count = 1): GameActorColumns {
  return { ids: Array.from({ length: count }, (_, i) => `fictional-${i}`), kinds: new Uint8Array(count), seeds: Uint32Array.from({ length: count }, (_, i) => i * 991), previousPositions: new Float32Array(count * 3), nextPositions: new Float32Array(count * 3), headings: new Float32Array(count), walking: new Uint8Array(count).fill(1), previousTime: 100, currentTime: 100.2 };
}
async function loadActors(tier: 'low' | 'mid' | 'high' = 'mid') {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); const name = url.pathname.split('/').at(-1)!;
    const bytes = await readFile(new URL(name, assets));
    return new Response(bytes, { status: 200, headers: { 'content-type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
  }));
  vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockResolvedValue(new THREE.Texture());
  const actors = new GameActors({ origin: [61.39466, 55.1654], tier, assetBaseUrl: 'http://example.test/assets/game-actors-v1/' });
  await actors.load(); return actors;
}
function camera(distance = 20) {
  const camera = new THREE.PerspectiveCamera(45, 1920 / 1080, 0.1, 10000);
  camera.position.set(0, 3, distance); camera.lookAt(0, 0.9, 0); camera.updateMatrixWorld(true); return camera;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('baked source-backed game actors', () => {
  it('ships actual four civil human and three vehicle templates with verified binary and licenses', async () => {
    const data = await manifest(); const bytes = await readFile(new URL(data.binary.url, assets));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(data.binary.sha256);
    expect(bytes.length).toBe(data.binary.bytes); expect(bytes.length).toBeLessThan(3 * 1024 * 1024);
    expect(data.models.filter((model) => model.kind === 'person')).toHaveLength(4);
    expect(data.models.filter((model) => model.kind === 'vehicle')).toHaveLength(3);
    for (const model of data.models) {
      expect(model.triangleCount).toBeLessThanOrEqual(model.kind === 'person' ? 1400 : 1000);
      expect(model.frameCount).toBe(model.kind === 'person' ? 24 : 1);
      expect(model.dimensions[model.kind === 'person' ? 'height' : 'length']).toBeCloseTo(model.kind === 'person' ? 1.8 : 4.5, 6);
      for (const slice of [model.positions, model.normals, model.colors, model.indices]) {
        expect(slice.byteOffset % 4).toBe(0); expect(slice.byteOffset + slice.byteLength).toBeLessThanOrEqual(bytes.length);
      }
      const values = new Float32Array(bytes.buffer, bytes.byteOffset + model.positions.byteOffset, model.positions.count);
      expect(values.every(Number.isFinite)).toBe(true);
      expect(model.kind === 'vehicle' || model.animation.walk.count > 1).toBe(true);
    }
    for (const license of data.licenses) {
      expect(license.spdx).toBe('CC0-1.0');
      expect(createHash('sha256').update(await readFile(new URL(license.url, assets))).digest('hex')).toBe(license.sha256);
    }
  });
  it('hands the distant glow to a recognizable body within four to eight CSS pixels', () => {
    expect(gameActorBodyMix(3)).toBe(0); expect(gameActorBodyMix(4)).toBe(0);
    expect(gameActorBodyMix(6)).toBeCloseTo(0.5); expect(gameActorBodyMix(8)).toBe(1);
    expect(() => gameActorBodyMix(Number.NaN)).toThrow();
    expect(GAME_ACTOR_VERTEX_SHADER).toContain('smoothstep(4.0, 8.0');
  });
  it('shows and picks the real pedestrian at a narrow courtyard scale without a dominant glow', async () => {
    const actors=await loadActors(),view=camera(200);view.aspect=494/674;view.updateProjectionMatrix();
    const foot=new THREE.Vector3().project(view),head=new THREE.Vector3(0,1.8,0).project(view);
    const cssHeight=Math.hypot((head.x-foot.x)*494/2,(head.y-foot.y)*674/2);
    expect(cssHeight).toBeGreaterThan(7);expect(cssHeight).toBeLessThan(8);
    actors.updateCamera(view,494,674);actors.updateColumns(columns());actors.setTime(100.1);
    expect(actors.telemetry.nearPeople).toBe(1);expect(gameActorBodyMix(cssHeight)).toBeGreaterThan(.9);
    const probe=actors.readMotionProbe(['fictional-0']).actors[0]!;
    expect(probe.near).toBe(true);expect(probe.meshName).not.toContain('sprite');
    expect(actors.pick(new THREE.Ray(new THREE.Vector3(0,1.1,10),new THREE.Vector3(0,0,-1)))?.id).toBe('fictional-0');
    actors.updateCamera(camera(1000),494,674);expect(actors.telemetry.nearPeople).toBe(0);
    expect(actors.readMotionProbe(['fictional-0']).actors[0]!.id).toBe('fictional-0');actors.dispose();
  });
  it('wraps interpolation inside each authored animation, including negative times', () => {
    const clip = { offset: 8, count: 16, duration: 1.2 };
    for (const seconds of [-200, -1, 0, 0.6, 200]) {
      const [a, b, blend] = gameActorPose(clip, seconds, 0.3);
      expect(a).toBeGreaterThanOrEqual(8); expect(a).toBeLessThan(24);
      expect(b).toBeGreaterThanOrEqual(8); expect(b).toBeLessThan(24);
      expect(blend).toBeGreaterThanOrEqual(0); expect(blend).toBeLessThan(1);
    }
  });
  it('retains instances and GPU buffers while the scalar clock advances', async () => {
    const actors = await loadActors(); actors.updateCamera(camera(), 1920, 1080);
    const data = columns(4); actors.updateColumns(data); actors.setTime(100.05);
    const meshes = actors.object.children as THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>[];
    const attributes = meshes.map((mesh) => mesh.geometry.getAttribute('actorPrevious'));
    const buffers = actors.telemetry.bufferUpdates, membership = actors.telemetry.membershipUpdates;
    for (let i = 0; i < 120; i++) actors.setTime(100 + i / 120 * 0.2);
    expect(actors.telemetry.bufferUpdates).toBe(buffers); expect(actors.telemetry.membershipUpdates).toBe(membership);
    expect(meshes.map((mesh) => mesh.geometry.getAttribute('actorPrevious'))).toEqual(attributes);
    expect(actors.telemetry.nearPeople).toBe(4);
    actors.dispose(); expect(actors.object.children).toHaveLength(0);
  });
  it('retains batch identity and does not upload unchanged stationary samples', async () => {
    const actors = await loadActors(); actors.updateCamera(camera(), 1920, 1080);
    const data = columns(4); data.walking.fill(0); actors.updateColumns(data);
    const meshes = actors.object.children as THREE.Mesh<THREE.InstancedBufferGeometry>[];
    const identities = meshes.map(mesh => mesh.userData.instanceIds);
    const versions = meshes.map(mesh => mesh.geometry.getAttribute('actorPrevious').version);
    const uploads = actors.telemetry.bufferUpdates;
    for(let i=1;i<=8;i++){
      data.previousTime=100+i*.2; data.currentTime=data.previousTime+.2;
      actors.updateColumns(data); actors.setTime(data.previousTime+.1);
    }
    meshes.forEach((mesh,i)=>{
      expect(mesh.userData.instanceIds).toBe(identities[i]);
      expect(mesh.geometry.getAttribute('actorPrevious').version).toBe(versions[i]);
    });
    expect(actors.telemetry.bufferUpdates).toBe(uploads); actors.dispose();
  });
  it('uploads only dynamic columns without rebuilding the same ID lists', async () => {
    const actors = await loadActors(); actors.updateCamera(camera(),1920,1080);
    const data=columns(4); actors.updateColumns(data);
    const meshes=actors.object.children as THREE.Mesh<THREE.InstancedBufferGeometry>[];
    const identities=meshes.map(mesh=>mesh.userData.instanceIds);
    const lodUpdates=actors.telemetry.lodUpdates;
    data.previousPositions[0]=.2; data.nextPositions[0]=.4;
    data.previousTime=100.2;data.currentTime=100.4;actors.updateColumns(data);
    meshes.forEach((mesh,i)=>expect(mesh.userData.instanceIds).toBe(identities[i]));
    expect(actors.telemetry.lodUpdates).toBe(lodUpdates);
    const body=meshes.find(mesh=>mesh.userData.instanceIds.includes('fictional-0')&&mesh.name.includes('casual'))!;
    expect(body.geometry.getAttribute('actorNext').getX(body.userData.instanceIds.indexOf('fictional-0'))).toBeCloseTo(.4);
    actors.dispose();
  });
  it('rebinds source indices when an immutable membership column is replaced',async()=>{
    const actors=await loadActors();actors.updateCamera(camera(10),1920,1080);
    const data=columns(2);data.previousPositions[0]=-4;data.nextPositions[0]=-4;data.previousPositions[3]=4;data.nextPositions[3]=4;
    actors.updateColumns(data);
    const next={...data,ids:[data.ids[1]!,data.ids[0]!],seeds:Uint32Array.from([data.seeds[1]!,data.seeds[0]!])};
    next.previousPositions=Float32Array.from([4,0,0,-4,0,0]);next.nextPositions=next.previousPositions.slice();
    actors.updateColumns(next);actors.setTime(100.1);
    const hit=actors.pick(new THREE.Ray(new THREE.Vector3(-4,1.1,10),new THREE.Vector3(0,0,-1)));
    expect(hit?.id).toBe('fictional-0');actors.dispose();
  });
  it('keeps overflow people as sprites instead of dropping them; selected ID wins near allocation', async () => {
    const actors = await loadActors('low'); actors.updateCamera(camera(), 1920, 1080);
    const data = columns(200); actors.updateColumns(data, { selectedId: 'fictional-199' });
    expect(actors.telemetry.people).toBe(GAME_ACTOR_CAPS.low.people);
    expect(actors.telemetry.nearPeople).toBe(GAME_ACTOR_CAPS.low.nearPeople);
    const sprite = actors.object.children.find((mesh) => mesh.name === 'game-actor-person-sprite') as THREE.Mesh<THREE.InstancedBufferGeometry>;
    expect(sprite.geometry.instanceCount).toBe(96);
    const near = actors.object.children.filter((mesh) => /game-actor-(casual|suit|worker)/.test(mesh.name));
    expect(near.some((mesh) => mesh.userData.instanceIds.includes('fictional-199'))).toBe(true);
    actors.dispose();
  });
  it('clicks deformed authored triangles at the interpolated position and not a stale origin', async () => {
    const actors = await loadActors(); actors.updateCamera(camera(10), 1920, 1080);
    const data = columns(); data.previousPositions[0] = -4; data.nextPositions[0] = 4;
    actors.updateColumns(data); actors.setTime(100.1);
    const hit = actors.pick(new THREE.Ray(new THREE.Vector3(0, 1.1, 10), new THREE.Vector3(0, 0, -1)));
    expect(hit?.id).toBe('fictional-0'); expect(hit?.kind).toBe('person');
    expect(hit!.point.x).toBeCloseTo(0, 3);
    expect(actors.pick(new THREE.Ray(new THREE.Vector3(-4, 1.1, 10), new THREE.Vector3(0, 0, -1)))).toBeNull();
    actors.dispose();
  });
  it('rejects bad IDs or nonfinite route coordinates and skips ambient picking', async () => {
    const actors = await loadActors(); actors.updateCamera(camera(), 1920, 1080);
    const bad = columns(2); bad.ids = ['same', 'same']; expect(() => actors.updateColumns(bad)).toThrow('unique');
    const data = columns(); data.pickable = new Uint8Array(1); actors.updateColumns(data); actors.setTime(100.1);
    expect(actors.pick(new THREE.Ray(new THREE.Vector3(0, 1, 10), new THREE.Vector3(0, 0, -1)))).toBeNull();
    data.nextPositions[0] = Infinity; expect(() => actors.updateColumns(data)).toThrow('finite');
    actors.dispose();
  });
  it('hides expired once actors from bodies, sprites, glow, contact shadows and click picking',async()=>{
    const actors=await loadActors();actors.updateCamera(camera(10),1920,1080);
    const data=columns();data.previousOpacities=new Float32Array([1]);data.nextOpacities=new Float32Array([0]);
    actors.updateColumns(data);actors.setTime(100.2);
    expect(actors.pick(new THREE.Ray(new THREE.Vector3(0,1.1,10),new THREE.Vector3(0,0,-1)))).toBeNull();
    for(const object of actors.object.children){
      const mesh=object as THREE.Mesh<THREE.InstancedBufferGeometry,THREE.ShaderMaterial>;
      if(!mesh.userData.instanceIds.includes('fictional-0'))continue;
      expect(mesh.geometry.getAttribute('actorOpacity').getY(0)).toBe(0);
      expect(mesh.material.fragmentShader).toContain('presentationOpacity');
    }
    actors.dispose();
  });
  it('exposes no more than two actual attribute rows for continuity QA without changing buffers',async()=>{
    const actors=await loadActors();actors.updateCamera(camera(10),1920,1080);
    const data=columns(3);data.kinds[1]=1;data.previousPositions[0]=-4;data.nextPositions[0]=4;
    actors.updateColumns(data,{selectedId:'fictional-0'});actors.setTime(100.1);
    const before=actors.telemetry.bufferUpdates,probe=actors.readMotionProbe();
    expect(probe.actors.map(row=>row.id)).toEqual(['fictional-0','fictional-1']);
    expect(probe.actors[0]!.previous[0]).toBe(-4);expect(probe.actors[0]!.next[0]).toBe(4);
    expect(probe.actors[0]!.position[0]).toBeCloseTo(0,3);expect(probe.actors[0]!.sourceIndex).toBe(0);
    expect(probe.actors[0]!.opacity).toBe(1);expect(probe.interpolationAlpha).toBeCloseTo(.5);
    expect(actors.telemetry.bufferUpdates).toBe(before);
    expect(()=>actors.readMotionProbe(['a','b','c'])).toThrow('two');actors.dispose();
  });
  it('smooths a vehicle source corner in the shader without changing its route positions or uploading per-frame buffers',async()=>{
    const actors=await loadActors();actors.updateCamera(camera(10),1920,1080);const data=columns();data.kinds[0]=1;
    actors.updateColumns(data);actors.setTime(100.5);expect(actors.readMotionProbe(['fictional-0']).actors[0]!.headingRadians).toBeCloseTo(Math.PI,5);
    data.previousTime=101;data.currentTime=101.2;data.headings[0]=90;data.previousPositions[0]=2;data.nextPositions[0]=3;
    actors.updateColumns(data);actors.setTime(101);const start=actors.readMotionProbe(['fictional-0']).actors[0]!;
    expect(start.headingRadians).toBeCloseTo(Math.PI,5);expect(start.previous).toEqual([2,0,0]);expect(start.next).toEqual([3,0,0]);
    const uploads=actors.telemetry.bufferUpdates;actors.setTime(101.5);const half=actors.readMotionProbe(['fictional-0']).actors[0]!;
    expect(half.headingRadians).toBeGreaterThan(Math.PI/2);expect(half.headingRadians).toBeLessThan(Math.PI);expect(half.position).toEqual([3,0,0]);
    for(let i=0;i<30;i++)actors.setTime(101.5);expect(actors.readMotionProbe(['fictional-0']).actors[0]!.headingRadians).toBe(half.headingRadians);expect(actors.telemetry.bufferUpdates).toBe(uploads);
    actors.setTime(103);expect(actors.readMotionProbe(['fictional-0']).actors[0]!.headingRadians).toBeCloseTo(Math.PI/2,5);actors.dispose();
  });
  it('retains the in-progress turn by canonical ID through reordered membership and resets on an explicit small seek',async()=>{
    const actors=await loadActors();actors.updateCamera(camera(10),1920,1080);const data=columns(2);data.kinds.fill(1);
    actors.updateColumns(data,{headingEpoch:'run:0'});data.headings[0]=90;data.previousTime=101;data.currentTime=101.2;actors.updateColumns(data,{headingEpoch:'run:0'});actors.setTime(101.1);
    const before=actors.readMotionProbe(['fictional-0']).actors[0]!;
    const reordered={...data,ids:[data.ids[1]!,data.ids[0]!],seeds:Uint32Array.from([data.seeds[1]!,data.seeds[0]!]),headings:Float32Array.from([0,90])};
    actors.updateColumns(reordered,{headingEpoch:'run:0',selectedId:'fictional-0'});const after=actors.readMotionProbe(['fictional-0']).actors[0]!;
    expect(after.sourceIndex).toBe(1);expect(after.headingRadians).toBe(before.headingRadians);expect(after.headingStartTimeSeconds).toBe(before.headingStartTimeSeconds);
    actors.updateCamera(camera(1000),1920,1080);expect(actors.readMotionProbe(['fictional-0']).actors[0]!.headingRadians).toBe(before.headingRadians);
    reordered.previousTime=101.11;reordered.currentTime=101.31;actors.updateColumns(reordered,{headingEpoch:'run:1'});actors.setTime(101.11);
    const reset=actors.readMotionProbe(['fictional-0']).actors[0]!;expect(reset.headingDurationSeconds).toBe(0);expect(reset.headingRadians).toBeCloseTo(Math.PI/2,5);actors.dispose();
  });
  it('picks the rotating visible body and keeps stopped samples free of repeated heading uploads',async()=>{
    const actors=await loadActors();actors.updateCamera(camera(10),1920,1080);const data=columns();data.kinds[0]=1;data.walking[0]=0;
    actors.updateColumns(data,{headingEpoch:0});data.headings[0]=90;data.previousTime=101;data.currentTime=101.2;actors.updateColumns(data,{headingEpoch:0});actors.setTime(101);
    const ray=new THREE.Ray(new THREE.Vector3(0,10,1.6),new THREE.Vector3(0,-1,0));expect(actors.pick(ray)?.id).toBe('fictional-0');
    const uploads=actors.telemetry.bufferUpdates;
    for(let i=1;i<=12;i++){data.previousTime=101+i*.2;data.currentTime=data.previousTime+.2;actors.updateColumns(data,{headingEpoch:0});actors.setTime(data.previousTime);}
    expect(actors.telemetry.bufferUpdates).toBe(uploads);expect(actors.pick(ray)).toBeNull();expect(actors.readMotionProbe(['fictional-0']).actors[0]!.position).toEqual([0,0,0]);actors.dispose();
  });
});
