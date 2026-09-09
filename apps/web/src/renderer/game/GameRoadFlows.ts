import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import { WebMercatorViewport } from '@deck.gl/core';
import type { AggregateRoadFlowSnapshot } from '../aggregateRoadFlow';

export const GAME_ROAD_FLOW_CAP = 1024;

/**
 * Snapshot coordinates already passed through createPresentationMeterBridge.
 * They are Deck METER_OFFSETS, not the worker's 111320/110540 metre convention.
 * Invert that bridge using the pinned SDK's actual high-precision scales, then
 * convert to the same conformal Mercator metres as the Three city camera.
 */
export function createGameFlowCoordinateConverter(
  sourceOrigin: readonly [number, number], gameOrigin: readonly [number, number],
): (point: readonly [number, number, number], target?: THREE.Vector3) => THREE.Vector3 {
  const viewport = new WebMercatorViewport({ longitude: sourceOrigin[0], latitude: sourceOrigin[1], zoom: 0, width: 1, height: 1 });
  const scales = viewport.getDistanceScales([...sourceOrigin]) as ReturnType<WebMercatorViewport['getDistanceScales']> & { unitsPerMeter2?: readonly number[] };
  if (!scales.unitsPerMeter2 || !Number.isFinite(scales.unitsPerMeter2[0])) throw new Error('Aggregate flow high-precision scales are unavailable');
  const sourceWorld = viewport.projectPosition([sourceOrigin[0], sourceOrigin[1], 0]);
  const origin = MercatorCoordinate.fromLngLat([...gameOrigin]);
  const metre = origin.meterInMercatorCoordinateUnits();
  return (point, target = new THREE.Vector3()) => {
    if (!point.every(Number.isFinite)) throw new Error('Aggregate flow coordinate is not finite');
    const worldX = sourceWorld[0] + point[0] * (scales.unitsPerMeter[0]! + scales.unitsPerMeter2![0]! * point[1]);
    const worldY = sourceWorld[1] + point[1] * scales.unitsPerMeter[1]!;
    const longitude = worldX / 512 * 360 - 180;
    const latitude = (2 * Math.atan(Math.exp(worldY / 512 * (2 * Math.PI) - Math.PI)) - Math.PI / 2) * 180 / Math.PI;
    const mercator = MercatorCoordinate.fromLngLat([longitude, latitude], point[2]);
    return target.set((mercator.x - origin.x) / metre, mercator.z / metre, (mercator.y - origin.y) / metre);
  };
}

export const GAME_ROAD_FLOW_VERTEX_SHADER = /* glsl */`
attribute vec3 flowStart;
attribute vec3 flowEnd;
attribute vec2 flowTiming;
uniform float flowTime;
uniform vec2 cssViewport;
varying float flowOpacity;
varying vec2 flowUv;
void main() {
  float phase = fract(flowTiming.x + flowTime * flowTiming.y);
  vec3 current = mix(flowStart, flowEnd, phase);
  vec4 a = projectionMatrix * modelViewMatrix * vec4(flowStart, 1.0);
  vec4 b = projectionMatrix * modelViewMatrix * vec4(flowEnd, 1.0);
  vec4 anchor = projectionMatrix * modelViewMatrix * vec4(current, 1.0);
  vec2 projectedRoad = (b.xy / max(b.w,0.00001) - a.xy / max(a.w,0.00001)) * cssViewport * 0.5;
  float roadPixels = length(projectedRoad);
  vec2 direction = projectedRoad / max(roadPixels,0.0001);
  vec2 side = vec2(-direction.y,direction.x);
  float markLength = clamp(roadPixels * 0.16,6.0,12.0);
  vec2 offset = direction * position.x * markLength + side * position.y * 1.7;
  anchor.xy += offset * 2.0 / cssViewport * anchor.w;
  gl_Position = anchor;
  flowOpacity = smoothstep(0.0,0.08,phase) * (1.0-smoothstep(0.92,1.0,phase));
  flowOpacity *= step(0.001,anchor.w) * smoothstep(1.0,4.0,roadPixels);
  flowUv = uv;
}
`;
export const GAME_ROAD_FLOW_FRAGMENT_SHADER = /* glsl */`
varying float flowOpacity;
varying vec2 flowUv;
uniform float flowAlpha;
void main() {
  // Tapered, direction-bearing road streak: deliberately not an individual dot.
  float width = 1.0 - smoothstep(0.20,0.50,abs(flowUv.y-0.5));
  float head = smoothstep(0.0,0.2,flowUv.x) * (1.0-smoothstep(0.88,1.0,flowUv.x));
  float alpha = width * head * flowOpacity * flowAlpha;
  if (alpha < 0.035) discard;
  gl_FragColor = vec4(mix(vec3(0.35,0.76,0.72),vec3(0.76,0.98,0.84),flowUv.x),alpha);
}
`;

/** One retained draw, no picking, no renderer, no RAF and no per-frame geometry. */
export class GameRoadFlows {
  readonly object = new THREE.Group();
  readonly telemetry = { representation: 'schematic_road_flow' as const, segments: 0, bufferUpdates: 0, pickable: false as const };
  private readonly start = new THREE.InstancedBufferAttribute(new Float32Array(GAME_ROAD_FLOW_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
  private readonly end = new THREE.InstancedBufferAttribute(new Float32Array(GAME_ROAD_FLOW_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
  private readonly timing = new THREE.InstancedBufferAttribute(new Float32Array(GAME_ROAD_FLOW_CAP * 2), 2).setUsage(THREE.DynamicDrawUsage);
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly viewport = new THREE.Vector2(1920, 1080);
  private readonly material = new THREE.ShaderMaterial({
    vertexShader: GAME_ROAD_FLOW_VERTEX_SHADER, fragmentShader: GAME_ROAD_FLOW_FRAGMENT_SHADER,
    uniforms: { flowTime: { value: 0 }, cssViewport: { value: this.viewport }, flowAlpha: { value: 0.90 } },
    transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  private readonly mesh = new THREE.Mesh(this.geometry, this.material);
  private signature: string | null = null;
  private disposed = false;
  constructor(private readonly options: { origin: readonly [number, number] }) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry.setAttribute('position', quad.getAttribute('position')); this.geometry.setAttribute('uv', quad.getAttribute('uv')); this.geometry.setIndex(quad.index); quad.dispose();
    this.geometry.setAttribute('flowStart', this.start); this.geometry.setAttribute('flowEnd', this.end); this.geometry.setAttribute('flowTiming', this.timing); this.geometry.instanceCount = 0;
    this.mesh.name = 'game-schematic-road-flow'; this.mesh.frustumCulled = false; this.mesh.castShadow = false;
    this.mesh.raycast = () => {}; this.mesh.userData.pickable = false;
    this.object.name = 'game-road-flows'; this.object.add(this.mesh);
  }
  setSnapshot(snapshot: AggregateRoadFlowSnapshot | null): void {
    if (this.disposed || (snapshot?.signature ?? null) === this.signature) return;
    if (snapshot && snapshot.representation !== 'schematic_road_flow') throw new Error('Road streaks cannot represent individual agents');
    const segments = snapshot?.segments ?? [];
    if (segments.length > GAME_ROAD_FLOW_CAP) throw new RangeError('Game aggregate flow instance cap exceeded');
    const convert = snapshot ? createGameFlowCoordinateConverter(snapshot.origin, this.options.origin) : null;
    const point = new THREE.Vector3();
    // Validate before mutating retained GPU buffers.
    for (const segment of segments) if (!segment.start.every(Number.isFinite) || !segment.end.every(Number.isFinite)
      || !Number.isFinite(segment.phase) || !Number.isFinite(segment.speedMps) || !(segment.lengthMeters > 0)) throw new Error('Invalid source-backed road segment');
    segments.forEach((segment, index) => {
      convert!(segment.start, point); this.start.setXYZ(index, point.x, point.y, point.z);
      convert!(segment.end, point); this.end.setXYZ(index, point.x, point.y, point.z);
      this.timing.setXY(index, segment.phase, segment.speedMps / segment.lengthMeters);
    });
    this.start.needsUpdate = this.end.needsUpdate = this.timing.needsUpdate = true;
    this.geometry.instanceCount = segments.length; this.signature = snapshot?.signature ?? null;
    this.telemetry.segments = segments.length; this.telemetry.bufferUpdates++;
  }
  /** Small seconds since snapshot's declared presentation epoch; never Unix time. */
  setTime(elapsedPresentationSeconds: number): void {
    if (!Number.isFinite(elapsedPresentationSeconds) || Math.abs(elapsedPresentationSeconds) > 366 * 86400) throw new Error('Game flow time must be elapsed presentation seconds');
    this.material.uniforms.flowTime!.value = elapsedPresentationSeconds;
  }
  updateCamera(_camera: THREE.Camera, cssWidth: number, cssHeight: number): void {
    if (!(cssWidth > 0 && cssHeight > 0)) return;
    this.viewport.set(cssWidth, cssHeight);
  }
  /** Allows readiness-controlled crossfade without dropping pending detail prematurely. */
  setOpacity(opacity: number): void { this.material.uniforms.flowAlpha!.value = THREE.MathUtils.clamp(opacity, 0, 1); }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.geometry.dispose(); this.material.dispose(); this.object.clear(); this.telemetry.segments = 0;
  }
}
