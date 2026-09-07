export enum LivingMovementEdgeMode {
  SIDEWALK = 0,
  CROSSWALK = 1,
  LANE = 2,
}

export enum LivingMovementEdgeDirection {
  BIDIRECTIONAL = 0,
  FORWARD = 1,
  REVERSE = 2,
}

export type LivingRouteTraversal = 'loop' | 'ping_pong' | 'once';

export type LivingRouteKind = 'pedestrian' | 'vehicle';

export interface LivingMovementNodeInput {
  id: string;
  x: number;
  y: number;
}

export interface LivingMovementEdgeInput {
  id: string;
  from: string;
  to: string;
  mode: 'sidewalk' | 'crosswalk' | 'lane';
  /** A road crossing is valid only when explicitly compiled as a crosswalk. */
  crossesRoad: boolean;
  /** Presentation-only speed compiled from the selected allowed mode. */
  visualSpeedMetersPerSecond: number;
  direction: 'bidirectional' | 'forward' | 'reverse';
  /** Optional authored polyline in local scene metres, including both endpoints. */
  points?: readonly (readonly [x: number, y: number])[];
}

export interface LivingMovementRouteInput {
  id: string;
  kind: LivingRouteKind;
  edgeIds: readonly string[];
  traversal: LivingRouteTraversal;
  /** Optional mode-specific speed for each edge in edgeIds order. */
  visualSpeedMetersPerSecondByEdge?: readonly number[];
}

export interface LivingMovementGraphInput {
  nodes: readonly LivingMovementNodeInput[];
  edges: readonly LivingMovementEdgeInput[];
  routes: readonly LivingMovementRouteInput[];
}

export interface CompiledLivingRoute {
  id: string;
  kind: LivingRouteKind;
  edgeIndices: Uint32Array;
  cumulativeLengthMeters: Float32Array;
  cumulativeTravelSeconds: Float32Array;
  lengthMeters: number;
  durationSeconds: number;
  closed: boolean;
  traversal: LivingRouteTraversal;
  edgeDirections: Int8Array;
}

export interface CompiledLivingMovementGraph {
  nodeIds: readonly string[];
  nodeX: Float32Array;
  nodeY: Float32Array;
  edgeIds: readonly string[];
  edgeFrom: Uint32Array;
  edgeTo: Uint32Array;
  edgeMode: Uint8Array;
  edgeLengthMeters: Float32Array;
  edgeVisualSpeedMetersPerSecond: Float32Array;
  edgeDirection: Uint8Array;
  edgePointOffsets: Uint32Array;
  edgePointX: Float32Array;
  edgePointY: Float32Array;
  routes: readonly CompiledLivingRoute[];
  routeIndexById: ReadonlyMap<string, number>;
}

function uniqueIndex(values: readonly string[], label: string): Map<string, number> {
  const result = new Map<string, number>();
  values.forEach((value, index) => {
    if (!value || result.has(value)) throw new Error(`Living movement graph has duplicate or empty ${label} id: ${value}`);
    result.set(value, index);
  });
  return result;
}

function edgeModeCode(edge: LivingMovementEdgeInput): LivingMovementEdgeMode {
  if (edge.mode === 'crosswalk') return LivingMovementEdgeMode.CROSSWALK;
  if (edge.mode === 'lane') return LivingMovementEdgeMode.LANE;
  return LivingMovementEdgeMode.SIDEWALK;
}

export function compileLivingMovementGraph(
  input: LivingMovementGraphInput,
): CompiledLivingMovementGraph {
  const nodeIds = input.nodes.map(({ id }) => id);
  const edgeIds = input.edges.map(({ id }) => id);
  const routeIds = input.routes.map(({ id }) => id);
  const nodeIndex = uniqueIndex(nodeIds, 'node');
  const edgeIndex = uniqueIndex(edgeIds, 'edge');
  const routeIndexById = uniqueIndex(routeIds, 'route');
  const nodeX = Float32Array.from(input.nodes.map(({ x }) => x));
  const nodeY = Float32Array.from(input.nodes.map(({ y }) => y));
  input.nodes.forEach((node) => {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      throw new Error(`Living movement node ${node.id} has invalid local coordinates`);
    }
  });
  const edgeFrom = new Uint32Array(input.edges.length);
  const edgeTo = new Uint32Array(input.edges.length);
  const edgeMode = new Uint8Array(input.edges.length);
  const edgeLengthMeters = new Float32Array(input.edges.length);
  const edgeVisualSpeedMetersPerSecond = new Float32Array(input.edges.length);
  const edgeDirection = new Uint8Array(input.edges.length);
  const edgePointOffsets = new Uint32Array(input.edges.length + 1);
  const pointX: number[] = [];
  const pointY: number[] = [];

  input.edges.forEach((edge, index) => {
    if (edge.mode !== 'sidewalk' && edge.mode !== 'crosswalk' && edge.mode !== 'lane') {
      throw new Error(`Living edge ${edge.id} has invalid movement mode`);
    }
    if (typeof edge.crossesRoad !== 'boolean') {
      throw new Error(`Living edge ${edge.id} is missing explicit road-crossing semantics`);
    }
    if (edge.direction !== 'bidirectional'
      && edge.direction !== 'forward'
      && edge.direction !== 'reverse') {
      throw new Error(`Living edge ${edge.id} has invalid direction`);
    }
    const from = nodeIndex.get(edge.from);
    const to = nodeIndex.get(edge.to);
    if (from === undefined || to === undefined) throw new Error(`Living edge ${edge.id} references an unknown node`);
    const mode = edgeModeCode(edge);
    if (edge.crossesRoad !== (mode === LivingMovementEdgeMode.CROSSWALK)) {
      throw new Error(`Living edge ${edge.id} must use crosswalk mode if and only if it crosses a road`);
    }
    const points = edge.points ?? [
      [nodeX[from]!, nodeY[from]!] as const,
      [nodeX[to]!, nodeY[to]!] as const,
    ];
    if (points.length < 2) throw new Error(`Living edge ${edge.id} polyline has fewer than two points`);
    const endpointTolerance = 0.05;
    if (Math.hypot(points[0]![0] - nodeX[from]!, points[0]![1] - nodeY[from]!) > endpointTolerance
      || Math.hypot(points.at(-1)![0] - nodeX[to]!, points.at(-1)![1] - nodeY[to]!) > endpointTolerance) {
      throw new Error(`Living edge ${edge.id} polyline endpoints do not match graph nodes`);
    }
    edgePointOffsets[index] = pointX.length;
    let length = 0;
    points.forEach((point, pointIndex) => {
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        throw new Error(`Living edge ${edge.id} polyline has invalid coordinates`);
      }
      if (pointIndex > 0) {
        const previous = points[pointIndex - 1]!;
        const segmentLength = Math.hypot(point[0] - previous[0], point[1] - previous[1]);
        if (!(segmentLength > 0)) throw new Error(`Living edge ${edge.id} polyline has a zero-length segment`);
        length += segmentLength;
      }
      pointX.push(point[0]);
      pointY.push(point[1]);
    });
    if (!(length > 0)) throw new Error(`Living edge ${edge.id} has zero length`);
    if (!(edge.visualSpeedMetersPerSecond > 0) || !Number.isFinite(edge.visualSpeedMetersPerSecond)) {
      throw new Error(`Living edge ${edge.id} has invalid visual speed`);
    }
    edgeFrom[index] = from;
    edgeTo[index] = to;
    edgeMode[index] = mode;
    edgeLengthMeters[index] = length;
    edgeVisualSpeedMetersPerSecond[index] = edge.visualSpeedMetersPerSecond;
    edgeDirection[index] = edge.direction === 'reverse'
      ? LivingMovementEdgeDirection.REVERSE
      : edge.direction === 'forward'
        ? LivingMovementEdgeDirection.FORWARD
        : LivingMovementEdgeDirection.BIDIRECTIONAL;
    edgePointOffsets[index + 1] = pointX.length;
  });

  const routes = input.routes.map<CompiledLivingRoute>((route) => {
    if (route.kind !== 'pedestrian' && route.kind !== 'vehicle') {
      throw new Error(`Living route ${route.id} has invalid route kind`);
    }
    if (route.traversal !== 'loop'
      && route.traversal !== 'ping_pong'
      && route.traversal !== 'once') {
      throw new Error(`Living route ${route.id} has invalid traversal`);
    }
    const traversal = route.traversal;
    if (route.edgeIds.length === 0) throw new Error(`Living route ${route.id} is empty`);
    if (route.visualSpeedMetersPerSecondByEdge
      && route.visualSpeedMetersPerSecondByEdge.length !== route.edgeIds.length) {
      throw new Error(`Living route ${route.id} mode-speed inventory does not match its edges`);
    }
    const indices = route.edgeIds.map((id) => {
      const index = edgeIndex.get(id);
      if (index === undefined) throw new Error(`Living route ${route.id} references unknown edge ${id}`);
      const mode = edgeMode[index];
      if (route.kind === 'vehicle' && mode !== LivingMovementEdgeMode.LANE) {
        throw new Error(`Vehicle route ${route.id} leaves the lane graph at ${id}`);
      }
      if (route.kind === 'pedestrian' && mode === LivingMovementEdgeMode.LANE) {
        throw new Error(`Pedestrian route ${route.id} enters a lane without a crosswalk at ${id}`);
      }
      return index;
    });
    const directions = Int8Array.from(indices, (index) => (
      edgeDirection[index] === LivingMovementEdgeDirection.REVERSE ? -1 : 1
    ));
    if (traversal === 'ping_pong' && indices.some(
      (index) => edgeDirection[index] !== LivingMovementEdgeDirection.BIDIRECTIONAL,
    )) {
      throw new Error(`Ping-pong living route ${route.id} attempts to invert a directed edge`);
    }
    for (let index = 1; index < indices.length; index += 1) {
      const previousTo = directions[index - 1] === 1
        ? edgeTo[indices[index - 1]!] : edgeFrom[indices[index - 1]!];
      const nextFrom = directions[index] === 1
        ? edgeFrom[indices[index]!] : edgeTo[indices[index]!];
      if (previousTo !== nextFrom) {
        throw new Error(`Living route ${route.id} is disconnected between ${route.edgeIds[index - 1]} and ${route.edgeIds[index]}`);
      }
    }
    const lastTo = directions.at(-1) === 1 ? edgeTo[indices.at(-1)!] : edgeFrom[indices.at(-1)!];
    const firstFrom = directions[0] === 1 ? edgeFrom[indices[0]!] : edgeTo[indices[0]!];
    if (traversal === 'loop' && lastTo !== firstFrom) {
      throw new Error(`Closed living route ${route.id} does not return to its first node`);
    }
    const cumulativeLengthMeters = new Float32Array(indices.length + 1);
    const cumulativeTravelSeconds = new Float32Array(indices.length + 1);
    for (let index = 0; index < indices.length; index += 1) {
      cumulativeLengthMeters[index + 1] = cumulativeLengthMeters[index]! + edgeLengthMeters[indices[index]!]!;
      const routeSpeed = route.visualSpeedMetersPerSecondByEdge?.[index]
        ?? edgeVisualSpeedMetersPerSecond[indices[index]!]!;
      if (!(routeSpeed > 0) || !Number.isFinite(routeSpeed)) {
        throw new Error(`Living route ${route.id} has invalid mode speed at ${route.edgeIds[index]}`);
      }
      cumulativeTravelSeconds[index + 1] = cumulativeTravelSeconds[index]!
        + edgeLengthMeters[indices[index]!]! / routeSpeed;
    }
    return {
      id: route.id,
      kind: route.kind,
      edgeIndices: Uint32Array.from(indices),
      cumulativeLengthMeters,
      cumulativeTravelSeconds,
      lengthMeters: cumulativeLengthMeters.at(-1)!,
      durationSeconds: cumulativeTravelSeconds.at(-1)!,
      closed: traversal === 'loop',
      traversal,
      edgeDirections: directions,
    };
  });
  return {
    nodeIds,
    nodeX,
    nodeY,
    edgeIds,
    edgeFrom,
    edgeTo,
    edgeMode,
    edgeLengthMeters,
    edgeVisualSpeedMetersPerSecond,
    edgeDirection,
    edgePointOffsets,
    edgePointX: Float32Array.from(pointX),
    edgePointY: Float32Array.from(pointY),
    routes,
    routeIndexById,
  };
}

export function cloneCompiledLivingMovementGraph(
  graph: CompiledLivingMovementGraph,
): CompiledLivingMovementGraph {
  const routes = graph.routes.map((route) => ({
    ...route,
    edgeIndices: new Uint32Array(route.edgeIndices),
    cumulativeLengthMeters: new Float32Array(route.cumulativeLengthMeters),
    cumulativeTravelSeconds: new Float32Array(route.cumulativeTravelSeconds),
    edgeDirections: new Int8Array(route.edgeDirections),
  }));
  return {
    nodeIds: [...graph.nodeIds],
    nodeX: new Float32Array(graph.nodeX),
    nodeY: new Float32Array(graph.nodeY),
    edgeIds: [...graph.edgeIds],
    edgeFrom: new Uint32Array(graph.edgeFrom),
    edgeTo: new Uint32Array(graph.edgeTo),
    edgeMode: new Uint8Array(graph.edgeMode),
    edgeLengthMeters: new Float32Array(graph.edgeLengthMeters),
    edgeVisualSpeedMetersPerSecond: new Float32Array(graph.edgeVisualSpeedMetersPerSecond),
    edgeDirection: new Uint8Array(graph.edgeDirection),
    edgePointOffsets: new Uint32Array(graph.edgePointOffsets),
    edgePointX: new Float32Array(graph.edgePointX),
    edgePointY: new Float32Array(graph.edgePointY),
    routes,
    routeIndexById: new Map(routes.map((route, index) => [route.id, index])),
  };
}
