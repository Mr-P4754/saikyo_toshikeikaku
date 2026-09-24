import * as THREE from 'three';
import { GridManager, MapChunk } from '../core/GridManager';
import { WorldMap } from '../simulation/WorldMap';

/**
 * 3次元地形レンダラー（チャンク単位描画）
 * 標高（山岳段丘ブロック）および水域（河川・海岸線）を32×32マス単位のチャンクごとに
 * 個別の InstancedMesh グループとして構築する。Three.js は各メッシュのバウンディングスフィアを
 * 基準に自動フラスタムカリングを行うため、カメラ視界外のチャンクはGPU描画コストが発生しない。
 * 512×512／1024×1024のような超広大マップでも、実際に訪れた（or 可視になった）チャンクのみ
 * ジオメトリを生成するため、初期化コスト・描画コストの双方を抑制できる。
 */
export class TerrainRenderer {
  public terrainGroup: THREE.Group = new THREE.Group();
  private chunkGroups: Map<string, THREE.Group> = new Map();
  private tunnelChecker: ((x: number, z: number) => boolean) | null = null;

  // 山岳マテリアル（上面は濃い緑、側面は岩肌/崖）
  private mountainTopMat = new THREE.MeshStandardMaterial({
    color: 0x4d7c0f,
    roughness: 0.85,
    metalness: 0.05
  });
  private mountainSideMat = new THREE.MeshStandardMaterial({
    color: 0x64748b,
    roughness: 0.9,
    metalness: 0.1
  });
  private mountainMaterials = [
    this.mountainSideMat, this.mountainSideMat,
    this.mountainTopMat, this.mountainSideMat,
    this.mountainSideMat, this.mountainSideMat
  ];

  // 水面マテリアル（エメラルドブルー・鮮やかな海と河川）
  private waterMat = new THREE.MeshStandardMaterial({
    color: 0x0284c7,
    roughness: 0.1,
    metalness: 0.15,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide
  });

  private boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private planeGeo = new THREE.PlaneGeometry(1, 1);

  constructor() {
    this.terrainGroup.name = 'TerrainGroup';
  }

  /**
   * 初回構築: マップ原点付近のチャンクのみ先行生成する。
   * それ以遠のチャンクは ChunkManager がカメラ移動に応じて updateVisibleChunks() 経由で遅延構築する。
   */
  public build(gridManager: GridManager, scene: THREE.Scene): void {
    this.clear(scene);
    scene.add(this.terrainGroup);

    const initialRadius = 2; // 原点中心±2チャンク(64マス四方相当)を初期表示
    const { cx: centerCx, cz: centerCz } = gridManager.worldToChunkCoords(0, 0);
    const initialKeys = new Set<string>();
    for (let dcx = -initialRadius; dcx <= initialRadius; dcx++) {
      for (let dcz = -initialRadius; dcz <= initialRadius; dcz++) {
        const cx = centerCx + dcx;
        const cz = centerCz + dcz;
        if (cx < 0 || cz < 0 || cx >= gridManager.chunkCount || cz >= gridManager.chunkCount) continue;
        initialKeys.add(GridManager.getChunkKey(cx, cz));
      }
    }
    this.updateVisibleChunks(gridManager, scene, initialKeys);
  }

  /**
   * 可視チャンク集合を受け取り、未構築のチャンクのみ新規に生成してシーンへ追加する。
   * 一度構築したチャンクは再訪問時の再構築コストを避けるためキャッシュ保持しつつ、
   * カメラ可視範囲外のチャンクは visible = false にして Three.js の描画負荷・フラスタムカリングを完全遮断する。
   * また、超広大マップでキャッシュが肥大化した場合は可視外の最古チャンクを解放してメモリリークを防ぐ。
   */
  public updateVisibleChunks(gridManager: GridManager, scene: THREE.Scene, visibleKeys: Set<string>): void {
    if (!this.terrainGroup.parent) {
      scene.add(this.terrainGroup);
    }

    // 1. 新規可視チャンクの構築
    for (const key of visibleKeys) {
      if (this.chunkGroups.has(key)) continue;
      const [cxStr, czStr] = key.split(',');
      const cx = parseInt(cxStr, 10);
      const cz = parseInt(czStr, 10);
      const chunk = gridManager.ensureChunk(cx, cz);
      const group = this.buildChunkGroup(chunk, gridManager);
      this.chunkGroups.set(key, group);
      this.terrainGroup.add(group);
    }

    // 2. カリング処理: 可視範囲外のチャンクは非表示にして描画コスト・フラスタムテストを完全除外
    for (const [key, group] of this.chunkGroups.entries()) {
      group.visible = visibleKeys.has(key);
    }

    // 3. メモリリーク防止（LRU破棄）:
    // キャッシュチャンク数が安全上限（256チャンク）を超えた場合、
    // 現在の可視範囲外（visibleKeys に含まれない）かつ最古のチャンクをシーンから除外・解放する
    const MAX_CACHED_CHUNKS = 256;
    if (this.chunkGroups.size > MAX_CACHED_CHUNKS) {
      for (const [key, group] of this.chunkGroups.entries()) {
        if (!visibleKeys.has(key)) {
          this.terrainGroup.remove(group);
          this.chunkGroups.delete(key);
          if (this.chunkGroups.size <= MAX_CACHED_CHUNKS) {
            break;
          }
        }
      }
    }
  }

  public getBuiltChunkKeys(): Set<string> {
    return new Set(this.chunkGroups.keys());
  }

  private buildChunkGroup(chunk: MapChunk, gridManager: GridManager): THREE.Group {
    const group = new THREE.Group();
    group.name = `TerrainChunk_${chunk.chunkX}_${chunk.chunkZ}`;

    const dummy = new THREE.Object3D();
    const tileSize = WorldMap.TILE_SIZE;
    const half = gridManager.mapSize / 2;

    const mountainTransforms: THREE.Matrix4[] = [];
    const waterTransforms: THREE.Matrix4[] = [];

    for (const cell of chunk.cells.values()) {
      if (cell.y !== 1) continue;
      if (cell.x < -half || cell.x >= half || cell.z < -half || cell.z >= half) continue;

      const wx = cell.x * tileSize;
      const wz = cell.z * tileSize;

      if (cell.isWater) {
        dummy.position.set(wx, 0.03, wz);
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        dummy.scale.set(tileSize * 1.0, tileSize * 1.0, 1);
        dummy.updateMatrix();
        waterTransforms.push(dummy.matrix.clone());
      }

      if (cell.elevation > 1) {
        const totalHeight = (cell.elevation - 1) * 3.0;
        const hasTunnel = this.tunnelChecker ? this.tunnelChecker(cell.x, cell.z) : false;
        if (hasTunnel) {
          // 山岳トンネル開口部: 天井高さ1.4mを確保し、その上部に乗る山頂・崖ブロックのみを描画
          const tunnelClearance = 1.4;
          const mountainThickness = Math.max(0.4, totalHeight - tunnelClearance);
          const centerY = tunnelClearance + mountainThickness / 2;
          dummy.position.set(wx, centerY, wz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(tileSize * 0.99, mountainThickness, tileSize * 0.99);
          dummy.updateMatrix();
          mountainTransforms.push(dummy.matrix.clone());
        } else {
          dummy.position.set(wx, totalHeight / 2, wz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(tileSize * 0.99, totalHeight, tileSize * 0.99);
          dummy.updateMatrix();
          mountainTransforms.push(dummy.matrix.clone());
        }
      }
    }

    if (mountainTransforms.length > 0) {
      const mesh = new THREE.InstancedMesh(this.boxGeo, this.mountainMaterials, mountainTransforms.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (let i = 0; i < mountainTransforms.length; i++) {
        mesh.setMatrixAt(i, mountainTransforms[i]);
      }
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    }

    if (waterTransforms.length > 0) {
      const mesh = new THREE.InstancedMesh(this.planeGeo, this.waterMat, waterTransforms.length);
      mesh.receiveShadow = true;
      for (let i = 0; i < waterTransforms.length; i++) {
        mesh.setMatrixAt(i, waterTransforms[i]);
      }
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    }

    return group;
  }

  /**
   * シーンから地形メッシュを全消去
   */
  public clear(scene: THREE.Scene): void {
    for (const group of this.chunkGroups.values()) {
      group.traverse(obj => {
        const inst = obj as THREE.InstancedMesh;
        if ((inst as any).isInstancedMesh) {
          inst.geometry.dispose();
        }
      });
      this.terrainGroup.remove(group);
    }
    this.chunkGroups.clear();
    scene.remove(this.terrainGroup);
  }

  /**
   * 半透明透過（X-Ray）モードの切り替え
   */
  public setTransparentMode(enabled: boolean): void {
    const opacity = enabled ? 0.3 : 1.0;
    this.mountainTopMat.transparent = enabled;
    this.mountainTopMat.opacity = opacity;
    this.mountainTopMat.needsUpdate = true;

    this.mountainSideMat.transparent = enabled;
    this.mountainSideMat.opacity = opacity;
    this.mountainSideMat.needsUpdate = true;
  }

  /**
   * 地形メッシュ全体の表示/非表示（地下作業時に地形を完全に非表示化）
   */
  public setVisible(visible: boolean): void {
    this.terrainGroup.visible = visible;
  }

  /**
   * 山岳トンネル判定コールバックを設定
   */
  public setTunnelChecker(checker: (x: number, z: number) => boolean): void {
    this.tunnelChecker = checker;
  }

  /**
   * 指定チャンク (cx, cz) の地形メッシュを再構築
   */
  public rebuildChunk(cx: number, cz: number, gridManager: GridManager, _scene?: THREE.Scene): void {
    const key = GridManager.getChunkKey(cx, cz);
    const existing = this.chunkGroups.get(key);
    if (existing) {
      this.terrainGroup.remove(existing);
      existing.traverse(obj => {
        const inst = obj as THREE.InstancedMesh;
        if ((inst as any).isInstancedMesh) {
          inst.geometry.dispose();
        }
      });
      this.chunkGroups.delete(key);
    }
    const chunk = gridManager.ensureChunk(cx, cz);
    const newGroup = this.buildChunkGroup(chunk, gridManager);
    this.chunkGroups.set(key, newGroup);
    this.terrainGroup.add(newGroup);
  }

  /**
   * 指定座標 (worldX, worldZ) を含むチャンクの地形メッシュを再構築
   */
  public rebuildChunkAt(worldX: number, worldZ: number, gridManager: GridManager, _scene?: THREE.Scene): void {
    const { cx, cz } = gridManager.worldToChunkCoords(worldX, worldZ);
    this.rebuildChunk(cx, cz, gridManager, _scene);
  }

  /**
   * 構築済み全チャンクの地形メッシュを再構築
   */
  public rebuildAll(gridManager: GridManager, _scene?: THREE.Scene): void {
    const keys = Array.from(this.chunkGroups.keys());
    for (const key of keys) {
      const [cxStr, czStr] = key.split(',');
      const cx = parseInt(cxStr, 10);
      const cz = parseInt(czStr, 10);
      this.rebuildChunk(cx, cz, gridManager, _scene);
    }
  }
}
