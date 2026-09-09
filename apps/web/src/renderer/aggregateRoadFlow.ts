import type { ShaderModule } from '@luma.gl/shadertools';

export interface AggregateRoadFlowSegment {
  readonly id: string;
  readonly sourceRoadId: string;
  readonly start: readonly [number, number, number];
  readonly end: readonly [number, number, number];
  readonly phase: number;
  readonly speedMps: number;
  readonly lengthMeters: number;
}

/** Query-row diagnostics, not traffic/population counts; duplicate tiles count as input rows. */
export interface AggregateRoadFlowDiagnostics {
  readonly inputRoads: number;
  readonly invalidRoads: number;
  readonly excludedNonDrivableRoads: number;
  readonly scannedSegments: number;
  readonly invalidSegments: number;
  readonly skippedShortSegments: number;
  readonly outsideDistanceSegments: number;
  readonly withinDistanceSegments: number;
  readonly peakRetainedCandidates: number;
  /** Allocation diagnostics describe source geometry coverage, not traffic density. */
  readonly allocation?: 'nearest_radius' | 'viewport_grid';
  readonly outsideViewportSegments?: number;
  readonly viewportColumns?: number;
  readonly viewportRows?: number;
  readonly occupiedViewportCells?: number;
  readonly selectedViewportCells?: number;
}

/** Each mark is schematic direction on a road, never a person, car or traffic count. */
export interface AggregateRoadFlowSnapshot {
  readonly representation: 'schematic_road_flow';
  readonly sourceLabel: string;
  readonly signature: string;
  readonly origin: readonly [number, number];
  readonly timeOriginSeconds: number;
  readonly segments: readonly AggregateRoadFlowSegment[];
  readonly diagnostics: AggregateRoadFlowDiagnostics;
}

export function aggregateFlowPhase(segment: Pick<AggregateRoadFlowSegment, 'phase' | 'speedMps' | 'lengthMeters'>, elapsedSeconds: number): number {
  const phase = segment.phase + elapsedSeconds * segment.speedMps / segment.lengthMeters;
  return ((phase % 1) + 1) % 1;
}

export const aggregateRoadFlowUniforms = {
  name: 'omnitwinAggregateFlow',
  vs: `layout(std140) uniform omnitwinAggregateFlowUniforms { float elapsedSeconds; } omnitwinAggregateFlow;
    in vec3 instanceFlowEnds;
    in vec2 instanceFlowTiming;
    out float vFlowOpacity;`,
  fs: 'in float vFlowOpacity;',
  uniformTypes: { elapsedSeconds: 'f32' },
  defaultUniforms: { elapsedSeconds: 0 },
  inject: {
    'vs:DECKGL_FILTER_GL_POSITION': `
      float flowPhase = fract(instanceFlowTiming.x + omnitwinAggregateFlow.elapsedSeconds * instanceFlowTiming.y);
      vec3 flowAnchor = mix(geometry.worldPosition, instanceFlowEnds, flowPhase);
      vec4 flowOriginal = project_position_to_clipspace(geometry.worldPosition, vec3(0.0), vec3(0.0));
      vec4 flowCurrent = project_position_to_clipspace(flowAnchor, vec3(0.0), vec3(0.0));
      position += flowCurrent - flowOriginal;
      vFlowOpacity = smoothstep(0.0, 0.08, flowPhase) * (1.0 - smoothstep(0.92, 1.0, flowPhase));
    `,
    'fs:DECKGL_FILTER_COLOR': 'color.a *= vFlowOpacity;',
  },
} as const satisfies ShaderModule<{ elapsedSeconds: number }>;
