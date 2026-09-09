import { MercatorCoordinate } from 'maplibre-gl';
import {
  BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, ShaderMaterial, Vector2,
} from 'three';
import { localToMercatorMatrix, type GameOrigin } from './cameraAdapter';
import { triangulateSourceWater, WATER_REPAIR_LIMITS } from './waterTriangulation';

export type GameWaterQualityTier = 'low' | 'medium' | 'high';
/** Structural subset of MapLibre's querySourceFeatures/queryRenderedFeatures result. */
export interface GameWaterFeature {
  id?: string | number;
  geometry: { type: string; coordinates?: unknown } | null;
}
export const GAME_WATER_LIMITS = {
  maxInputFeatures: 4096, maxInputVertices: 131072, maxPolygons: 512, maxRingsPerPolygon: 128,
  vertices: { low: 8192, medium: 32768, high: 65536 },
} as const;
export const GAME_WATER_PERIOD_METERS = 256;
const MERCATOR_CIRCUMFERENCE = 2 * Math.PI * 6378137;
const TIME_PERIOD_SECONDS = 120;
const TAU = 2 * Math.PI;
// Authored fine ripples with weak swell. Integral harmonics plus periodic domain
// distortion avoid both tile seams and the former long, coherent diagonal bands.
const RIPPLE_WAVES = [
  { x: 23, z: 17, height: .0020, time: 1, phase: .4 },
  { x: -19, z: 31, height: .0015, time: -2, phase: 2.7 },
] as const;
const RIPPLE_WARPS = [{x:5,z:-3,height:1.3,time:-1,phase:.8},{x:-4,z:7,height:1.1,time:2,phase:1.6}] as const;
const RIPPLE_NOISE = [{cells:96,weight:.030,phase:.7,time:1},{cells:192,weight:.017,phase:2.1,time:-2}] as const;
type Point = [number, number];
interface PreparedPolygon { key: string; rings: Point[][]; vertices: number }

function positiveModulo(value: number, period: number): number { return ((value % period) + period) % period; }
/** Analytic derivative of periodic, smoothly interpolated value noise. */
function noiseGradient(point:readonly number[],cells:number):Point{
  const ix=Math.floor(point[0]!),iz=Math.floor(point[1]!),x=point[0]!-ix,z=point[1]!-iz;
  const hash=(dx:number,dz:number)=>positiveModulo(Math.sin(positiveModulo(ix+dx,cells)*127.1+positiveModulo(iz+dz,cells)*311.7)*43758.5453123,1);
  const a=hash(0,0),b=hash(1,0),c=hash(0,1),d=hash(1,1),ux=x*x*(3-2*x),uz=z*z*(3-2*z);
  return [((b-a)*(1-uz)+(d-c)*uz)*6*x*(1-x),((c-a)*(1-ux)+(d-b)*ux)*6*z*(1-z)];
}
function surfaceOrigin(origin: GameOrigin) {
  localToMercatorMatrix(origin); // Keep the same origin validation as the shared camera.
  const point = MercatorCoordinate.fromLngLat([origin.longitude, origin.latitude]);
  return {
    point, scale: point.meterInMercatorCoordinateUnits() * MERCATOR_CIRCUMFERENCE,
    offset: [positiveModulo(point.x * MERCATOR_CIRCUMFERENCE, GAME_WATER_PERIOD_METERS),
      positiveModulo(point.y * MERCATOR_CIRCUMFERENCE, GAME_WATER_PERIOD_METERS)] as Point,
  };
}

/** Bounded phases equivalent to global Mercator metres; independent of tile UVs. */
export function waterSurfaceCoordinates(localEastSouth: readonly [number, number], origin: GameOrigin): Point {
  if (!localEastSouth.every(Number.isFinite)) throw new Error('Invalid water surface coordinate.');
  const surface = surfaceOrigin(origin);
  return [localEastSouth[0] * surface.scale + surface.offset[0], localEastSouth[1] * surface.scale + surface.offset[1]];
}

/** CPU reference for the authored shader field, used to verify seams and clocks. */
export function sampleGameWaterNormal(point: readonly [number, number], presentationSeconds: number, tier: GameWaterQualityTier): [number, number, number] {
  if (!point.every(Number.isFinite) || !Number.isFinite(presentationSeconds)) throw new Error('Invalid water normal sample.');
  if (tier === 'low') return [0, 1, 0];
  let dx = 0, dz = 0;
  const distorted=[...point],jacobian=[[1,0],[0,1]],frequency=TAU/GAME_WATER_PERIOD_METERS;
  RIPPLE_WARPS.forEach((warp,index)=>{
    const phase=(point[0]*warp.x+point[1]*warp.z)*frequency+presentationSeconds*warp.time*TAU/TIME_PERIOD_SECONDS+warp.phase;
    distorted[index]+=Math.sin(phase)*warp.height;
    jacobian[index]![0]+=Math.cos(phase)*warp.height*warp.x*frequency;
    jacobian[index]![1]+=Math.cos(phase)*warp.height*warp.z*frequency;
  });
  for (const wave of RIPPLE_WAVES) {
    const phase = (distorted[0]! * wave.x + distorted[1]! * wave.z) * frequency
      + presentationSeconds * wave.time * TAU / TIME_PERIOD_SECONDS + wave.phase;
    const slope = Math.cos(phase) * wave.height * frequency;
    dx += slope*(wave.x*jacobian[0]![0]!+wave.z*jacobian[1]![0]!);
    dz += slope*(wave.x*jacobian[0]![1]!+wave.z*jacobian[1]![1]!);
  }
  RIPPLE_NOISE.forEach((noise,index)=>{
    const frequency=noise.cells/GAME_WATER_PERIOD_METERS,phase=presentationSeconds*noise.time*TAU/TIME_PERIOD_SECONDS+noise.phase;
    const x=index?-distorted[1]!:distorted[0]!,z=index?distorted[0]!:distorted[1]!;
    const gradient=noiseGradient([x*frequency+Math.sin(phase)*1.7,z*frequency+Math.cos(phase)*1.3],noise.cells);
    const gx=index?gradient[1]:gradient[0],gz=index?-gradient[0]:gradient[1];
    dx+=(gx*jacobian[0]![0]!+gz*jacobian[1]![0]!)*noise.weight;
    dz+=(gx*jacobian[0]![1]!+gz*jacobian[1]![1]!)*noise.weight;
  });
  const length = Math.hypot(dx, 1, dz); return [-dx / length, 1 / length, -dz / length];
}

export const GAME_WATER_VERTEX_SHADER = /* glsl */`
uniform vec2 surfaceOffset;
uniform float surfaceScale;
varying vec2 waterSurface;
varying vec3 waterWorldPosition;
void main() {
  waterSurface = position.xz * surfaceScale + surfaceOffset;
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  waterWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const glsl = (value: number) => value.toFixed(10);
export const GAME_WATER_FRAGMENT_SHADER = /* glsl */`
uniform float waterTime;
uniform float rippleStrength;
varying vec2 waterSurface;
varying vec3 waterWorldPosition;
float waterHash(vec2 cell,float cells){
  return fract(sin(dot(mod(cell,cells),vec2(127.1,311.7)))*43758.5453123);
}
vec2 waterNoiseGradient(vec2 point,float cells){
  vec2 cell=floor(point),f=fract(point),u=f*f*(3.0-2.0*f),du=6.0*f*(1.0-f);
  float a=waterHash(cell,cells),b=waterHash(cell+vec2(1.0,0.0),cells);
  float c=waterHash(cell+vec2(0.0,1.0),cells),d=waterHash(cell+vec2(1.0,1.0),cells);
  return vec2(mix(b-a,d-c,u.y)*du.x,mix(c-a,d-b,u.x)*du.y);
}
void main() {
  vec2 slope = vec2(0.0);
  if(rippleStrength>0.0){
  vec2 distorted=waterSurface;
  vec2 gradientX=vec2(1.0,0.0),gradientZ=vec2(0.0,1.0);
  ${RIPPLE_WARPS.map((warp,index)=>`{
    vec2 frequency=vec2(${glsl(warp.x*TAU/GAME_WATER_PERIOD_METERS)},${glsl(warp.z*TAU/GAME_WATER_PERIOD_METERS)});
    float phase=dot(waterSurface,frequency)+waterTime*${glsl(warp.time*TAU/TIME_PERIOD_SECONDS)}+${glsl(warp.phase)};
    distorted.${index?'y':'x'}+=sin(phase)*${glsl(warp.height)};
    ${index?'gradientZ':'gradientX'}+=cos(phase)*${glsl(warp.height)}*frequency;
  }`).join('\n')}
  float footprint = max(length(dFdx(waterSurface)), length(dFdy(waterSurface)));
  ${RIPPLE_WAVES.map(wave => `{
    vec2 frequency = vec2(${glsl(wave.x * TAU / GAME_WATER_PERIOD_METERS)}, ${glsl(wave.z * TAU / GAME_WATER_PERIOD_METERS)});
    float phase = dot(distorted, frequency) + waterTime * ${glsl(wave.time * TAU / TIME_PERIOD_SECONDS)} + ${glsl(wave.phase)};
    vec2 phaseGradient=frequency.x*gradientX+frequency.y*gradientZ;
    float detail = 1.0 - smoothstep(0.6, 2.8, footprint * length(phaseGradient));
    slope += cos(phase) * phaseGradient * ${glsl(wave.height)} * detail;
  }`).join('\n')}
  ${RIPPLE_NOISE.map((noise,index)=>`{
    float phase=waterTime*${glsl(noise.time*TAU/TIME_PERIOD_SECONDS)}+${glsl(noise.phase)};
    vec2 point=${index?'vec2(-distorted.y,distorted.x)':'distorted'}*${glsl(noise.cells/GAME_WATER_PERIOD_METERS)}+vec2(sin(phase)*1.7,cos(phase)*1.3);
    vec2 gradient=waterNoiseGradient(point,${glsl(noise.cells)});
    ${index?'gradient=vec2(gradient.y,-gradient.x);':''}
    float detail=1.0-smoothstep(0.6,2.8,footprint*${glsl(noise.cells*TAU/GAME_WATER_PERIOD_METERS)});
    slope+=(gradient.x*gradientX+gradient.y*gradientZ)*${glsl(noise.weight)}*detail;
  }`).join('\n')}
  }
  vec3 normal = normalize(vec3(-slope.x * rippleStrength, 1.0, -slope.y * rippleStrength));
  vec3 viewDirection = normalize(cameraPosition - waterWorldPosition);
  // Bulk sky tint follows the flat surface; fine normals mainly shape soft glints.
  // Otherwise tiny slopes turn the whole river into broad alternating color bands.
  float facing = clamp(mix(viewDirection.y,dot(normal,viewDirection),0.18), 0.0, 1.0);
  float fresnel = 0.045 + 0.24 * pow(1.0 - facing, 4.0);
  vec3 lightDirection = normalize(vec3(-0.35, 0.88, 0.32));
  vec3 halfway = normalize(viewDirection + lightDirection);
  float highlight = pow(max(dot(normal, halfway), 0.0), 80.0) * 0.075;
  vec3 waterColor = vec3(0.055, 0.145, 0.165);
  vec3 skyColor = vec3(0.47, 0.61, 0.65);
  vec3 color = mix(waterColor, skyColor, fresnel) + vec3(0.87, 0.94, 0.96) * highlight;
  // A broad environment gradient supplies subdued reflected detail even when
  // the sun is outside the view. Its fine curved ripple field is zero-centred.
  float environmentDetail=clamp(dot(slope,vec2(-0.62,0.78))*1.6,-0.04,0.04)*rippleStrength;
  color+=vec3(0.28,0.35,0.37)*environmentDetail;
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function comparePoints(a: Point, b: Point): number { return a[0] - b[0] || a[1] - b[1]; }
function samePoint(a: Point, b: Point): boolean { return a[0] === b[0] && a[1] === b[1]; }
function canonicalRing(value: unknown): Point[] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const points: Point[] = [];
  for (const candidate of value) {
    if (!Array.isArray(candidate) || candidate.length < 2 || !Number.isFinite(candidate[0]) || !Number.isFinite(candidate[1])
      || Math.abs(candidate[0]) > 180 || Math.abs(candidate[1]) >= 85.051129) return null;
    const point: Point = [candidate[0], candidate[1]];
    if (!points.length || !samePoint(points[points.length - 1], point)) points.push(point);
  }
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  if (points.length < 3) return null;
  let start = 0;
  for (let i = 1; i < points.length; i++) if (comparePoints(points[i], points[start]) < 0) start = i;
  const forward = Array.from({ length: points.length }, (_, i) => points[(start + i) % points.length]);
  const backward = Array.from({ length: points.length }, (_, i) => points[(start - i + points.length) % points.length]);
  for (let i = 1; i < points.length; i++) {
    const comparison = comparePoints(forward[i], backward[i]);
    if (comparison !== 0) return comparison < 0 ? forward : backward;
  }
  return forward;
}
function polygonRings(value: unknown): Point[][] | null {
  if (!Array.isArray(value) || !value.length || value.length > GAME_WATER_LIMITS.maxRingsPerPolygon) return null;
  const rings = value.map(canonicalRing);
  if (rings.some(ring => !ring)) return null;
  const valid = rings as Point[][];
  const holes = valid.slice(1).sort((a, b) => {
    const first = JSON.stringify(a), second = JSON.stringify(b); return first < second ? -1 : first > second ? 1 : 0;
  });
  return [valid[0], ...holes];
}

/** One opaque retained draw over actual source water. No global plane or scheduler. */
export class GameWater {
  readonly object = new Group();
  readonly telemetry = {
    representation: 'source_water_visual_synthesis' as const, polygons: 0, vertices: 0, triangles: 0,
    duplicates: 0, skippedFeatures: 0, truncatedPolygons: 0, geometryUpdates: 0,
    geometryBytes: 0, retainedBytes: 0, static: false,
    repairedPolygons: 0, repairIntersections: 0,
  };
  private readonly material = new ShaderMaterial({
    vertexShader: GAME_WATER_VERTEX_SHADER, fragmentShader: GAME_WATER_FRAGMENT_SHADER,
    uniforms: { surfaceOffset: { value: new Vector2() }, surfaceScale: { value: 1 }, waterTime: { value: 0 }, rippleStrength: { value: 1 } },
    transparent: false, depthTest: true, depthWrite: true, side: DoubleSide, toneMapped: true,
  });
  private readonly mesh = new Mesh(new BufferGeometry(), this.material);
  private signature: string | null = null;
  private rejectedPolygons = 0;
  private tier: GameWaterQualityTier = 'medium';
  private time = 0;
  private disposed = false;

  constructor() {
    this.object.name = 'game-source-water'; this.mesh.name = 'game-source-water-surface';
    this.mesh.visible = false; this.mesh.castShadow = false; this.mesh.receiveShadow = false;
    this.mesh.userData.representation = this.telemetry.representation;
    this.mesh.userData.pickable = false; this.mesh.raycast = () => {};
    this.object.add(this.mesh);
  }

  /** Call on source/camera coverage updates, never each animation frame. */
  update(features: readonly GameWaterFeature[], origin: GameOrigin, tier: GameWaterQualityTier) {
    if (this.disposed) return this.telemetry;
    if (features.length > GAME_WATER_LIMITS.maxInputFeatures) throw new RangeError('Source-water feature limit exceeded.');
    if (!(tier in GAME_WATER_LIMITS.vertices)) throw new Error('Invalid water quality tier.');
    const surface = surfaceOrigin(origin), unique = new Map<string, PreparedPolygon>();
    let inputVertices = 0, duplicates = 0, skippedFeatures = 0;
    for (const feature of features) {
      const geometry = feature.geometry;
      const candidates: unknown[] = geometry?.type === 'Polygon' ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
      if (!candidates.length) { skippedFeatures++; continue; }
      if (candidates.length > GAME_WATER_LIMITS.maxInputFeatures) throw new RangeError('Source-water polygon input limit exceeded.');
      let validFeature = false;
      for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length > GAME_WATER_LIMITS.maxRingsPerPolygon) continue;
        if (Array.isArray(candidate)) for (const ring of candidate) {
          if (Array.isArray(ring)) inputVertices += ring.length;
          if (inputVertices > GAME_WATER_LIMITS.maxInputVertices) throw new RangeError('Source-water input vertex limit exceeded.');
        }
        const rings = polygonRings(candidate);
        if (!rings) continue;
        validFeature = true;
        const key = JSON.stringify(rings);
        if (unique.has(key)) { duplicates++; continue; }
        unique.set(key, { key, rings, vertices: rings.reduce((sum, ring) => sum + ring.length, 0) });
      }
      if (!validFeature) skippedFeatures++;
    }
    const selected: PreparedPolygon[] = [];
    let requestedVertices = 0, truncatedPolygons = 0;
    for (const polygon of [...unique.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) {
      if (selected.length >= GAME_WATER_LIMITS.maxPolygons || requestedVertices + polygon.vertices > GAME_WATER_LIMITS.vertices[tier]) { truncatedPolygons++; continue; }
      selected.push(polygon); requestedVertices += polygon.vertices;
    }
    const signature = JSON.stringify([origin.longitude, origin.latitude, origin.altitude ?? 0, selected.map(polygon => polygon.key)]);
    if (signature !== this.signature) {
      const positions: number[] = [], indices: number[] = [];
      let polygons = 0, rejectedPolygons = 0, repairedPolygons = 0, repairIntersections = 0;
      const repairBudget = { remaining: WATER_REPAIR_LIMITS.pairChecks };
      const meter = surface.point.meterInMercatorCoordinateUnits();
      for (const polygon of selected) {
        const rings = polygon.rings.map(ring => ring.map(([longitude, latitude]) => {
          const point = MercatorCoordinate.fromLngLat([longitude, latitude]);
          return new Vector2((point.x - surface.point.x) / meter, (point.y - surface.point.y) / meter);
        }));
        const triangulated = triangulateSourceWater(rings, repairBudget);
        // Repair source clipping intersections, but still reject ambiguous land/water topology.
        if (!triangulated || positions.length / 3 + triangulated.points.length > GAME_WATER_LIMITS.vertices[tier]) { rejectedPolygons++; continue; }
        const flattened = triangulated.points, triangles = triangulated.triangles;
        if (triangulated.repairedIntersections) { repairedPolygons++; repairIntersections += triangulated.repairedIntersections; }
        const offset = positions.length / 3;
        // Same Mercator ground as MapLibre. A small water-only offset prevents depth flicker.
        for (const point of flattened) positions.push(point.x, 0.025 - (origin.altitude ?? 0), point.y);
        for (const [a, b, c] of triangles) indices.push(offset + a, offset + b, offset + c);
        polygons++;
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3)); geometry.setIndex(indices);
      if (positions.length) { geometry.computeBoundingBox(); geometry.computeBoundingSphere(); }
      const previous = this.mesh.geometry; this.mesh.geometry = geometry; previous.dispose();
      this.mesh.visible = indices.length > 0; this.signature = signature;
      this.rejectedPolygons = rejectedPolygons;
      this.telemetry.polygons = polygons; this.telemetry.vertices = positions.length / 3;
      this.telemetry.triangles = indices.length / 3; this.telemetry.geometryUpdates++;
      this.telemetry.repairedPolygons = repairedPolygons; this.telemetry.repairIntersections = repairIntersections;
      this.telemetry.geometryBytes = geometry.getAttribute('position').array.byteLength + (geometry.getIndex()?.array.byteLength ?? 0);
      // CPU typed arrays plus estimated GPU mirror, and retained dedup signature.
      this.telemetry.retainedBytes = this.telemetry.geometryBytes * 2 + signature.length * 2;
    }
    this.material.uniforms.surfaceOffset.value.set(...surface.offset);
    this.material.uniforms.surfaceScale.value = surface.scale;
    this.tier = tier; this.telemetry.static = tier === 'low';
    this.material.uniforms.rippleStrength.value = tier === 'low' ? 0 : 1;
    this.setTime(this.time);
    this.telemetry.duplicates = duplicates; this.telemetry.skippedFeatures = skippedFeatures + this.rejectedPolygons;
    this.telemetry.truncatedPolygons = truncatedPolygons;
    return this.telemetry;
  }

  /** Existing presentation clock only: pause is repeated time, with no new work. */
  setTime(presentationSeconds: number): void {
    if (!Number.isFinite(presentationSeconds)) throw new Error('Invalid water presentation clock.');
    this.time = presentationSeconds;
    this.material.uniforms.waterTime.value = this.tier === 'low' ? 0 : positiveModulo(presentationSeconds, TIME_PERIOD_SECONDS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.mesh.geometry.dispose(); this.material.dispose(); this.object.clear();
    this.signature = null; this.telemetry.polygons = this.telemetry.vertices = this.telemetry.triangles = 0;
    this.telemetry.repairedPolygons = this.telemetry.repairIntersections = 0;
    this.telemetry.geometryBytes = this.telemetry.retainedBytes = 0;
  }
}
