import * as THREE from 'three';
import type { RendererLivingSnapshot } from '../types';
import type { LivingRenderFramePair } from '../living/adapters';
import { LivingKind, LivingRepresentation } from '../living/types';
import { UNIVERSAL_ACTOR_ATLAS_URL } from '../actorAtlas';
import {sampleGameHeading,updateGameHeading,type GameHeadingState} from './gameActorHeading';

export type GameActorTier = 'low' | 'mid' | 'high';
export const GAME_ACTOR_CAPS = Object.freeze({
  low: { people: 160, vehicles: 320, nearPeople: 64, nearVehicles: 64 },
  mid: { people: 500, vehicles: 800, nearPeople: 192, nearVehicles: 128 },
  high: { people: 1200, vehicles: 1800, nearPeople: 512, nearVehicles: 256 },
});
export interface GameActorsOptions {
  origin: readonly [number, number];
  tier: GameActorTier;
  /** Deployment-base-aware directory containing manifest.json and actors.bin. */
  assetBaseUrl: string;
  onDirty?: () => void;
}
export interface GameActorsUpdateOptions {
  selectedId?: string | null;
  headingEpoch?:number|string;
  indices?: Uint32Array;
  framePair?: LivingRenderFramePair;
  /** Source road/bridge elevation, if known. Never infer elevation from screen depth. */
  groundElevations?: Float32Array;
}
export interface GameActorPick { id: string; kind: 'person' | 'vehicle'; distance: number; point: THREE.Vector3 }
export interface GameActorMotionProbe {
  readonly shaderTimeSeconds:number;
  readonly previousTimeSeconds:number;
  readonly currentTimeSeconds:number;
  readonly interpolationAlpha:number;
  readonly gpuFloat32Alpha:number;
  readonly actors:readonly {
    id:string;kind:'person'|'vehicle';sourceIndex:number;meshName:string;instanceIndex:number;
    previous:readonly[number,number,number];next:readonly[number,number,number];position:readonly[number,number,number];
    headingRadians:number;targetHeadingRadians:number;headingStartRadians:number;headingDeltaRadians:number;headingStartTimeSeconds:number;headingDurationSeconds:number;
    previousOpacity:number;nextOpacity:number;opacity:number;walking:boolean;near:boolean;
  }[];
}
export interface GameActorColumns {
  /** IDs/kinds/seeds/pickable are immutable membership columns. Replace them or
   * bump this revision when changing membership; position columns remain mutable. */
  membershipRevision?: number | string;
  ids: readonly string[];
  /** 0 = person, 1 = vehicle. */
  kinds: Uint8Array;
  seeds: Uint32Array;
  /** xyz meters East/Up/South relative to constructor origin. Ground elevation included. */
  previousPositions: Float32Array;
  nextPositions: Float32Array;
  /** Author-defined presence/endpoint fade; defaults to fully visible. */
  previousOpacities?: Float32Array;
  nextOpacities?: Float32Array;
  /** Clockwise degrees from north, not Three Euler radians. */
  headings: Float32Array;
  walking: Uint8Array;
  previousTime: number;
  currentTime: number;
  /** Omit for individually selectable fictional agents; ambient rows must be zero. */
  pickable?: Uint8Array;
}
interface Slice { byteOffset: number; byteLength: number; count: number; type: string }
interface Clip { offset: number; count: number; duration: number }
interface TemplateDescription {
  name: string; kind: 'person' | 'vehicle'; vertexCount: number; triangleCount: number; frameCount: number;
  dimensions: { height: number; width: number; length: number };
  animation: { idle: Clip; walk: Clip };
  positions: Slice; normals: Slice; colors: Slice; indices: Slice;
}
export interface GameActorManifest {
  contractVersion: 1; version: 'game-actors-v1'; coordinateSystem: 'east-up-south';
  binary: { url: string; bytes: number; sha256: string }; models: TemplateDescription[];
}
interface Template {
  description: TemplateDescription; positions: Float32Array; normals: Float32Array;
  colors: Float32Array; indices: Uint32Array; positionTexture: THREE.DataTexture; normalTexture: THREE.DataTexture;
}
interface Actor {
  id: string; kind: 'person' | 'vehicle'; seed: number; selected: boolean; pickable: boolean; template: number;
  sourceIndex: number;
  previousOpacity:number;nextOpacity:number;
  previous: THREE.Vector3; next: THREE.Vector3; heading: number; walking: boolean; near: boolean; pixels: number;
  headingMotion?:GameHeadingState;
}
interface Batch {
  mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  actors: Actor[]; template: Template | null; mode: 'body' | 'sprite' | 'glow' | 'shadow';
  previous: THREE.InstancedBufferAttribute; next: THREE.InstancedBufferAttribute;
  details: THREE.InstancedBufferAttribute;
  opacity: THREE.InstancedBufferAttribute;
  headingMotion:THREE.InstancedBufferAttribute;
}
const smoothstep = (a: number, b: number, value: number) => { const t = THREE.MathUtils.clamp((value - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** The glow remains readable until the physical body actually occupies 8–14 CSS px. */
export function gameActorBodyMix(projectedHeight: number): number {
  if (!Number.isFinite(projectedHeight) || projectedHeight < 0) throw new RangeError('Actor screen height must be finite and non-negative');
  return smoothstep(8, 14, projectedHeight);
}
/** Shared CPU/GPU frame addressing; idle and walk never cross their baked clip boundaries. */
export function gameActorPose(clip: Clip, seconds: number, phase: number): readonly [number, number, number] {
  const frame = ((seconds / clip.duration + phase) % 1 + 1) % 1 * clip.count;
  return [clip.offset + Math.floor(frame), clip.offset + (Math.floor(frame) + 1) % clip.count, frame % 1];
}

const commonVertex = /* glsl */`
attribute vec3 actorPrevious;
attribute vec3 actorNext;
attribute vec4 actorDetails; // heading radians, stable phase, walking, near allocation
attribute vec2 actorOpacity;
attribute vec4 actorHeadingMotion; // start yaw, shortest delta, simulation start, duration
uniform float actorTime;
uniform vec2 actorInterval;
uniform vec2 cssViewport;
uniform vec3 cameraRight;
varying vec3 worldNormal;
varying vec3 actorColor;
varying vec2 atlasUv;
varying vec2 quadUv;
varying float bodyMix;
varying float spriteKind;
varying float presentationOpacity;
float actorBlend() {
  return clamp((actorTime - actorInterval.x) / max(0.0001, actorInterval.y - actorInterval.x), 0.0, 1.0);
}
vec3 actorOrigin() {
  float alpha = actorBlend();
  presentationOpacity=mix(actorOpacity.x,actorOpacity.y,alpha);
  return mix(actorPrevious, actorNext, alpha);
}
mat3 actorRotation() {
  float alpha=clamp((actorTime-actorHeadingMotion.z)/max(0.0001,actorHeadingMotion.w),0.0,1.0);
  float heading=actorHeadingMotion.x+actorHeadingMotion.y*alpha*alpha*(3.0-2.0*alpha);
  float c = cos(heading), s = sin(heading);
  return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c);
}
float screenPixels(vec3 origin, float height) {
  vec4 foot = projectionMatrix * modelViewMatrix * vec4(origin, 1.0);
  vec4 head = projectionMatrix * modelViewMatrix * vec4(origin + vec3(0.0,height,0.0), 1.0);
  return length((head.xy / head.w - foot.xy / foot.w) * cssViewport * 0.5);
}
`;
export const GAME_ACTOR_VERTEX_SHADER = /* glsl */`
${commonVertex}
attribute vec3 color;
attribute float vertexId;
uniform sampler2D posePositions;
uniform sampler2D poseNormals;
uniform vec2 poseTextureSize;
uniform vec3 idleClip;
uniform vec3 walkClip;
vec2 poseUv(float frame) { return (vec2(vertexId, frame) + 0.5) / poseTextureSize; }
void main() {
  vec3 clip = actorDetails.z > 0.5 ? walkClip : idleClip;
  float frame = fract(actorTime / clip.z + actorDetails.y) * clip.y;
  float a = clip.x + floor(frame), b = clip.x + mod(floor(frame) + 1.0, clip.y);
  vec3 p = mix(texture2D(posePositions, poseUv(a)).xyz, texture2D(posePositions, poseUv(b)).xyz, fract(frame));
  vec3 n = mix(texture2D(poseNormals, poseUv(a)).xyz, texture2D(poseNormals, poseUv(b)).xyz, fract(frame));
  vec3 origin = actorOrigin();
  worldNormal = normalize(actorRotation() * n);
  actorColor = color * (0.88 + 0.24 * actorDetails.y);
  bodyMix = smoothstep(8.0, 14.0, screenPixels(origin, 1.8));
  // Cars retain their volume at smaller scale; they do not inherit person glow thresholds.
  #ifdef VEHICLE
    bodyMix = 1.0;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * vec4(origin + actorRotation() * p, 1.0);
}
`;
export const GAME_ACTOR_FRAGMENT_SHADER = /* glsl */`
varying vec3 worldNormal;
varying vec3 actorColor;
varying float bodyMix;
varying float presentationOpacity;
uniform vec3 sunDirection;
void main() {
  // Ordered, depth-writing crossfade: no semitransparent people leaking through roofs.
  float dither = fract(dot(floor(gl_FragCoord.xy), vec2(0.754877666, 0.569840296)));
  if (bodyMix * presentationOpacity <= dither) discard;
  float diffuse = max(0.0, dot(normalize(worldNormal), normalize(sunDirection)));
  float hemisphere = 0.60 + 0.12 * max(0.0, worldNormal.y);
  vec3 light = vec3(hemisphere) + vec3(1.0,0.94,0.82) * diffuse * 0.50;
  gl_FragColor = vec4(actorColor * light, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
const billboardVertex = /* glsl */`
${commonVertex}
uniform float vehicle;
void main() {
  vec3 origin = actorOrigin();
  bodyMix = smoothstep(8.0, 14.0, screenPixels(origin, 1.8));
  vec3 offset = vehicle > 0.5 ? actorRotation() * vec3(position.x * 2.0,0.0,-position.y * 5.0)
    : cameraRight * position.x * 1.2255 + vec3(0.0,(position.y + 0.5) * 1.8,0.0);
  #ifdef CONTACT_SHADOW
    offset = actorRotation() * vec3(position.x * (vehicle > 0.5 ? 2.3 : 0.85),0.015,-position.y * (vehicle > 0.5 ? 4.8 : 0.65));
  #endif
  vec4 body = projectionMatrix * modelViewMatrix * vec4(origin + offset, 1.0);
  #ifdef GLOW
    vec4 glow = projectionMatrix * modelViewMatrix * vec4(origin + vec3(0.0,0.9,0.0),1.0);
    glow.xy += position.xy * 8.0 * 2.0 / cssViewport * glow.w;
    gl_Position = glow;
  #else
    gl_Position = body;
  #endif
  float style = floor(actorDetails.y * 4.0);
  float gait = actorDetails.z > 0.5 ? mod(floor(actorTime * 4.0 + actorDetails.y * 8.0), 2.0) : 0.0;
  atlasUv = vehicle > 0.5 ? vec2((floor(actorDetails.y * 8.0) * 32.0 + uv.x * 32.0) / 256.0, (64.0 + uv.y * 32.0) / 128.0)
    : vec2(((style + gait * 4.0) * 32.0 + uv.x * 32.0) / 256.0, (9.0 + (1.0 - uv.y) * 47.0) / 128.0);
  quadUv = uv * 2.0 - 1.0;
  spriteKind = vehicle;
}
`;
const billboardFragment = /* glsl */`
uniform sampler2D spriteAtlas;
varying vec2 atlasUv;
varying vec2 quadUv;
varying float bodyMix;
varying float spriteKind;
varying float presentationOpacity;
void main() {
  #ifdef CONTACT_SHADOW
    float alpha = exp(-dot(quadUv,quadUv) * 3.0) * 0.25 * presentationOpacity;
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(0.08,0.09,0.07,alpha);
  #elif defined(GLOW)
    float alpha = exp(-dot(quadUv,quadUv) * 3.5) * (1.0 - bodyMix) * presentationOpacity;
    if (alpha < 0.06) discard;
    // Distant people remain readable without a bright cyan chain across the
    // streets. Canonical picking and the body scale transition are unchanged.
    gl_FragColor = vec4(0.20,0.27,0.30,alpha * 0.8);
  #else
    vec4 color = texture2D(spriteAtlas, vec2(atlasUv.x, 1.0 - atlasUv.y));
    if (color.a < 0.16) discard;
    float dither = fract(dot(floor(gl_FragCoord.xy), vec2(0.754877666, 0.569840296)));
    if ((spriteKind < 0.5 ? bodyMix : 1.0) * presentationOpacity <= dither) discard;
    gl_FragColor = color;
    #include <colorspace_fragment>
  #endif
}
`;

/** No RAF, skeleton per resident, React state or per-render instance buffer writes. */
export class GameActors {
  readonly object = new THREE.Group();
  readonly options: GameActorsOptions;
  readonly telemetry = { state: 'unloaded' as 'unloaded' | 'loading' | 'ready' | 'failed' | 'disposed', people: 0, vehicles: 0, nearPeople: 0, nearVehicles: 0, bufferUpdates: 0, membershipUpdates: 0, lodUpdates: 0, pickMode: 'click_deformed_triangles' as const, gpuBytes: 0 };
  private templates: Template[] = [];
  private batches: Batch[] = [];
  private actors: Actor[] = [];
  private atlas: THREE.Texture | null = null;
  private atlasAlpha: Uint8ClampedArray | null = null;
  private abort = new AbortController();
  private camera: THREE.Camera | null = null;
  private viewProjection = new THREE.Matrix4();
  private inverseViewProjection = new THREE.Matrix4();
  private viewport = new THREE.Vector2(1920, 1080);
  private right = new THREE.Vector3(1, 0, 0);
  private time = 0;
  private interval = new THREE.Vector2(0, 1);
  private snapshot: RendererLivingSnapshot | null = null;
  private lastOptions: GameActorsUpdateOptions = {};
  private columns: GameActorColumns | null = null;
  private columnsSelected: string | null = null;
  private columnsHeadingEpoch:number|string|undefined;
  private retainedMembership: {ids:GameActorColumns['ids'];kinds:Uint8Array;seeds:Uint32Array;pickable?:Uint8Array;revision?:number|string;selectedId:string|null;count:number}|null=null;
  private lastLodCheck = -Infinity;
  private projectedFoot = new THREE.Vector3();
  private projectedHead = new THREE.Vector3();
  private disposed = false;
  constructor(options: GameActorsOptions) {
    this.options = options; this.object.name = 'game-actors';
    if (!options.assetBaseUrl.endsWith('/')) throw new Error('Game actor assetBaseUrl must end with /');
  }
  async load(): Promise<void> {
    if (this.telemetry.state !== 'unloaded') return;
    this.telemetry.state = 'loading';
    try {
      const manifestResponse = await fetch(`${this.options.assetBaseUrl}manifest.json`, { signal: this.abort.signal });
      if (!manifestResponse.ok) throw new Error(`Actor manifest ${manifestResponse.status}`);
      const manifest = await manifestResponse.json() as GameActorManifest;
      if (manifest.version !== 'game-actors-v1' || manifest.contractVersion !== 1 || manifest.coordinateSystem !== 'east-up-south' || manifest.models.length > 12 || manifest.binary.bytes > 16 * 1024 * 1024) throw Error('Incompatible actor manifest');
      const response = await fetch(new URL(manifest.binary.url, new URL(this.options.assetBaseUrl, globalThis.location?.href)), { signal: this.abort.signal });
      if (!response.ok) throw Error(`Actor binary ${response.status}`);
      const binary = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', binary)), (value) => value.toString(16).padStart(2, '0')).join('');
      if (binary.byteLength !== manifest.binary.bytes || hash !== manifest.binary.sha256) throw Error('Actor binary integrity mismatch');
      if (this.disposed) return;
      for (const description of manifest.models) {
        const readFloat = (slice: Slice) => new Float32Array(binary, slice.byteOffset, slice.count);
        const positions = readFloat(description.positions), normals = readFloat(description.normals);
        const positionTexture = new THREE.DataTexture(positions, description.vertexCount, description.frameCount, THREE.RGBAFormat, THREE.FloatType);
        const normalTexture = new THREE.DataTexture(normals, description.vertexCount, description.frameCount, THREE.RGBAFormat, THREE.FloatType);
        positionTexture.needsUpdate = true; normalTexture.needsUpdate = true;
        this.templates.push({ description, positions, normals, colors: readFloat(description.colors), indices: new Uint32Array(binary, description.indices.byteOffset, description.indices.count), positionTexture, normalTexture });
      }
      this.atlas = await new THREE.TextureLoader().loadAsync(UNIVERSAL_ACTOR_ATLAS_URL);
      this.atlas.colorSpace = THREE.SRGBColorSpace;
      if (typeof OffscreenCanvas !== 'undefined') {
        const surface = new OffscreenCanvas(256, 128), context = surface.getContext('2d');
        context?.drawImage(this.atlas.image as CanvasImageSource, 0, 0); this.atlasAlpha = context?.getImageData(0, 0, 256, 128).data ?? null;
      }
      if (this.disposed) { this.atlas.dispose(); return; }
      this.telemetry.gpuBytes = binary.byteLength;
      this.createBatches(); this.telemetry.state = 'ready';
      if (this.columns) this.updateColumns(this.columns, { selectedId: this.columnsSelected,headingEpoch:this.columnsHeadingEpoch });
      else if (this.snapshot) this.update(this.snapshot, this.lastOptions);
      this.options.onDirty?.();
    } catch (error) {
      if (this.disposed) return;
      this.telemetry.state = 'failed'; this.options.onDirty?.(); throw error;
    }
  }
  private createBatches(): void {
    const caps = GAME_ACTOR_CAPS[this.options.tier];
    const shared = () => ({ actorTime: { value: this.time }, actorInterval: { value: this.interval }, cssViewport: { value: this.viewport }, cameraRight: { value: this.right }, sunDirection: { value: new THREE.Vector3(-0.6, 0.8, -0.3) } });
    const create = (template: Template | null, mode: Batch['mode'], vehicle: boolean) => {
      const capacity = vehicle ? caps.vehicles : caps.people;
      const geometry = new THREE.InstancedBufferGeometry();
      const previous = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const next = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const details = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const opacity = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2).fill(1), 2).setUsage(THREE.DynamicDrawUsage);
      const headingMotion=new THREE.InstancedBufferAttribute(new Float32Array(capacity*4),4).setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('actorPrevious', previous); geometry.setAttribute('actorNext', next); geometry.setAttribute('actorDetails', details);
      geometry.setAttribute('actorOpacity',opacity);
      geometry.setAttribute('actorHeadingMotion',headingMotion);
      let material: THREE.ShaderMaterial;
      if (template) {
        const description = template.description;
        geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from({ length: description.vertexCount * 3 }, (_, i) => template.positions[Math.floor(i / 3) * 4 + i % 3]!), 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(template.colors, 3));
        geometry.setAttribute('vertexId', new THREE.BufferAttribute(Float32Array.from({ length: description.vertexCount }, (_, i) => i), 1));
        geometry.setIndex(new THREE.BufferAttribute(template.indices, 1));
        const clip = (key: 'idle' | 'walk') => new THREE.Vector3(description.animation[key].offset, description.animation[key].count, description.animation[key].duration);
        material = new THREE.ShaderMaterial({ vertexShader: GAME_ACTOR_VERTEX_SHADER, fragmentShader: GAME_ACTOR_FRAGMENT_SHADER, defines: vehicle ? { VEHICLE: 1 } : {}, uniforms: { ...shared(), posePositions: { value: template.positionTexture }, poseNormals: { value: template.normalTexture }, poseTextureSize: { value: new THREE.Vector2(description.vertexCount, description.frameCount) }, idleClip: { value: clip('idle') }, walkClip: { value: clip('walk') } } });
      } else {
        const quad = new THREE.PlaneGeometry(1, 1); geometry.setAttribute('position', quad.getAttribute('position')); geometry.setAttribute('uv', quad.getAttribute('uv')); geometry.setIndex(quad.index); quad.dispose();
        material = new THREE.ShaderMaterial({ vertexShader: billboardVertex, fragmentShader: billboardFragment, defines: mode === 'glow' ? { GLOW: 1 } : mode === 'shadow' ? { CONTACT_SHADOW: 1 } : {}, uniforms: { ...shared(), spriteAtlas: { value: this.atlas }, vehicle: { value: vehicle ? 1 : 0 } }, transparent: mode === 'glow' || mode === 'shadow', depthWrite: mode !== 'glow' && mode !== 'shadow', side: THREE.DoubleSide });
      }
      material.depthTest = true;
      const mesh = new THREE.Mesh(geometry, material); mesh.name = template ? `game-actor-${template.description.name}` : `game-actor-${vehicle ? 'vehicle' : 'person'}-${mode}`;
      mesh.frustumCulled = false; mesh.castShadow = false; mesh.userData.gameActorKind = vehicle ? 'vehicle' : 'person'; mesh.userData.instanceIds=[]; geometry.instanceCount = 0;
      this.object.add(mesh); this.batches.push({ mesh, actors: [], template, mode, previous, next, details, opacity,headingMotion });
    };
    for (const template of this.templates) create(template, 'body', template.description.kind === 'vehicle');
    create(null, 'sprite', false); create(null, 'sprite', true); create(null, 'glow', false); create(null, 'shadow', false); create(null, 'shadow', true);
  }
  update(snapshot: RendererLivingSnapshot, options: GameActorsUpdateOptions = {}): void {
    this.snapshot = snapshot; this.lastOptions = options;
    this.retainedMembership=null;
    if (this.telemetry.state !== 'ready') return;
    const { partition, frame } = snapshot, caps = GAME_ACTOR_CAPS[this.options.tier];
    const source = options.indices ?? Uint32Array.from({ length: partition.count }, (_, i) => i);
    const old = new Map(this.actors.map((actor) => [actor.id, actor]));
    const previous = options.framePair?.previous ?? frame, next = options.framePair?.current ?? frame;
    this.interval.set(options.framePair?.previousPresentationTimeSeconds ?? snapshot.telemetry.presentationTimeSeconds,
      options.framePair?.currentPresentationTimeSeconds ?? snapshot.telemetry.presentationTimeSeconds + 0.1);
    const latitudeMeters = 110_540, longitudeMeters = Math.max(1, Math.cos(partition.originLatitude * Math.PI / 180) * 111_320);
    const originLatitudeMeters = Math.cos(this.options.origin[1] * Math.PI / 180) * 111_320;
    const translate = (x: number, y: number, z: number, target: THREE.Vector3) => target.set(
      (partition.originLongitude + x / longitudeMeters - this.options.origin[0]) * originLatitudeMeters,
      z, -(partition.originLatitude + y / latitudeMeters - this.options.origin[1]) * latitudeMeters);
    const candidates: Actor[] = [];
    for (const index of source) {
      const id = partition.identity.ids[index]; if (index >= partition.count || !id) continue;
      if (id !== options.selectedId && (!partition.presentation.visible[index] || snapshot.individualActorsEnabled === false)) continue;
      if (!Number.isFinite(frame.x[index]) || !Number.isFinite(frame.y[index])) continue;
      const vehicle = partition.identity.kind[index] === LivingKind.VEHICLE, seed = partition.identity.seed[index]! >>> 0;
      const templates = this.templates.map((template, index) => ({ template, index })).filter(({ template }) => template.description.kind === (vehicle ? 'vehicle' : 'person'));
      if (!templates.length) continue;
      const actor: Actor = old.get(id) ?? { id, kind: vehicle ? 'vehicle' : 'person', seed, sourceIndex:index, previousOpacity:1,nextOpacity:1,selected: false, pickable: false, template: templates[seed % templates.length]!.index, previous: new THREE.Vector3(), next: new THREE.Vector3(), heading: 0, walking: true, near: false, pixels: 0 };
      actor.previousOpacity=actor.nextOpacity=1;
      actor.selected = id === options.selectedId; actor.pickable = partition.identity.representation[index] !== LivingRepresentation.AMBIENT_ONLY;
      const ground = options.groundElevations?.[index] ?? 0;
      translate(previous.x[index]!, previous.y[index]!, ground + (vehicle ? 0.1 : 0), actor.previous);
      translate(next.x[index]!, next.y[index]!, ground + (vehicle ? 0.1 : 0), actor.next);
      // Author assets face +Z (south); source headings are clockwise from north.
      actor.heading = Math.PI - next.heading[index]! * Math.PI / 180;
      if(vehicle)actor.headingMotion=updateGameHeading(actor.headingMotion,actor.heading,this.interval.x,options.headingEpoch);
      actor.walking = partition.position.speedMetersPerSecond[index]! > 0.1;
      candidates.push(actor);
    }
    candidates.sort((a, b) => Number(b.selected) - Number(a.selected) || a.seed - b.seed || a.id.localeCompare(b.id));
    let people = 0, vehicles = 0;
    this.actors = candidates.filter((actor) => actor.kind === 'person' ? people++ < caps.people : vehicles++ < caps.vehicles);
    if (this.actors.length !== old.size || this.actors.some((actor) => !old.has(actor.id))) this.telemetry.membershipUpdates++;
    this.telemetry.people = this.actors.filter((actor) => actor.kind === 'person').length;
    this.telemetry.vehicles = this.actors.length - this.telemetry.people;
    this.reconcileLod();
  }
  updateColumns(columns: GameActorColumns, options: { selectedId?: string | null;headingEpoch?:number|string } = {}): void {
    this.columns = columns; this.columnsSelected = options.selectedId ?? null;
    this.columnsHeadingEpoch=options.headingEpoch;
    if (this.telemetry.state !== 'ready') return;
    const count = columns.ids.length;
    if (columns.kinds.length !== count || columns.seeds.length !== count || columns.headings.length !== count
      || columns.walking.length !== count || columns.previousPositions.length !== count * 3 || columns.nextPositions.length !== count * 3
      || (columns.previousOpacities&&columns.previousOpacities.length!==count)||(columns.nextOpacities&&columns.nextOpacities.length!==count)
      || (columns.pickable && columns.pickable.length !== count) || !Number.isFinite(columns.previousTime)
      || !Number.isFinite(columns.currentTime) || columns.currentTime <= columns.previousTime) throw Error('Invalid retained game actor columns');
    // Validate dynamic input without allocating two subarray views per resident.
    for (let index = 0; index < count; index++) {
      const offset=index*3;
      if(!Number.isFinite(columns.headings[index]))throw Error('Game actor coordinates must be finite');
      for(let component=0;component<3;component++)if(!Number.isFinite(columns.previousPositions[offset+component])||!Number.isFinite(columns.nextPositions[offset+component]))throw Error('Game actor coordinates must be finite');
      const previousOpacity=columns.previousOpacities?.[index]??1,nextOpacity=columns.nextOpacities?.[index]??1;
      if(!Number.isFinite(previousOpacity)||previousOpacity<0||previousOpacity>1||!Number.isFinite(nextOpacity)||nextOpacity<0||nextOpacity>1)throw Error('Game actor opacity must be within zero and one');
    }
    const cached=this.retainedMembership;
    const sameMembership=Boolean(cached&&cached.ids===columns.ids&&cached.kinds===columns.kinds&&cached.seeds===columns.seeds
      &&cached.pickable===columns.pickable&&cached.revision===columns.membershipRevision&&cached.count===count&&cached.selectedId===this.columnsSelected);
    if(!sameMembership){
      const old = new Map(this.actors.map(actor=>[actor.id,actor])),candidates:Actor[]=[];
      const templateSlots={person:this.templates.flatMap((template,i)=>template.description.kind==='person'?[i]:[]),vehicle:this.templates.flatMap((template,i)=>template.description.kind==='vehicle'?[i]:[])};
      const ids=new Set<string>();
      for(let index=0;index<count;index++){
        const id=columns.ids[index]!;
        if(!id||ids.has(id))throw Error('Game actor IDs must be nonempty and unique');ids.add(id);
        const kind=columns.kinds[index]===1?'vehicle':'person',seed=columns.seeds[index]!;
        const prior=old.get(id);
        const actor:Actor=prior?.kind===kind&&prior.seed===seed?prior:{id,kind,seed,sourceIndex:index,previousOpacity:1,nextOpacity:1,selected:false,pickable:true,
          template:templateSlots[kind][seed%templateSlots[kind].length]!,previous:new THREE.Vector3(),next:new THREE.Vector3(),heading:0,walking:true,near:false,pixels:0};
        actor.sourceIndex=index;actor.selected=id===this.columnsSelected;actor.pickable=columns.pickable?.[index]!==0;candidates.push(actor);
      }
      const caps=GAME_ACTOR_CAPS[this.options.tier];let people=0,vehicles=0;
      candidates.sort((a,b)=>Number(b.selected)-Number(a.selected)||a.seed-b.seed||a.id.localeCompare(b.id));
      this.actors=candidates.filter(actor=>actor.kind==='person'?people++<caps.people:vehicles++<caps.vehicles);
      if(this.actors.length!==old.size||this.actors.some(actor=>old.get(actor.id)!==actor))this.telemetry.membershipUpdates++;
      this.telemetry.people=Math.min(people,caps.people);this.telemetry.vehicles=Math.min(vehicles,caps.vehicles);
      this.retainedMembership={ids:columns.ids,kinds:columns.kinds,seeds:columns.seeds,pickable:columns.pickable,revision:columns.membershipRevision,selectedId:this.columnsSelected,count};
    }
    for(const actor of this.actors){
      const index=actor.sourceIndex;
      actor.previous.fromArray(columns.previousPositions,index*3);actor.next.fromArray(columns.nextPositions,index*3);
      actor.heading=Math.PI-columns.headings[index]!*Math.PI/180;actor.walking=columns.walking[index]!==0;
      if(actor.kind==='vehicle')actor.headingMotion=updateGameHeading(actor.headingMotion,actor.heading,columns.previousTime,options.headingEpoch);
      actor.previousOpacity=columns.previousOpacities?.[index]??1;actor.nextOpacity=columns.nextOpacities?.[index]??1;
    }
    this.interval.set(columns.previousTime, columns.currentTime);
    // Screen-size fade is continuous in the shader. Rank near-model slots at most
    // twice per wall second while the camera stays still, not every time sample.
    if(!sameMembership||performance.now()-this.lastLodCheck>=500)this.reconcileLod();
    else this.uploadBatches();
  }
  setTime(presentationSeconds: number): void {
    if (!Number.isFinite(presentationSeconds)) return;
    this.time = presentationSeconds;
    for (const batch of this.batches) batch.mesh.material.uniforms.actorTime!.value = presentationSeconds;
  }
  /** Shared art-direction vector toward the owning city's sun, in East/Up/South. */
  setLighting(options: { sunDirection: readonly [number, number, number] }): void {
    const direction = new THREE.Vector3(...options.sunDirection);
    if (!options.sunDirection.every(Number.isFinite) || direction.lengthSq() === 0) throw Error('Actor sun direction must be finite and nonzero');
    direction.normalize();
    for (const batch of this.batches) (batch.mesh.material.uniforms.sunDirection!.value as THREE.Vector3).copy(direction);
  }
  updateCamera(camera: THREE.Camera, cssWidth: number, cssHeight: number): void {
    const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (this.camera && matrix.equals(this.viewProjection) && this.viewport.x === cssWidth && this.viewport.y === cssHeight) return;
    this.camera = camera; this.viewProjection.copy(matrix); this.inverseViewProjection.copy(matrix).invert(); this.viewport.set(cssWidth, cssHeight);
    const left = new THREE.Vector3(-0.01, 0, 0).applyMatrix4(this.inverseViewProjection), right = new THREE.Vector3(0.01, 0, 0).applyMatrix4(this.inverseViewProjection);
    this.right.subVectors(right, left).setY(0).normalize();
    if (this.telemetry.state === 'ready') this.reconcileLod();
  }
  private projectedHeight(actor: Actor): number {
    return this.projectedHeightAt(actor.next);
  }
  private projectedHeightAt(position:THREE.Vector3):number {
    if (!this.camera) return 0;
    const foot = this.projectedFoot.copy(position).applyMatrix4(this.viewProjection), head = this.projectedHead.copy(position);
    head.y+=1.8;head.applyMatrix4(this.viewProjection);
    return Math.hypot((head.x - foot.x) * this.viewport.x / 2, (head.y - foot.y) * this.viewport.y / 2);
  }
  private reconcileLod(): void {
    this.lastLodCheck=performance.now();this.telemetry.lodUpdates++;
    const caps = GAME_ACTOR_CAPS[this.options.tier];
    for (const actor of this.actors) { actor.pixels = this.projectedHeight(actor); actor.near = false; }
    const ranked = [...this.actors].sort((a, b) => Number(b.selected) - Number(a.selected) || b.pixels - a.pixels || a.seed - b.seed);
    let people = 0, vehicles = 0;
    for (const actor of ranked) {
      if (actor.pixels < (actor.kind === 'vehicle' ? 3 : 8) && !actor.selected) continue;
      if (actor.kind === 'person' && people < caps.nearPeople) { actor.near = true; people++; }
      if (actor.kind === 'vehicle' && vehicles < caps.nearVehicles) { actor.near = true; vehicles++; }
    }
    this.telemetry.nearPeople = people; this.telemetry.nearVehicles = vehicles;
    for (const batch of this.batches) {
      const templateIndex = batch.template ? this.templates.indexOf(batch.template) : -1;
      const vehicle = batch.mesh.userData.gameActorKind === 'vehicle';
      const actors = this.actors.filter((actor) => batch.mode === 'body' ? actor.near && actor.template === templateIndex : batch.mode === 'glow' ? actor.kind === 'person' : batch.mode === 'shadow' ? actor.near && (actor.kind === 'vehicle') === vehicle : !actor.near && (actor.kind === 'vehicle') === vehicle);
      if (actors.length === batch.actors.length && actors.every((actor, i) => actor === batch.actors[i])) continue;
      batch.actors = actors;
      batch.mesh.geometry.instanceCount = batch.actors.length;
      batch.mesh.userData.instanceIds = batch.actors.map((actor) => actor.id);
    }
    this.uploadBatches();
  }
  private uploadBatches():void {
    let uploaded=false;
    for(const batch of this.batches){
      let previousChanged=false,nextChanged=false,detailsChanged=false,opacityChanged=false,headingChanged=false;
      for(let i=0;i<batch.actors.length;i++){
        const actor=batch.actors[i]!,p=actor.previous,n=actor.next;
        if(batch.previous.getX(i)!==p.x||batch.previous.getY(i)!==p.y||batch.previous.getZ(i)!==p.z){batch.previous.setXYZ(i,p.x,p.y,p.z);previousChanged=true;}
        if(batch.next.getX(i)!==n.x||batch.next.getY(i)!==n.y||batch.next.getZ(i)!==n.z){batch.next.setXYZ(i,n.x,n.y,n.z);nextChanged=true;}
        const heading=Math.fround(actor.heading),phase=(actor.seed%65536)/65536,walking=actor.walking?1:0,near=actor.near?1:0;
        if(batch.details.getX(i)!==heading||batch.details.getY(i)!==phase||batch.details.getZ(i)!==walking||batch.details.getW(i)!==near){batch.details.setXYZW(i,heading,phase,walking,near);detailsChanged=true;}
        if(batch.opacity.getX(i)!==actor.previousOpacity||batch.opacity.getY(i)!==actor.nextOpacity){batch.opacity.setXY(i,actor.previousOpacity,actor.nextOpacity);opacityChanged=true;}
        const h=actor.headingMotion,from=Math.fround(h?.from??actor.heading),delta=Math.fround(h?.delta??0),start=Math.fround(h?.start??0),duration=Math.fround(h?.duration??0);
        if(batch.headingMotion.getX(i)!==from||batch.headingMotion.getY(i)!==delta||batch.headingMotion.getZ(i)!==start||batch.headingMotion.getW(i)!==duration){batch.headingMotion.setXYZW(i,from,delta,start,duration);headingChanged=true;}
      }
      for(const [attribute,changed] of [[batch.previous,previousChanged],[batch.next,nextChanged],[batch.details,detailsChanged],[batch.opacity,opacityChanged],[batch.headingMotion,headingChanged]] as const){
        if(!changed)continue;
        attribute.clearUpdateRanges();attribute.addUpdateRange(0,batch.actors.length*attribute.itemSize);attribute.needsUpdate=true;uploaded=true;
      }
    }
    if(uploaded)this.telemetry.bufferUpdates++;
  }
  /** Bounded read-only QA probe of the actual retained shader attributes. No GPU
   * readback, profile dump, geometry rebuild or clock mutation. At most two IDs. */
  readMotionProbe(ids:readonly string[]=[]):GameActorMotionProbe {
    if(ids.length>2)throw new RangeError('Motion probe is limited to two actor IDs');
    const alpha=THREE.MathUtils.clamp((this.time-this.interval.x)/Math.max(.0001,this.interval.y-this.interval.x),0,1);
    const gpuAlpha=THREE.MathUtils.clamp(Math.fround(Math.fround(this.time)-Math.fround(this.interval.x))/Math.max(.0001,Math.fround(Math.fround(this.interval.y)-Math.fround(this.interval.x))),0,1);
    const wanted=ids.length?ids:[this.actors.find(actor=>actor.selected)?.id??this.actors.find(actor=>actor.kind==='person')?.id,this.actors.find(actor=>actor.kind==='vehicle')?.id];
    const rows:GameActorMotionProbe['actors'][number][]=[];
    for(const id of wanted){
      if(!id||rows.some(row=>row.id===id))continue;
      const actor=this.actors.find(value=>value.id===id);if(!actor)continue;
      const batch=this.batches.find(value=>value.actors.includes(actor));if(!batch)continue;
      const index=batch.actors.indexOf(actor);
      const previous:[number,number,number]=[batch.previous.getX(index),batch.previous.getY(index),batch.previous.getZ(index)];
      const next:[number,number,number]=[batch.next.getX(index),batch.next.getY(index),batch.next.getZ(index)];
      const previousOpacity=batch.opacity.getX(index),nextOpacity=batch.opacity.getY(index);
      rows.push({id:actor.id,kind:actor.kind,sourceIndex:actor.sourceIndex,meshName:batch.mesh.name,instanceIndex:index,
        previous,next,position:[THREE.MathUtils.lerp(previous[0],next[0],gpuAlpha),THREE.MathUtils.lerp(previous[1],next[1],gpuAlpha),THREE.MathUtils.lerp(previous[2],next[2],gpuAlpha)],
        previousOpacity,nextOpacity,opacity:THREE.MathUtils.lerp(previousOpacity,nextOpacity,gpuAlpha),
        headingRadians:sampleGameHeading({from:batch.headingMotion.getX(index),delta:batch.headingMotion.getY(index),start:batch.headingMotion.getZ(index),duration:batch.headingMotion.getW(index)},Math.fround(this.time)),
        targetHeadingRadians:batch.details.getX(index),headingStartRadians:batch.headingMotion.getX(index),headingDeltaRadians:batch.headingMotion.getY(index),headingStartTimeSeconds:batch.headingMotion.getZ(index),headingDurationSeconds:batch.headingMotion.getW(index),walking:batch.details.getZ(index)>.5,near:actor.near});
    }
    return {shaderTimeSeconds:this.time,previousTimeSeconds:this.interval.x,currentTimeSeconds:this.interval.y,interpolationAlpha:alpha,gpuFloat32Alpha:gpuAlpha,actors:rows};
  }
  /** Click-only exact baked triangle test, with the same interpolation/rotation as the GPU. */
  pick(ray: THREE.Ray): GameActorPick | null {
    let best: GameActorPick | null = null;
    const inverse = new THREE.Matrix4(), matrix = new THREE.Matrix4(), localRay = new THREE.Ray();
    const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    const alpha = THREE.MathUtils.clamp((this.time - this.interval.x) / Math.max(0.0001, this.interval.y - this.interval.x), 0, 1);
    for (const actor of this.actors) {
      if (!actor.pickable) continue;
      const presentationOpacity=THREE.MathUtils.lerp(actor.previousOpacity,actor.nextOpacity,alpha);
      if(presentationOpacity<=0)continue;
      p.copy(actor.previous).lerp(actor.next, alpha);
      const heading=actor.headingMotion?sampleGameHeading({from:Math.fround(actor.headingMotion.from),delta:Math.fround(actor.headingMotion.delta),start:Math.fround(actor.headingMotion.start),duration:Math.fround(actor.headingMotion.duration)},Math.fround(this.time)):actor.heading;
      const bodyMix=gameActorBodyMix(this.projectedHeightAt(p));
      if (actor.near && (actor.kind === 'vehicle' || bodyMix > 0)) {
        const template = this.templates[actor.template]!;
        matrix.makeRotationY(heading).setPosition(p); inverse.copy(matrix).invert(); localRay.copy(ray).applyMatrix4(inverse);
        const d = template.description.dimensions;
        if (!localRay.intersectsBox(new THREE.Box3(new THREE.Vector3(-d.width, -0.05, -d.length), new THREE.Vector3(d.width, d.height + 0.25, d.length)))) continue;
        const clip = actor.walking ? template.description.animation.walk : template.description.animation.idle;
        const [f0, f1, mix] = gameActorPose(clip, this.time, (actor.seed % 65536) / 65536);
        const vertex = (id: number, target: THREE.Vector3) => {
          const o0 = (f0 * template.description.vertexCount + id) * 4, o1 = (f1 * template.description.vertexCount + id) * 4;
          target.set(THREE.MathUtils.lerp(template.positions[o0]!, template.positions[o1]!, mix), THREE.MathUtils.lerp(template.positions[o0 + 1]!, template.positions[o1 + 1]!, mix), THREE.MathUtils.lerp(template.positions[o0 + 2]!, template.positions[o1 + 2]!, mix));
        };
        for (let i = 0; i < template.indices.length; i += 3) {
          vertex(template.indices[i]!, a); vertex(template.indices[i + 1]!, b); vertex(template.indices[i + 2]!, c);
          if (!localRay.intersectTriangle(a, b, c, true, hit)) continue;
          hit.applyMatrix4(matrix); const distance = ray.origin.distanceTo(hit);
          if (!best || distance < best.distance) best = { id: actor.id, kind: actor.kind, distance, point: hit.clone() };
        }
      }
      // Every glow is the same real ID as its body, not an invented aggregate NPC.
      if (actor.kind === 'person' && bodyMix < 0.94 && this.camera) {
        const glowCenter = p.clone().add(new THREE.Vector3(0, 0.9, 0));
        const projected = glowCenter.clone().applyMatrix4(this.viewProjection);
        const near = ray.at(Math.max(0, glowCenter.clone().sub(ray.origin).dot(ray.direction)), new THREE.Vector3()).applyMatrix4(this.viewProjection);
        const glowOpacity=(1-bodyMix)*presentationOpacity;
        const radius = glowOpacity<.06?-1:Math.sqrt(-Math.log(0.06 / glowOpacity) / 3.5) * 4;
        if (radius>=0&&Math.hypot((near.x - projected.x) * this.viewport.x / 2, (near.y - projected.y) * this.viewport.y / 2) <= radius) {
          const distance = ray.origin.distanceTo(glowCenter); if (!best || distance < best.distance) best = { id: actor.id, kind: actor.kind, distance, point: glowCenter };
        }
      }
      if (!actor.near && (actor.kind === 'vehicle' || bodyMix > 0)) {
        const normal = actor.kind === 'vehicle' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(-this.right.z, 0, this.right.x);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, p);
        if (!ray.intersectPlane(plane, hit)) continue;
        const delta = hit.clone().sub(p); let u: number, v: number;
        if (actor.kind === 'vehicle') { delta.applyAxisAngle(new THREE.Vector3(0, 1, 0), -heading); u = delta.x / 2 + 0.5; v = -delta.z / 5 + 0.5; }
        else { u = delta.dot(this.right) / 1.2255 + 0.5; v = delta.y / 1.8; }
        if (u < 0 || u > 1 || v < 0 || v > 1 || !this.spriteOpaque(actor, u, v)) continue;
        const distance = ray.origin.distanceTo(hit); if (!best || distance < best.distance) best = { id: actor.id, kind: actor.kind, distance, point: hit.clone() };
      }
    }
    return best;
  }
  private spriteOpaque(actor: Actor, u: number, v: number): boolean {
    if (!this.atlasAlpha) return false;
    const phase = (actor.seed % 65536) / 65536;
    const gait = actor.walking ? Math.floor(this.time * 4 + phase * 8) % 2 : 0;
    const x = actor.kind === 'vehicle' ? Math.floor(phase * 8) * 32 + Math.floor(u * 31) : (Math.floor(phase * 4) + gait * 4) * 32 + Math.floor(u * 31);
    const y = actor.kind === 'vehicle' ? 64 + Math.floor(v * 31) : 9 + Math.floor((1 - v) * 46);
    return this.atlasAlpha[(y * 256 + x) * 4 + 3]! >= 41;
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.abort.abort();
    for (const batch of this.batches) { batch.mesh.geometry.dispose(); batch.mesh.material.dispose(); }
    for (const template of this.templates) { template.positionTexture.dispose(); template.normalTexture.dispose(); }
    this.atlas?.dispose(); this.object.clear(); this.batches.length = this.templates.length = this.actors.length = 0;
    this.telemetry.state = 'disposed';
  }
}
