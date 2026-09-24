// 超広大マップ基盤: 3Dチャンク管理
// カメラの注視点・ズーム量から「今見えているはずのチャンク範囲」を割り出し、
// TerrainRenderer に可視チャンクのみを（遅延生成しつつ）構築させることで、
// 512×512／1024×1024マップでも常時60fpsを維持できるようにする。
// カメラが同じチャンク範囲に留まっている間は再計算をスキップし、無駄な走査を避ける。

import * as THREE from 'three';
import { GridManager } from './GridManager';
import { TerrainRenderer } from '../graphics/TerrainRenderer';
import { CameraManager } from '../graphics/CameraManager';
import { CHUNK_SIZE } from './constants';
import { WorldMap } from '../simulation/WorldMap';

export class ChunkManager {
  private lastCenterKey: string | null = null;
  private lastRadius = -1;
  private gridManager: GridManager;
  private terrainRenderer: TerrainRenderer;

  constructor(gridManager: GridManager, terrainRenderer: TerrainRenderer) {
    this.gridManager = gridManager;
    this.terrainRenderer = terrainRenderer;
  }

  public setGridManager(gridManager: GridManager): void {
    this.gridManager = gridManager;
    this.lastCenterKey = null;
    this.lastRadius = -1;
  }

  /**
   * カメラ状態から可視チャンク範囲を割り出し、必要であれば地形チャンクを追加構築する。
   * 呼び出しは毎フレームで構わない（内部でチャンク範囲が変化した時のみ実処理を行う）。
   */
  public update(cameraManager: CameraManager, scene: THREE.Scene): void {
    const tileSize = WorldMap.TILE_SIZE;
    const centerTileX = Math.round(cameraManager.target.x / tileSize);
    const centerTileZ = Math.round(cameraManager.target.z / tileSize);

    // 画面に映る可能性のあるマス数（長辺・回転・余白を考慮した安全マージン込み）
    const visibleTiles = cameraManager.getShortSideTiles() * 1.8;
    const chunkRadius = Math.max(1, Math.ceil(visibleTiles / CHUNK_SIZE) + 1);

    const { cx: centerCx, cz: centerCz } = this.gridManager.worldToChunkCoords(centerTileX, centerTileZ);
    const key = `${centerCx},${centerCz}`;

    if (key === this.lastCenterKey && chunkRadius === this.lastRadius) {
      return; // カメラが同じチャンク範囲に留まっている間は再走査不要
    }
    this.lastCenterKey = key;
    this.lastRadius = chunkRadius;

    const chunkCount = this.gridManager.chunkCount;
    const visible = new Set<string>();
    for (let dcx = -chunkRadius; dcx <= chunkRadius; dcx++) {
      for (let dcz = -chunkRadius; dcz <= chunkRadius; dcz++) {
        const cx = centerCx + dcx;
        const cz = centerCz + dcz;
        if (cx < 0 || cz < 0 || cx >= chunkCount || cz >= chunkCount) continue;
        visible.add(GridManager.getChunkKey(cx, cz));
      }
    }

    this.terrainRenderer.updateVisibleChunks(this.gridManager, scene, visible);
  }

  public getBuiltChunkKeys(): Set<string> {
    return this.terrainRenderer.getBuiltChunkKeys();
  }
}
