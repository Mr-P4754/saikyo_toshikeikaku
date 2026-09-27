import * as THREE from 'three';
import { GameMaterials } from './materials';

/**
 * InstancedMeshManager
 * 大量オブジェクト（直線レール、高架レール、橋脚、架線柱、街路樹等）を
 * THREE.InstancedMesh に集約してドローコール（Draw Calls）を劇的に削減する。
 * スワップ＆ポップ方式（Swap & Pop）による O(1) の高速追加・削除および厳格なメモリ解放を実装。
 */

interface ManagedInstancedLayer {
  mesh: THREE.InstancedMesh;
  keyToIndex: Map<string, number>;
  indexToKey: Map<number, string>;
  count: number;
  maxCount: number;
}

export class InstancedMeshManager {
  private scene: THREE.Scene;
  private container: THREE.Group = new THREE.Group();

  // レイヤー管理
  private layers: Map<string, ManagedInstancedLayer> = new Map();

  // ジオメトリキャッシュ（共有してdispose時に一括解放）
  private sharedGeometries: THREE.BufferGeometry[] = [];

  constructor(scene: THREE.Scene, initialCapacity: number = 4096) {
    this.scene = scene;
    this.container.name = 'InstancedMeshContainer';
    this.container.frustumCulled = false;
    this.scene.add(this.container);

    this.initGeometriesAndLayers(initialCapacity);
  }

  /**
   * ジオメトリ構築およびInstancedMeshレイヤーの初期化
   */
  private initGeometriesAndLayers(capacity: number): void {
    // 1. 直線地上レール (Ballast, Sleepers, Rails)
    // 1-a. バラスト
    const ballastGeo = new THREE.BoxGeometry(1.6, 0.16, 2.0);
    ballastGeo.translate(0, 0.08, 0);
    this.createLayer('rail_ground_ballast', ballastGeo, GameMaterials.ballastMat, capacity);

    // 1-b. 枕木 (5本を単一ジオメトリにマージ)
    const sleeperGeo = this.createMergedSleepersGeometry(1.4, 0.08, 0.16, 0.18, 5);
    this.createLayer('rail_ground_sleepers', sleeperGeo, GameMaterials.sleeperMat, capacity);

    // 1-c. レール (左右2本マージ)
    const railGeo = this.createMergedRailsGeometry(0.06, 0.1, 2.0, 0.24, 0.45);
    this.createLayer('rail_ground_rails', railGeo, GameMaterials.railMat, capacity);

    // 2. 直線高架レール (Deck & Walls, Sleepers, Rails)
    // 2-a. 高架デッキと左右側壁
    const elevatedStructureGeo = this.createElevatedStructureGeometry();
    this.createLayer('rail_elevated_structure', elevatedStructureGeo, GameMaterials.concreteMat, capacity);

    // 2-b. 高架枕木
    const elevatedSleeperGeo = this.createMergedSleepersGeometry(1.3, 0.06, 0.16, 0.38, 5);
    this.createLayer('rail_elevated_sleepers', elevatedSleeperGeo, GameMaterials.sleeperMat, capacity);

    // 2-c. 高架レール
    const elevatedRailGeo = this.createMergedRailsGeometry(0.06, 0.1, 2.0, 0.44, 0.45);
    this.createLayer('rail_elevated_rails', elevatedRailGeo, GameMaterials.railMat, capacity);

    // 3. 標準橋脚 (Pier)
    const pierGeo = new THREE.BoxGeometry(0.8, 3.0, 0.8);
    pierGeo.translate(0, -1.5, 0);
    this.createLayer('standard_pier', pierGeo, GameMaterials.concreteMat, capacity);

    // 4. 架線柱 (Catenary Pole)
    const poleGeo = this.createCatenaryPoleGeometry();
    this.createLayer('catenary_pole', poleGeo, GameMaterials.poleMat, capacity);

    // 5. 街路樹 (Tree - Trunk & Foliage)
    const trunkGeo = new THREE.CylinderGeometry(0.08, 0.12, 0.8, 6);
    trunkGeo.translate(0, 0.4, 0);
    this.createLayer('tree_trunk', trunkGeo, GameMaterials.woodTrunkMat, capacity);

    const foliageGeo = this.createTreeFoliageGeometry();
    this.createLayer('tree_foliage', foliageGeo, GameMaterials.foliageMats[0], capacity);
  }

  /**
   * 単一InstancedMeshレイヤーの生成
   */
  private createLayer(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number
  ): void {
    this.sharedGeometries.push(geometry);
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // インスタンスがワールド広域に分散するため、原点基準の視錐台カリングによる消失を完全防止
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.container.add(mesh);

    this.layers.set(name, {
      mesh,
      keyToIndex: new Map(),
      indexToKey: new Map(),
      count: 0,
      maxCount: capacity
    });
  }

  /**
   * 枕木5本の複合ジオメトリ生成
   */
  private createMergedSleepersGeometry(
    width: number,
    height: number,
    depth: number,
    yPos: number,
    count: number
  ): THREE.BufferGeometry {
    const singleGeo = new THREE.BoxGeometry(width, height, depth);
    const geos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < count; i++) {
      const g = singleGeo.clone();
      const zOffset = (i / (count - 1) - 0.5) * 1.5;
      g.translate(0, yPos, zOffset);
      geos.push(g);
    }
    singleGeo.dispose();
    return this.mergeBufferGeometries(geos);
  }

  /**
   * 左右2本レールの複合ジオメトリ生成
   */
  private createMergedRailsGeometry(
    width: number,
    height: number,
    length: number,
    yPos: number,
    xOffset: number
  ): THREE.BufferGeometry {
    const singleGeo = new THREE.BoxGeometry(width, height, length);
    const gLeft = singleGeo.clone();
    gLeft.translate(-xOffset, yPos, 0);
    const gRight = singleGeo.clone();
    gRight.translate(xOffset, yPos, 0);
    singleGeo.dispose();
    return this.mergeBufferGeometries([gLeft, gRight]);
  }

  /**
   * 高架デッキと左右側壁の複合コンクリートジオメトリ生成
   */
  private createElevatedStructureGeometry(): THREE.BufferGeometry {
    const deck = new THREE.BoxGeometry(2.0, 0.35, 2.0);
    deck.translate(0, 0.175, 0);

    const wallL = new THREE.BoxGeometry(0.12, 0.65, 2.0);
    wallL.translate(-0.94, 0.45, 0);

    const wallR = new THREE.BoxGeometry(0.12, 0.65, 2.0);
    wallR.translate(0.94, 0.45, 0);

    return this.mergeBufferGeometries([deck, wallL, wallR]);
  }

  /**
   * 架線柱（両側ポール＋横梁）の複合ジオメトリ生成
   */
  private createCatenaryPoleGeometry(): THREE.BufferGeometry {
    const p1 = new THREE.CylinderGeometry(0.04, 0.04, 1.6, 6);
    p1.translate(-0.95, 0.95, 0);

    const p2 = new THREE.CylinderGeometry(0.04, 0.04, 1.6, 6);
    p2.translate(0.95, 0.95, 0);

    const beam = new THREE.BoxGeometry(2.0, 0.06, 0.06);
    beam.translate(0, 1.75, 0);

    return this.mergeBufferGeometries([p1, p2, beam]);
  }

  /**
   * 樹木の葉（2つの十二面体）の複合ジオメトリ生成
   */
  private createTreeFoliageGeometry(): THREE.BufferGeometry {
    const l1 = new THREE.DodecahedronGeometry(0.65, 1);
    l1.translate(0, 1.0, 0);

    const l2 = new THREE.DodecahedronGeometry(0.48, 1);
    l2.translate(0.2, 1.4, -0.1);

    return this.mergeBufferGeometries([l1, l2]);
  }

  /**
   * 複数の BufferGeometry を単一ジオメトリに結合
   */
  private mergeBufferGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
    let totalPositions = 0;
    let totalNormals = 0;
    let totalIndices = 0;

    for (const g of geos) {
      totalPositions += g.attributes.position.array.length;
      if (g.attributes.normal) totalNormals += g.attributes.normal.array.length;
      if (g.index) totalIndices += g.index.array.length;
    }

    const mergedPositions = new Float32Array(totalPositions);
    const mergedNormals = new Float32Array(totalNormals);
    const mergedIndices = new Uint32Array(totalIndices);

    let posOffset = 0;
    let normOffset = 0;
    let indexOffset = 0;
    let vertexBase = 0;

    for (const g of geos) {
      const pos = g.attributes.position.array as Float32Array;
      mergedPositions.set(pos, posOffset);
      posOffset += pos.length;

      if (g.attributes.normal) {
        const norm = g.attributes.normal.array as Float32Array;
        mergedNormals.set(norm, normOffset);
        normOffset += norm.length;
      }

      if (g.index) {
        const idx = g.index.array;
        for (let i = 0; i < idx.length; i++) {
          mergedIndices[indexOffset + i] = idx[i] + vertexBase;
        }
        indexOffset += idx.length;
      }
      vertexBase += g.attributes.position.count;
      g.dispose();
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(mergedPositions, 3));
    if (totalNormals > 0) {
      merged.setAttribute('normal', new THREE.BufferAttribute(mergedNormals, 3));
    }
    if (totalIndices > 0) {
      merged.setIndex(new THREE.BufferAttribute(mergedIndices, 1));
    }
    return merged;
  }

  /**
   * 単一レイヤーへのインスタンス配置 / 更新（内部用）
   */
  private setLayerInstance(layerName: string, key: string, matrix: THREE.Matrix4): void {
    const layer = this.layers.get(layerName);
    if (!layer) return;

    let index = layer.keyToIndex.get(key);
    if (index === undefined) {
      if (layer.count >= layer.maxCount) {
        this.expandLayerCapacity(layer);
      }
      index = layer.count;
      layer.count++;
      layer.keyToIndex.set(key, index);
      layer.indexToKey.set(index, key);
      layer.mesh.count = layer.count;
    }

    layer.mesh.setMatrixAt(index, matrix);
    layer.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * 単一レイヤーからのインスタンス削除（O(1) スワップ＆ポップ）
   */
  private removeLayerInstance(layerName: string, key: string): void {
    const layer = this.layers.get(layerName);
    if (!layer) return;

    const index = layer.keyToIndex.get(key);
    if (index === undefined) return;

    const lastIndex = layer.count - 1;
    if (index !== lastIndex) {
      // 末尾の matrix を削除対象位置にコピー
      const tempMatrix = new THREE.Matrix4();
      layer.mesh.getMatrixAt(lastIndex, tempMatrix);
      layer.mesh.setMatrixAt(index, tempMatrix);

      // マッピングを更新
      const lastKey = layer.indexToKey.get(lastIndex)!;
      layer.keyToIndex.set(lastKey, index);
      layer.indexToKey.set(index, lastKey);
    }

    layer.keyToIndex.delete(key);
    layer.indexToKey.delete(lastIndex);
    layer.count--;
    layer.mesh.count = layer.count;
    layer.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * 容量不足時の動的拡張
   */
  private expandLayerCapacity(layer: ManagedInstancedLayer): void {
    const newCapacity = layer.maxCount * 2;
    const oldMesh = layer.mesh;
    const newMesh = new THREE.InstancedMesh(oldMesh.geometry, oldMesh.material, newCapacity);
    newMesh.count = layer.count;
    newMesh.castShadow = true;
    newMesh.receiveShadow = true;
    newMesh.frustumCulled = false;
    newMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const tempMatrix = new THREE.Matrix4();
    for (let i = 0; i < layer.count; i++) {
      oldMesh.getMatrixAt(i, tempMatrix);
      newMesh.setMatrixAt(i, tempMatrix);
    }
    newMesh.instanceMatrix.needsUpdate = true;

    this.container.remove(oldMesh);
    this.container.add(newMesh);

    layer.mesh = newMesh;
    layer.maxCount = newCapacity;
  }

  // ==========================================
  // 高レベルAPI（タイルの配置・撤去と直結）
  // ==========================================

  /**
   * 直線地上レール (rail_ground) の配置
   */
  public setGroundTrack(key: string, matrix: THREE.Matrix4, hasPole: boolean = false): void {
    this.setLayerInstance('rail_ground_ballast', key, matrix);
    this.setLayerInstance('rail_ground_sleepers', key, matrix);
    this.setLayerInstance('rail_ground_rails', key, matrix);
    if (hasPole) {
      this.setLayerInstance('catenary_pole', `pole_${key}`, matrix);
    } else {
      this.removeLayerInstance('catenary_pole', `pole_${key}`);
    }
  }

  /**
   * 直線地上レールの撤去
   */
  public removeGroundTrack(key: string): void {
    this.removeLayerInstance('rail_ground_ballast', key);
    this.removeLayerInstance('rail_ground_sleepers', key);
    this.removeLayerInstance('rail_ground_rails', key);
    this.removeLayerInstance('catenary_pole', `pole_${key}`);
  }

  /**
   * 直線高架レール (rail_elevated) の配置
   * pierMatrices に各階層（上層から地上まで）の橋脚マトリクス配列を受け取り、完全な支柱を描画する
   */
  public setElevatedTrack(key: string, matrix: THREE.Matrix4, pierMatrices: THREE.Matrix4[] | boolean = true): void {
    this.setLayerInstance('rail_elevated_structure', key, matrix);
    this.setLayerInstance('rail_elevated_sleepers', key, matrix);
    this.setLayerInstance('rail_elevated_rails', key, matrix);

    this.removeElevatedPiers(key);

    if (Array.isArray(pierMatrices)) {
      for (let i = 0; i < pierMatrices.length; i++) {
        this.setLayerInstance('standard_pier', `pier_${key}_${i}`, pierMatrices[i]);
      }
    } else if (pierMatrices === true) {
      this.setLayerInstance('standard_pier', `pier_${key}_0`, matrix);
    }
  }

  /**
   * 直線高架レールの撤去
   */
  public removeElevatedTrack(key: string): void {
    this.removeLayerInstance('rail_elevated_structure', key);
    this.removeLayerInstance('rail_elevated_sleepers', key);
    this.removeLayerInstance('rail_elevated_rails', key);
    this.removeElevatedPiers(key);
  }

  /**
   * 特定高架レールに紐づく全階層分の橋脚インスタンスを削除
   */
  private removeElevatedPiers(key: string): void {
    for (let i = 0; i < 6; i++) {
      this.removeLayerInstance('standard_pier', `pier_${key}_${i}`);
    }
    this.removeLayerInstance('standard_pier', `pier_${key}`);
  }

  /**
   * 街路樹 (nature) の配置
   */
  public setTree(key: string, matrix: THREE.Matrix4): void {
    this.setLayerInstance('tree_trunk', key, matrix);
    this.setLayerInstance('tree_foliage', key, matrix);
  }

  /**
   * 街路樹の撤去
   */
  public removeTree(key: string): void {
    this.removeLayerInstance('tree_trunk', key);
    this.removeLayerInstance('tree_foliage', key);
  }

  /**
   * 全インスタンスのクリア
   */
  public clearAll(): void {
    for (const layer of this.layers.values()) {
      layer.keyToIndex.clear();
      layer.indexToKey.clear();
      layer.count = 0;
      layer.mesh.count = 0;
      layer.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * コンテナ表示/非表示の切り替え（地下階層作業時の非表示化など）
   */
  public setVisible(visible: boolean): void {
    this.container.visible = visible;
  }

  /**
   * 厳格なメモリ解放（全ジオメトリ・InstancedMeshのGPU破棄）
   */
  public dispose(): void {
    for (const layer of this.layers.values()) {
      this.container.remove(layer.mesh);
      layer.mesh.geometry.dispose();
      // マテリアルは GameMaterials の共有マテリアルのためここでは dispose しない
    }
    for (const geo of this.sharedGeometries) {
      geo.dispose();
    }
    this.sharedGeometries = [];
    this.layers.clear();
    this.scene.remove(this.container);
  }
}
