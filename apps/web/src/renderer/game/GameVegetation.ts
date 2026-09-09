import {
  BufferGeometry, Color, CylinderGeometry, Group, InstancedBufferAttribute, InstancedMesh,
  Matrix4, MeshStandardMaterial, Quaternion, Vector3,
} from 'three';
import { localToMercatorMatrix, type GameOrigin } from './cameraAdapter';
import { GAME_VEGETATION_LIMITS, prepareGameVegetation, type GameTreePlacement, type GameVegetationFeature, type GameVegetationOptions } from './gameVegetationPlacement';
import {createGameTreeCanopy,gameTreeAppearance} from './gameTreeAppearance';
export { GAME_VEGETATION_LIMITS, GAME_VEGETATION_ROAD_WIDTHS, prepareGameVegetation } from './gameVegetationPlacement';
export type { GameTreePlacement, GameVegetationFeature, GameVegetationOptions, GameVegetationRoad } from './gameVegetationPlacement';

function geometryBytes(geometry: BufferGeometry) {
  return Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0)
    + (geometry.index?.array.byteLength ?? 0);
}

/** Three opaque instanced draws in the existing scene. No scheduler, canvas or animation loop. */
export class GameVegetation {
  readonly object = new Group();
  readonly telemetry = {
    representation: 'visual_synthesis' as const,
    state: 'empty' as 'empty' | 'ready' | 'loading_retained' | 'unverified_retained' | 'error_retained' | 'disposed',
    instances: 0, draws: 0, geometryBytes: 0, bufferBytes: 0, retainedBytes: 0, bufferUpdates: 0,
    sourceAreas: 0, sourceTrees: 0, sourceWidthRoads: 0, laneWidthRoads: 0, classWidthRoads: 0, rejectedCandidates: 0,
    lastError: null as string | null,
    roadWidthPolicy: 'source_width_else_visual_lanes_3m_plus_0_6m_else_visual_class_width' as const,
    collisionPolicy: 'crown_radius_plus_2_5m' as const, truncated: false, operations: 0,
    appearancePolicy:'continuous_broad_or_upright_canopy_v2' as const,
  };
  private disposed = false;
  private meshes: InstancedMesh<BufferGeometry, MeshStandardMaterial>[] = [];
  private signature = '';
  private origin: GameOrigin | null = null;
  private placementValues: GameTreePlacement[] = [];
  get placements(): readonly GameTreePlacement[] { return this.placementValues; }

  constructor() {
    this.object.name = 'source-backed-city-vegetation'; this.object.userData.provenance = 'visual_synthesis';
    this.object.matrixAutoUpdate = false;
  }

  private initializeMeshes(): void {
    if (this.meshes.length) return;
    const trunk = new CylinderGeometry(.045, .09, .58, 7, 1).translate(0, .29, 0);
    const forms = [trunk,createGameTreeCanopy(0),createGameTreeCanopy(1)];
    this.meshes = forms.map((geometry, index) => {
      const material = new MeshStandardMaterial({ color:'#ffffff',roughness:1,vertexColors:index!==0 });
      const mesh = new InstancedMesh(geometry, material, GAME_VEGETATION_LIMITS.instances.high);
      mesh.name = `source-tree-${index === 0 ? 'trunks' : `crowns-${index}`}`;
      mesh.userData.provenance = 'visual_synthesis'; mesh.count = 0; mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(GAME_VEGETATION_LIMITS.instances.high * 3).fill(1), 3);
      this.object.add(mesh); return mesh;
    });
    this.telemetry.geometryBytes = this.meshes.reduce((sum, mesh) => sum + geometryBytes(mesh.geometry), 0);
    this.telemetry.bufferBytes = this.meshes.reduce((sum, mesh) => sum + mesh.instanceMatrix.array.byteLength + mesh.instanceColor!.array.byteLength, 0);
  }

  private retainAtOrigin(origin: GameOrigin): void {
    if (!this.origin) return;
    try {
      this.object.matrix.copy(localToMercatorMatrix(origin).invert().multiply(localToMercatorMatrix(this.origin)));
      this.object.matrixWorldNeedsUpdate = true;
    } catch { /* Preserve the last valid coordinate transform along with the last valid source state. */ }
  }

  update(features: readonly GameVegetationFeature[], options: GameVegetationOptions): void {
    if (this.disposed) return;
    if (options.loading) { this.telemetry.state = 'loading_retained'; this.retainAtOrigin(options.origin); return; }
    if (!options.buildings || options.buildings.coverage !== 'complete_viewport' || options.buildings.invalidBuildings || options.buildings.omittedBuildings) {
      this.telemetry.state = 'unverified_retained'; this.retainAtOrigin(options.origin); return;
    }
    try {
      const prepared = prepareGameVegetation(features, options);
      const signature = JSON.stringify(prepared.placements.map(p => [p.id, p.x, p.y, p.z, p.radius, p.height, p.rotation, p.color]));
      Object.assign(this.telemetry, prepared.diagnostics);
      this.placementValues = prepared.placements;
      if (signature !== this.signature) {
        this.initializeMeshes();
        const matrix = new Matrix4(), rotation = new Quaternion(), axis = new Vector3(0, 1, 0), position = new Vector3(), scale = new Vector3();
        const color = new Color(),counts=[0,0,0];
        for (let i = 0; i < prepared.placements.length; i++) {
          const tree = prepared.placements[i]!;
          const appearance=gameTreeAppearance(tree.id),canopyIndex=appearance.family+1;
          matrix.compose(position.set(tree.x, tree.y, tree.z), rotation.setFromAxisAngle(axis, tree.rotation), scale.set(tree.radius, tree.height, tree.radius));
          this.meshes[0]!.setMatrixAt(counts[0]!,matrix);
          this.meshes[0]!.setColorAt(counts[0]!,color.set(appearance.trunkColor));counts[0]!++;
          matrix.compose(position.set(tree.x,tree.y+tree.height*appearance.offsetY,tree.z),rotation,
            scale.set(tree.radius*appearance.scaleX,tree.height*appearance.scaleY,tree.radius*appearance.scaleZ));
          this.meshes[canopyIndex]!.setMatrixAt(counts[canopyIndex]!,matrix);
          this.meshes[canopyIndex]!.setColorAt(counts[canopyIndex]!,color.set(appearance.leafColor).multiplyScalar(appearance.brightness));counts[canopyIndex]!++;
        }
        for (let part=0;part<this.meshes.length;part++) {
          const mesh=this.meshes[part]!;
          mesh.count = counts[part]!; mesh.visible = mesh.count > 0;
          mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor!.needsUpdate = true;
          if (mesh.count) { mesh.computeBoundingBox(); mesh.computeBoundingSphere(); }
        }
        this.signature = signature; this.telemetry.bufferUpdates++;
      }
      this.origin = { ...options.origin }; this.object.matrix.identity(); this.object.matrixWorldNeedsUpdate = true;
      this.telemetry.instances = prepared.placements.length; this.telemetry.draws = this.meshes.filter(mesh=>mesh.count>0).length;
      // Typed geometry and instance buffers count both retained CPU and estimated GPU copies.
      this.telemetry.retainedBytes = (this.telemetry.geometryBytes + this.telemetry.bufferBytes) * 2
        + signature.length * 2 + prepared.placements.reduce((sum, p) => sum + 128 + (p.id.length + p.sourceKey.length) * 2, 0);
      this.telemetry.state = 'ready';
      this.telemetry.lastError = null;
    } catch (error) {
      this.telemetry.state = 'error_retained'; this.retainAtOrigin(options.origin);
      this.telemetry.lastError = error instanceof Error ? error.message.slice(0, 160) : 'Vegetation preparation failed';
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.meshes) { mesh.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); }
    this.meshes = []; this.object.clear(); this.signature = ''; this.placementValues = []; this.origin = null;
    Object.assign(this.telemetry, { state: 'disposed', instances: 0, draws: 0, geometryBytes: 0, bufferBytes: 0, retainedBytes: 0 });
  }
}
