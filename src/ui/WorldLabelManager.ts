import * as THREE from 'three';
import { GridLayer, CameraViewMode } from '../core/types';
import { WorldMap } from '../simulation/WorldMap';
import { TrainManager } from '../simulation/TrainManager';
import { layerToHeight } from '../core/Grid3D';
import { getMaxCapacity } from '../simulation/VehicleCatalog';

/**
 * 3D空間内の駅および旅客列車の真上に、現在の乗客数を数字のみで追従表示するマネージャークラス
 */
export class WorldLabelManager {
  private container: HTMLElement;
  private stationLabels: Map<string, HTMLElement> = new Map();
  private trainLabels: Map<number, HTMLElement> = new Map();
  private tempVec = new THREE.Vector3();

  constructor(containerId: string = 'world-labels-container') {
    let el = document.getElementById(containerId);
    if (!el) {
      el = document.createElement('div');
      el.id = containerId;
      el.className = 'world-labels-container';
      document.getElementById('app')?.appendChild(el);
    }
    this.container = el;
  }

  /**
   * 毎フレームの投影位置・乗客数テキストの更新
   */
  public update(
    camera: THREE.Camera,
    viewMode: CameraViewMode,
    currentDisplayLayer: GridLayer | 'all',
    worldMap: WorldMap,
    trainManager: TrainManager
  ): void {
    // 全体視点（quarter_view）以外（車窓モード中など）はすべて非表示
    if (viewMode !== 'quarter_view') {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = 'block';

    const width = window.innerWidth;
    const height = window.innerHeight;

    // 1. 駅の待機乗客数ラベル更新
    this.updateStationLabels(camera, currentDisplayLayer, worldMap, width, height);

    // 2. 旅客列車の車内乗客数ラベル更新
    this.updateTrainLabels(camera, currentDisplayLayer, trainManager, width, height);
  }

  /**
   * 各旅客駅ホームの真上に待機乗客数を数字のみで表示
   */
  private updateStationLabels(
    camera: THREE.Camera,
    currentDisplayLayer: GridLayer | 'all',
    worldMap: WorldMap,
    screenWidth: number,
    screenHeight: number
  ): void {
    const activeStationKeys = new Set<string>();
    const stations = worldMap.stationManager.getStations();

    for (const st of stations) {
      // 信号場・貨物駅は待機乗客ラベルの対象外
      if (st.isSignalYard || st.isCargoStation) continue;

      for (let pIdx = 0; pIdx < st.platforms.length; pIdx++) {
        const platform = st.platforms[pIdx];
        if (platform.isSignalYard || platform.isCargoStation || platform.tiles.length === 0) continue;

        // ホームを構成する代表タイル（中央タイル）
        const midIdx = Math.floor(platform.tiles.length / 2);
        const centerTile = platform.tiles[midIdx];
        const tileLayer = (centerTile.layer ?? 1) as GridLayer;

        // スライサー表示フィルタ
        if (!this.isLayerVisible(tileLayer, currentDisplayLayer)) {
          continue;
        }

        const pKey = `${st.id}_p${platform.platformNumber}_${centerTile.x}_${centerTile.z}`;
        activeStationKeys.add(pKey);

        // ホーム内の最大待機乗客数を算出
        let maxPassengers = 0;
        for (const t of platform.tiles) {
          const tileData = worldMap.getTile(t.x, t.z, tileLayer);
          if (tileData && tileData.stationPassengers !== undefined) {
            maxPassengers = Math.max(maxPassengers, tileData.stationPassengers);
          }
        }

        // ホーム真上のワールド座標を算出
        const baseH = layerToHeight(tileLayer);
        const elevY = (tileLayer === 1) ? worldMap.getElevationOffset(centerTile.x, centerTile.z) : 0;
        const worldX = centerTile.x * WorldMap.TILE_SIZE;
        const worldY = baseH + elevY + 2.3; // ホーム屋根より上の見やすい頭上高さ
        const worldZ = centerTile.z * WorldMap.TILE_SIZE;

        this.tempVec.set(worldX, worldY, worldZ);
        this.tempVec.project(camera);

        // 視野内判定
        let labelEl = this.stationLabels.get(pKey);
        if (!labelEl) {
          labelEl = document.createElement('div');
          labelEl.className = 'world-badge station-badge';
          this.container.appendChild(labelEl);
          this.stationLabels.set(pKey, labelEl);
        }

        if (this.isOutOfScreen(this.tempVec)) {
          labelEl.style.display = 'none';
        } else {
          const screenX = (this.tempVec.x * 0.5 + 0.5) * screenWidth;
          const screenY = (-(this.tempVec.y * 0.5) + 0.5) * screenHeight;

          labelEl.style.left = `${Math.round(screenX)}px`;
          labelEl.style.top = `${Math.round(screenY)}px`;
          labelEl.style.display = 'block';
          // 数字のみ表示
          labelEl.textContent = maxPassengers.toLocaleString();
        }
      }
    }

    // 撤去された駅ホームのラベルをDOMから除去
    for (const [key, el] of this.stationLabels.entries()) {
      if (!activeStationKeys.has(key)) {
        el.remove();
        this.stationLabels.delete(key);
      }
    }
  }

  /**
   * 運行中の各旅客列車の頭上に乗客数を数字のみで追従表示
   */
  private updateTrainLabels(
    camera: THREE.Camera,
    currentDisplayLayer: GridLayer | 'all',
    trainManager: TrainManager,
    screenWidth: number,
    screenHeight: number
  ): void {
    const activeTrainIds = new Set<number>();
    const trains = trainManager.getTrains();

    for (const train of trains) {
      // 貨物列車は乗客数表示の対象外
      if (train.model.category === 'freight') continue;

      const trainLayer = train.currentTile.layer;
      // スライサー表示フィルタ
      if (!this.isLayerVisible(trainLayer, currentDisplayLayer)) {
        continue;
      }

      activeTrainIds.add(train.id);

      // 先頭車の現在ワールド位置を取得し、頭上へオフセット
      const frontPos = train.frontPosition;
      const worldX = frontPos.x;
      const worldY = frontPos.y + 1.6; // 列車の屋根から少し上
      const worldZ = frontPos.z;

      this.tempVec.set(worldX, worldY, worldZ);
      this.tempVec.project(camera);

      let labelEl = this.trainLabels.get(train.id);
      if (!labelEl) {
        labelEl = document.createElement('div');
        labelEl.className = 'world-badge train-badge';
        this.container.appendChild(labelEl);
        this.trainLabels.set(train.id, labelEl);
      }

      if (this.isOutOfScreen(this.tempVec)) {
        labelEl.style.display = 'none';
      } else {
        const screenX = (this.tempVec.x * 0.5 + 0.5) * screenWidth;
        const screenY = (-(this.tempVec.y * 0.5) + 0.5) * screenHeight;

        labelEl.style.left = `${Math.round(screenX)}px`;
        labelEl.style.top = `${Math.round(screenY)}px`;
        labelEl.style.display = 'block';

        // 満車（最大乗車人数到達）時はハイライトスタイルを適用
        const maxCap = getMaxCapacity(train.model, train.carCount);
        const isFull = maxCap > 0 && train.passengers >= maxCap;
        labelEl.classList.toggle('full', isFull);

        // 数字のみ表示
        labelEl.textContent = (train.passengers ?? 0).toLocaleString();
      }
    }

    // 撤去・回送された列車のラベルをDOMから除去
    for (const [id, el] of this.trainLabels.entries()) {
      if (!activeTrainIds.has(id)) {
        el.remove();
        this.trainLabels.delete(id);
      }
    }
  }

  /**
   * 現在のスライサー階層に応じた表示可否判定
   */
  private isLayerVisible(tileLayer: GridLayer, displayLayer: GridLayer | 'all'): boolean {
    if (displayLayer === 'all') {
      return tileLayer >= 1; // 地上全階層表示
    }
    return tileLayer === displayLayer;
  }

  /**
   * 正規化デバイス座標（NDC）がカメラ画面外または背後にあるか判定
   */
  private isOutOfScreen(ndc: THREE.Vector3): boolean {
    return ndc.z < -1 || ndc.z > 1 || ndc.x < -1.1 || ndc.x > 1.1 || ndc.y < -1.1 || ndc.y > 1.1;
  }

  /**
   * 全ラベルのクリア・破棄
   */
  public clear(): void {
    for (const el of this.stationLabels.values()) {
      el.remove();
    }
    this.stationLabels.clear();

    for (const el of this.trainLabels.values()) {
      el.remove();
    }
    this.trainLabels.clear();
  }
}
