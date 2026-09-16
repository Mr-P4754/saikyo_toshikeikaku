import * as THREE from 'three';
import { EngineRenderer } from './engine/Renderer';
import { CameraController } from './engine/CameraController';
import { AudioManager } from './engine/AudioManager';
import { ModelFactory } from './models/ModelFactory';
import { WorldMap, CurveDirection, TileType } from './simulation/WorldMap';
import { TrainManager } from './simulation/TrainManager';
import { CityGrowth } from './simulation/CityGrowth';
import { Economy } from './simulation/Economy';
import { UIManager, TOOL_CONFIG, ActiveTool } from './ui/UIManager';
import { VehicleModelInfo, getVehicleById, getRunningCostPerDay } from './simulation/VehicleCatalog';

const CURVE_DIR_ORDER: CurveDirection[] = ['N_E', 'E_S', 'S_W', 'W_N'];
const CURVE_DIR_LABEL: Record<CurveDirection, string> = {
  N_E: '北 → 東', E_S: '東 → 南', S_W: '南 → 西', W_N: '西 → 北'
};
const AXIS_LABEL = ['南北方向', '東西方向'];
const DIR_LABEL = ['北', '東', '南', '西'];

const ROTATABLE_TOOLS: ActiveTool[] = [
  'rail-straight', 'rail-elevated', 'rail-curve', 'rail-curve-elevated',
  'rail-slope', 'point-switch', 'point-switch-elevated', 'station-small', 'station-elevated', 'road'
];
// ② 「仮置き（回転可）→決定で本設置」の2段階配置フローの対象ツール（選択・撤去・列車購入は対象外）
const PLACEMENT_TOOLS: ActiveTool[] = [
  'rail-straight', 'rail-elevated', 'rail-curve', 'rail-curve-elevated', 'rail-slope',
  'point-switch', 'point-switch-elevated', 'station-small', 'station-elevated',
  'road', 'building-res', 'building-com', 'nature'
];

// ⑤ 速度レベル(0-3) → ゲームプレイ倍率（列車・都市成長） / ゲーム内分速（現実1秒あたりのゲーム内分数）
const GAMEPLAY_MULT = [0, 1, 2, 4];
const CALENDAR_MIN_PER_SEC = [0, 10, 60, 360]; // 通常=10分/秒, 高速=60分/秒(1時間/秒), 超高速=360分/秒(6時間/秒)

// ② カテゴリ別撤去ツールが対象とするタイル種別
const TRACK_TILE_TYPES: TileType[] = [
  'rail_ground', 'rail_elevated', 'rail_curve_ground', 'rail_curve_elevated',
  'point_switch_ground', 'point_switch_elevated', 'rail_slope'
];
const STATION_TILE_TYPES: TileType[] = ['station_ground', 'station_elevated'];
const CITY_TILE_TYPES: TileType[] = ['road', 'residence', 'commercial', 'nature'];
const DEMOLISH_SCOPE: Partial<Record<ActiveTool, TileType[]>> = {
  'demolish-track': TRACK_TILE_TYPES,
  'demolish-station': STATION_TILE_TYPES,
  'demolish-city': CITY_TILE_TYPES
};

interface PendingPlacement {
  tool: ActiveTool;
  x: number;
  z: number;
  ghost: THREE.Object3D | null;
}

class GameApp {
  private renderer: EngineRenderer;
  private cameraController: CameraController;
  private audioManager: AudioManager;
  private worldMap: WorldMap;
  private trainManager: TrainManager;
  private cityGrowth: CityGrowth;
  private economy: Economy;
  private uiManager: UIManager;

  private raycaster: THREE.Raycaster = new THREE.Raycaster();
  private mousePos: THREE.Vector2 = new THREE.Vector2();
  private hoverPlane: THREE.Mesh;
  private hoveredTile: { x: number; z: number } | null = null;

  // ⑧ 現在の設置向き（0-3）。ツールごとに軸・曲線方向・分岐通過方向として解釈される
  private currentRotation: number = 0;

  // ② 仮置き中のプレースメント（回転可能、同じマスをもう一度クリックすると本設置される）
  private pendingPlacement: PendingPlacement | null = null;
  private ghostMaterial = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.5,
    depthWrite: false
  });

  // Pending train placement target tile
  private pendingTrainTile: { x: number; z: number } | null = null;

  // ⑤ 0=一時停止, 1=通常, 2=高速, 3=超高速
  private speedLevel: number = 1;
  private lastTime: number = 0;
  private autoSaveTimer: number = 0;

  constructor() {
    // 1. Core Systems
    this.renderer = new EngineRenderer('canvas-container');
    this.cameraController = new CameraController(this.renderer.camera, this.renderer.renderer.domElement);
    this.audioManager = new AudioManager();
    this.worldMap = new WorldMap(this.renderer.scene);
    this.trainManager = new TrainManager(this.renderer.scene, this.worldMap, this.audioManager);
    this.cityGrowth = new CityGrowth(this.worldMap);
    this.economy = new Economy();
    this.uiManager = new UIManager();

    // 2. Tile Hover Cursor (Glowing box)
    const cursorGeo = new THREE.BoxGeometry(WorldMap.TILE_SIZE, 0.08, WorldMap.TILE_SIZE);
    const cursorMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.8
    });
    this.hoverPlane = new THREE.Mesh(cursorGeo, cursorMat);
    this.hoverPlane.position.y = 0.05;
    this.hoverPlane.visible = false;
    this.renderer.scene.add(this.hoverPlane);

    // 3. UI Event Listeners & Interaction
    this.setupUIHandlers();
    this.setupInteraction();

    // 4. Initial World Setup or Load
    this.initWorld();

    // 5. Start Game Loop
    this.lastTime = performance.now();
    requestAnimationFrame(this.gameLoop.bind(this));
  }

  private setupUIHandlers() {
    this.uiManager.onSpeedChanged = (level) => {
      this.speedLevel = level;
    };

    this.uiManager.onAudioToggled = () => {
      const muted = this.audioManager.toggleMute();
      this.uiManager.setAudioMuted(muted);
    };

    this.uiManager.onTimeToggled = () => {
      const time = this.renderer.toggleTimeOfDay();
      this.uiManager.setTimeDisplay(time);
      ModelFactory.updateMaterialsTimeOfDay(time === 'night');
    };

    this.uiManager.onGridToggled = (visible) => {
      this.renderer.setGridVisible(visible);
    };

    this.uiManager.onCameraModeToggled = () => {
      if (this.cameraController.mode === 'orbit') {
        const target = this.trainManager.getFollowTarget(0);
        if (target) {
          this.cameraController.setCabMode(target);
          this.uiManager.setCameraModeUI('cab');
        } else {
          alert('運行中の列車がありません。先に列車を購入・配置してください。');
        }
      } else {
        this.cameraController.setOrbitMode();
        this.uiManager.setCameraModeUI('orbit');
      }
    };

    this.uiManager.onExitCab = () => {
      this.cameraController.setOrbitMode();
      this.uiManager.setCameraModeUI('orbit');
    };

    this.uiManager.onSaveRequested = () => {
      this.saveGame();
    };

    this.uiManager.onResetRequested = () => {
      this.resetGame();
    };

    // ② ポイント切り替えハンドラ
    this.uiManager.onTogglePointSwitch = (x, z) => {
      this.worldMap.togglePointSwitch(x, z);
      const hub = this.worldMap.resolveSwitchHub(x, z);
      if (hub) {
        this.uiManager.showInspector(hub, hub);
        this.audioManager.playBuildSound();
      }
    };

    // ⑤ & ⑦ 車両購入確定ハンドラ
    this.uiManager.onConfirmBuyTrain = (model: VehicleModelInfo, cars: 1 | 2 | 3 | 4) => {
      const totalPrice = model.basePrice * cars;
      if (!this.economy.spendFunds(totalPrice, true)) {
        alert(`資金が不足しています！ (必要: ¥${totalPrice.toLocaleString()})`);
        return;
      }

      // If pending tile was selected, spawn there; otherwise find first available track
      let spawnTile = this.pendingTrainTile;
      if (!spawnTile) {
        const allTracks = this.worldMap.getAllTiles().filter(t => t.type.includes('station') || t.type.includes('rail'));
        if (allTracks.length > 0) {
          spawnTile = { x: allTracks[0].x, z: allTracks[0].z };
        }
      }

      if (spawnTile) {
        const train = this.trainManager.spawnTrain(spawnTile.x, spawnTile.z, model, cars);
        if (train) {
          this.audioManager.playStationBell();
        }
      } else {
        alert('線路または駅が存在しないため配置できませんでした。');
      }
      this.pendingTrainTile = null;
    };

    // ① 列車撤去ハンドラ
    this.uiManager.onRemoveTrain = (trainId: number) => {
      if (this.trainManager.removeTrain(trainId)) {
        this.audioManager.playDemolishSound();
      }
    };

    this.uiManager.onToolChanged = (tool: ActiveTool) => {
      // ② ツールを切り替えたら仮置き中のプレースメントは破棄する
      this.cancelPendingPlacement();
      this.hoverPlane.scale.set(1, 1, 1);

      if (tool === 'train-buy') {
        this.uiManager.openVehicleModal();
      }

      this.updateRotationHint(tool);
    };

    // ⑦ 「設置を決定」ボタン
    this.uiManager.onConfirmPlacement = () => {
      this.confirmPendingPlacement();
    };

    // ⑦ 「キャンセル」ボタン
    this.uiManager.onCancelPlacement = () => {
      this.cancelPendingPlacement();
      this.updateRotationHint(this.uiManager.getActiveTool());
    };

    // ⑤ タッチデバイス用「回転」ボタン（右クリックの代替）
    this.uiManager.onRotatePlacement = () => {
      this.rotateCurrentPlacement();
    };
  }

  /**
   * ⑧ 現在のツール・回転状態、② 仮置き状態に応じたヒント表示を更新
   */
  private updateRotationHint(tool: ActiveTool) {
    if (!ROTATABLE_TOOLS.includes(tool)) {
      this.uiManager.setRotationHint(false);
      return;
    }

    let label: string;
    if (tool === 'rail-curve' || tool === 'rail-curve-elevated') {
      label = `向き: ${CURVE_DIR_LABEL[CURVE_DIR_ORDER[this.currentRotation]]}`;
    } else if (tool === 'point-switch' || tool === 'point-switch-elevated') {
      label = `通過方向: ${DIR_LABEL[this.currentRotation]}（分岐は右側へ）`;
    } else if (tool === 'rail-slope') {
      const axis = this.currentRotation % 2;
      const reversed = this.currentRotation >= 2;
      const axisDirs = axis === 1 ? ['西', '東'] : ['北', '南'];
      const [low, high] = reversed ? [axisDirs[1], axisDirs[0]] : axisDirs;
      label = `上り方向: ${low} → ${high}`;
    } else {
      label = `向き: ${AXIS_LABEL[this.currentRotation % 2]}`;
    }

    if (this.pendingPlacement && this.pendingPlacement.tool === tool) {
      label = `🔶 仮置き中 (${this.pendingPlacement.x}, ${this.pendingPlacement.z}) - ${label} - 「設置を決定」ボタンで本設置`;
    } else {
      label = `${label} - クリックで仮置き`;
    }

    this.uiManager.setRotationHint(true, label);
  }

  /**
   * ⑤⑧ 設置向きを回転（0-3を循環）。右クリック・タッチ用の回転ボタン両方から呼ばれる。
   */
  private rotateCurrentPlacement() {
    const tool = this.uiManager.getActiveTool();
    if (!ROTATABLE_TOOLS.includes(tool)) return;

    this.currentRotation = (this.currentRotation + 1) % 4;

    if (this.pendingPlacement && this.pendingPlacement.tool === tool) {
      this.refreshGhost();
    }

    this.updateRotationHint(tool);
  }

  private setupInteraction() {
    const dom = this.renderer.renderer.domElement;

    // Mouse move for hover cursor
    dom.addEventListener('mousemove', (e) => {
      const rect = dom.getBoundingClientRect();
      this.mousePos.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mousePos.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      this.updateHover();
    });

    // ⑧ 右クリックで設置向きを回転（0-3を循環）。仮置き中ならゴーストも回転させる。
    dom.addEventListener('contextmenu', (e) => {
      const tool = this.uiManager.getActiveTool();
      if (ROTATABLE_TOOLS.includes(tool)) {
        e.preventDefault();
        this.rotateCurrentPlacement();
      }
    });

    // Escape で仮置き中のプレースメントをキャンセル
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.cancelPendingPlacement();
        this.updateRotationHint(this.uiManager.getActiveTool());
      }
    });

    // Click for construction / selection
    dom.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      if (this.cameraController.mode === 'cab') return;

      this.handleTileClick();
    });
  }

  private updateHover() {
    this.raycaster.setFromCamera(this.mousePos, this.renderer.camera);
    const intersects = this.raycaster.intersectObject(this.renderer.groundMesh);

    if (intersects.length > 0) {
      const hitPoint = intersects[0].point;
      const tx = Math.round(hitPoint.x / WorldMap.TILE_SIZE);
      const tz = Math.round(hitPoint.z / WorldMap.TILE_SIZE);

      const half = Math.floor(WorldMap.GRID_SIZE / 2);
      if (tx >= -half && tx < half && tz >= -half && tz < half) {
        this.hoveredTile = { x: tx, z: tz };
        const tool = this.uiManager.getActiveTool();

        // ⑥ 実際の設置形状は仮置き時にゴーストで示すため、ホバーカーソルは常に起点1マスのみを示す
        this.hoverPlane.position.x = tx * WorldMap.TILE_SIZE;
        this.hoverPlane.position.z = tz * WorldMap.TILE_SIZE;

        this.hoverPlane.visible = true;
        const mat = this.hoverPlane.material as THREE.MeshBasicMaterial;
        mat.color.set(tool.startsWith('demolish') ? 0xf43f5e : 0x38bdf8);
        return;
      }
    }

    this.hoverPlane.visible = false;
    this.hoveredTile = null;
  }

  /**
   * ① マウス位置にある列車編成をレイキャストで検出する（select / demolish で使用）
   */
  private raycastTrain() {
    this.raycaster.setFromCamera(this.mousePos, this.renderer.camera);
    let closest: { train: ReturnType<TrainManager['getTrains']>[number]; dist: number } | null = null;
    for (const train of this.trainManager.getTrains()) {
      const hits = this.raycaster.intersectObject(train.mesh, true);
      if (hits.length > 0 && (!closest || hits[0].distance < closest.dist)) {
        closest = { train, dist: hits[0].distance };
      }
    }
    return closest ? closest.train : null;
  }

  // ---------------------------------------------------------------------
  // ② 仮置き（プレースメント・ゴースト）フロー
  // ---------------------------------------------------------------------

  /**
   * ⑥ 現在のツール・向きに応じたプレビュー用メッシュ（半透明ゴースト）を生成する。
   * 分岐器(2×2)・勾配(4×1)は複数マスにまたがるため、実際の設置と同じレイアウトを
   * 起点タイルからの相対オフセットで組み立てたグループとして返す。
   */
  private createGhostMesh(tool: ActiveTool, rotation: number): THREE.Object3D | null {
    const axis = rotation % 2;
    let mesh: THREE.Group | null = null;

    switch (tool) {
      case 'rail-straight':
        mesh = ModelFactory.createGroundTrack(axis, false);
        break;
      case 'rail-elevated':
        mesh = ModelFactory.createElevatedTrack(axis);
        break;
      case 'rail-curve':
        mesh = ModelFactory.createCurveTrackSegment(CURVE_DIR_ORDER[rotation], false);
        break;
      case 'rail-curve-elevated':
        mesh = ModelFactory.createCurveTrackSegment(CURVE_DIR_ORDER[rotation], true);
        break;
      case 'rail-slope':
        mesh = this.createSlopeGhostGroup(axis, rotation >= 2);
        break;
      case 'point-switch':
        mesh = this.createSwitchGhostGroup(rotation, false);
        break;
      case 'point-switch-elevated':
        mesh = this.createSwitchGhostGroup(rotation, true);
        break;
      case 'station-small':
        mesh = ModelFactory.createStation(axis, false, 'single');
        break;
      case 'station-elevated':
        mesh = ModelFactory.createStation(axis, true, 'single');
        break;
      case 'road':
        mesh = ModelFactory.createRoad(axis);
        break;
      case 'building-res':
        mesh = ModelFactory.createHouse(0);
        break;
      case 'building-com':
        mesh = ModelFactory.createCommercialBuilding(3);
        break;
      case 'nature':
        mesh = ModelFactory.createTree();
        break;
      default:
        return null;
    }

    if (!mesh) return null;

    mesh.traverse(obj => {
      const m = obj as THREE.Mesh;
      if ((m as any).isMesh) {
        m.material = this.ghostMaterial;
        m.castShadow = false;
        m.receiveShadow = false;
      }
    });

    return mesh;
  }

  /**
   * ⑥ 勾配(4×1)ゴースト。WorldMap.placeSlope と同じレイアウト計算で4パーツを並べる。
   */
  private createSlopeGhostGroup(rotation: number, reversed: boolean): THREE.Group {
    const group = new THREE.Group();
    const axis: [number, number] = rotation === 1 ? [1, 3] : [0, 2];
    const [, highIdx] = reversed ? [axis[1], axis[0]] : [axis[0], axis[1]];
    const stepDir = WorldMap.DIRS[highIdx];

    for (let i = 0; i < 4; i++) {
      const part = ModelFactory.createSlopeTrackPart(rotation, reversed, i);
      part.position.set(stepDir.x * i * WorldMap.TILE_SIZE, 0, stepDir.z * i * WorldMap.TILE_SIZE);
      group.add(part);
    }
    return group;
  }

  /**
   * ⑥ 分岐器(2×2)ゴースト。WorldMap.placeSwitch と同じレイアウト計算でハブ・直進・分岐脚を並べる。
   */
  private createSwitchGhostGroup(rotation: number, isElevated: boolean): THREE.Group {
    const group = new THREE.Group();
    const forward = ((rotation % 4) + 4) % 4;
    const right = WorldMap.rotateCW(forward);
    const fVec = WorldMap.DIRS[forward];
    const rVec = WorldMap.DIRS[right];

    const hub = ModelFactory.createSwitchHub(forward, false, isElevated);
    group.add(hub);

    const throughRot = (forward === 1 || forward === 3) ? 1 : 0;
    const through = isElevated
      ? ModelFactory.createElevatedTrack(throughRot)
      : ModelFactory.createGroundTrack(throughRot, false);
    through.position.set(fVec.x * WorldMap.TILE_SIZE, 0, fVec.z * WorldMap.TILE_SIZE);
    group.add(through);

    const legACurveDir = WorldMap.indicesToCurveDir(WorldMap.opposite(right), forward);
    const legA = ModelFactory.createCurveTrackSegment(legACurveDir, isElevated);
    legA.position.set(rVec.x * WorldMap.TILE_SIZE, 0, rVec.z * WorldMap.TILE_SIZE);
    group.add(legA);

    const legBCurveDir = WorldMap.indicesToCurveDir(WorldMap.opposite(forward), right);
    const legB = ModelFactory.createCurveTrackSegment(legBCurveDir, isElevated);
    legB.position.set((fVec.x + rVec.x) * WorldMap.TILE_SIZE, 0, (fVec.z + rVec.z) * WorldMap.TILE_SIZE);
    group.add(legB);

    return group;
  }

  private refreshGhost() {
    if (!this.pendingPlacement) return;
    if (this.pendingPlacement.ghost) {
      this.renderer.scene.remove(this.pendingPlacement.ghost);
    }
    const ghost = this.createGhostMesh(this.pendingPlacement.tool, this.currentRotation);
    if (ghost) {
      ghost.position.set(
        this.pendingPlacement.x * WorldMap.TILE_SIZE,
        0,
        this.pendingPlacement.z * WorldMap.TILE_SIZE
      );
      this.renderer.scene.add(ghost);
    }
    this.pendingPlacement.ghost = ghost;
  }

  private cancelPendingPlacement() {
    if (this.pendingPlacement?.ghost) {
      this.renderer.scene.remove(this.pendingPlacement.ghost);
    }
    this.pendingPlacement = null;
    this.uiManager.setPlacementButtonsVisible(false);
  }

  /**
   * ② 仮置きを開始する（まだワールドには反映しない・課金しない）
   */
  private stagePendingPlacement(tool: ActiveTool, x: number, z: number) {
    this.cancelPendingPlacement();
    this.pendingPlacement = { tool, x, z, ghost: null };
    this.refreshGhost();
    this.uiManager.setPlacementButtonsVisible(true);
    this.updateRotationHint(tool);
  }

  /**
   * ⑦ 仮置き中のプレースメントを「設置を決定」ボタンで確定し、実際にワールドへ設置する（本設置）
   */
  private confirmPendingPlacement() {
    if (!this.pendingPlacement) return;
    const { tool, x, z } = this.pendingPlacement;
    this.cancelPendingPlacement();
    this.executePlacement(tool, x, z);
    this.updateRotationHint(tool);
  }

  /**
   * 実際の設置処理（課金・WorldMap 反映・効果音）
   */
  private executePlacement(tool: ActiveTool, x: number, z: number) {
    const config = TOOL_CONFIG[tool];

    // ② ③ 曲線レール敷設（地上/高架、1マス斜め接続）
    if (tool === 'rail-curve' || tool === 'rail-curve-elevated') {
      const isElevated = tool === 'rail-curve-elevated';
      if (this.economy.spendFunds(config.cost, true)) {
        const curveDir = CURVE_DIR_ORDER[this.currentRotation];
        const ok = this.worldMap.placeCurve(x, z, curveDir, isElevated);
        if (ok) {
          this.audioManager.playBuildSound();
        } else {
          this.economy.spendFunds(-config.cost, true); // refund
        }
      } else {
        alert(`資金が不足しています！(必要: ¥${(config.cost / 10000).toLocaleString()}万円)`);
      }
      return;
    }

    // ⑦ ⑧ 分岐器敷設（地上/高架、2×2）
    if (tool === 'point-switch' || tool === 'point-switch-elevated') {
      const isElevated = tool === 'point-switch-elevated';
      if (this.economy.spendFunds(config.cost, true)) {
        const ok = this.worldMap.placeSwitch(x, z, this.currentRotation, isElevated);
        if (ok) {
          this.audioManager.playBuildSound();
        } else {
          this.economy.spendFunds(-config.cost, true); // refund
          alert('分岐器を設置するスペース（2×2マス）が足りません。');
        }
      } else {
        alert(`資金が不足しています！(必要: ¥${(config.cost / 10000).toLocaleString()}万円)`);
      }
      return;
    }

    // ① 勾配レール敷設（4マス直線、地上⇔高架を緩やかに接続）
    if (tool === 'rail-slope') {
      if (this.economy.spendFunds(config.cost, true)) {
        const axis = this.currentRotation % 2;
        const reversed = this.currentRotation >= 2;
        const ok = this.worldMap.placeSlope(x, z, axis, reversed);
        if (ok) {
          this.audioManager.playBuildSound();
        } else {
          this.economy.spendFunds(-config.cost, true); // refund
          alert('勾配レールを設置するスペース（4マス直線）が足りません。');
        }
      } else {
        alert(`資金が不足しています！(必要: ¥${(config.cost / 10000).toLocaleString()}万円)`);
      }
      return;
    }

    // ⑧ 通常の建設（向きは currentRotation の軸成分を使用）
    if (config.tileType) {
      if (this.economy.spendFunds(config.cost, true)) {
        const rotation = ROTATABLE_TOOLS.includes(tool) ? this.currentRotation % 2 : 0;
        this.worldMap.setTile(x, z, config.tileType as TileType, rotation);
        this.audioManager.playBuildSound();
        if (config.tileType === 'residence') {
          this.economy.addPopulation(30);
        } else if (config.tileType === 'commercial') {
          this.economy.addPopulation(100);
        }
      } else {
        alert(`資金が不足しています！(必要: ¥${(config.cost / 10000).toLocaleString()}万円)`);
      }
    }
  }

  private handleTileClick() {
    if (!this.hoveredTile) return;
    const { x, z } = this.hoveredTile;
    const tool = this.uiManager.getActiveTool();

    // Select mode（① 列車を優先的にレイキャスト）
    if (tool === 'select') {
      const train = this.raycastTrain();
      if (train) {
        this.uiManager.showTrainInspector(train);
        return;
      }
      const tile = this.worldMap.getTile(x, z);
      if (tile) {
        const hub = this.worldMap.resolveSwitchHub(x, z);
        const runLength = tile.type.startsWith('station') ? this.worldMap.getStationRunLength(x, z) : undefined;
        this.uiManager.showInspector(tile, hub, runLength);
      }
      return;
    }

    // ①② カテゴリ別撤去モード（該当カテゴリの物のみ撤去できる）
    if (tool === 'demolish-train') {
      const train = this.raycastTrain();
      if (train) {
        this.trainManager.removeTrain(train.id);
        this.audioManager.playDemolishSound();
      } else {
        alert('この位置に列車がありません。撤去したい列車をクリックしてください。');
      }
      return;
    }

    const demolishScope = DEMOLISH_SCOPE[tool];
    if (demolishScope) {
      const tile = this.worldMap.getTile(x, z);
      if (tile && tile.type !== 'empty') {
        if (!demolishScope.includes(tile.type)) {
          alert('このカテゴリーの撤去ツールでは撤去できない物です。');
          return;
        }
        const config = TOOL_CONFIG[tool];
        if (this.economy.spendFunds(config.cost, true)) {
          this.worldMap.demolishTile(x, z);
          this.audioManager.playDemolishSound();
        } else {
          alert('資金が不足しています！');
        }
      }
      return;
    }

    // ⑤ & ⑦ 列車購入モード（線路・駅をクリックしたらその位置をターゲットにしてモーダルを開く）
    if (tool === 'train-buy') {
      const tile = this.worldMap.getTile(x, z);
      if (!tile || (!tile.type.includes('rail') && !tile.type.includes('station') && !tile.type.includes('switch'))) {
        alert('列車は線路または駅の上に配置してください。');
        return;
      }
      this.pendingTrainTile = { x, z };
      this.uiManager.openVehicleModal();
      return;
    }

    // ②⑦ 仮置き（回転可）。本設置は「設置を決定」ボタンでのみ行う。
    if (PLACEMENT_TOOLS.includes(tool)) {
      this.stagePendingPlacement(tool, x, z);
    }
  }

  /**
   * 初期都市の構築
   */
  private initWorld() {
    const saved = localStorage.getItem('stk_3d_world');
    if (saved) {
      this.worldMap.deserialize(saved);
      const track = this.worldMap.getAllTiles().find(t => t.type.includes('station') || t.type.includes('rail'));
      if (track) {
        this.trainManager.spawnTrain(track.x, track.z, getVehicleById('metro-2310'), 2);
      }
      return;
    }

    // ⑧ 複数マス駅ホーム（東西線: 西駅2マス、東高架駅2マス）
    // 西側駅（2マスホーム: X=-5, X=-4）
    this.worldMap.setTile(-6, 0, 'station_ground', 1);
    this.worldMap.setTile(-5, 0, 'station_ground', 1);

    // 中間地上線路
    for (let x = -4; x <= 0; x++) {
      this.worldMap.setTile(x, 0, 'rail_ground', 1);
    }

    // ① 勾配レール（4マス直線: X=1[地上]→X=4[高架] へ緩やかに上る）
    this.worldMap.placeSlope(1, 0, 1, true);

    // 東側高架駅（2マスホーム: X=5, X=6）
    this.worldMap.setTile(5, 0, 'station_elevated', 1);
    this.worldMap.setTile(6, 0, 'station_elevated', 1);

    // ② 分岐器（ポイント、2×2）を西側駅の手前に設置。forward=1(東)で通過、分岐は南側(+Z)へ。
    this.worldMap.placeSwitch(-3, 0, 1, false);

    // 道路
    for (let x = -7; x <= 7; x++) {
      this.worldMap.setTile(x, 2, 'road', 1);
    }

    // 住宅・商業・緑地
    this.worldMap.setTile(-6, 3, 'residence', 0, 2);
    this.worldMap.setTile(-5, 3, 'commercial', 0, 3);
    this.worldMap.setTile(-4, 3, 'residence', 0, 1);
    this.worldMap.setTile(5, 3, 'commercial', 0, 4);
    this.worldMap.setTile(6, 3, 'residence', 0, 2);

    this.worldMap.setTile(-7, 1, 'nature');
    this.worldMap.setTile(7, 1, 'nature');

    this.economy.addPopulation(820);

    // ⑤ & ⑦ ⑨ 初期列車（2310系 都市型電車 2両編成: 初期駅の有効長2両に合わせる）
    this.trainManager.spawnTrain(-5, 0, getVehicleById('metro-2310'), 2);
  }

  private saveGame() {
    const worldData = this.worldMap.serialize();
    localStorage.setItem('stk_3d_world', worldData);
    this.economy.saveToStorage();
  }

  private resetGame() {
    localStorage.removeItem('stk_3d_world');
    this.cancelPendingPlacement();
    this.worldMap.clearAll();
    this.trainManager.removeAllTrains();
    this.economy.resetAll();
    this.cameraController.setOrbitMode();
    this.uiManager.setCameraModeUI('orbit');
    this.initWorld();
  }

  private gameLoop(time: number) {
    requestAnimationFrame(this.gameLoop.bind(this));

    const deltaTime = Math.min((time - this.lastTime) / 1000, 0.1);
    this.lastTime = time;

    // ⑤ ゲームプレイ用倍率（列車移動・都市成長）とカレンダー進行レート（分/秒）は別々に扱う
    const gameplayMult = GAMEPLAY_MULT[this.speedLevel];
    const calendarRate = CALENDAR_MIN_PER_SEC[this.speedLevel];

    // 1. Train Simulation
    this.trainManager.update(deltaTime, gameplayMult, (fare) => {
      this.economy.addFunds(fare);
    });

    // 2. City Growth
    this.cityGrowth.update(deltaTime, gameplayMult, (newPop) => {
      this.economy.addPopulation(newPop);
    });

    // 3. Economy & Calendar
    this.economy.update(
      deltaTime,
      calendarRate,
      () => {},
      () => {
        // ⑩ 月次維持費: 線路の保守費 ＋ 各列車の走行費用（運賃・最高速度から算出）
        const allTiles = this.worldMap.getAllTiles();
        const trackCount = allTiles.filter(t => t.type.includes('rail') || t.type.includes('station')).length;
        const trainRunningCost = this.trainManager.getTrains().reduce(
          (sum, t) => sum + getRunningCostPerDay(t.model, t.carCount) * 30,
          0
        );
        const maint = trackCount * 500000 + trainRunningCost;
        this.economy.spendFunds(maint, false);
      }
    );

    // 4. Camera
    this.cameraController.update(deltaTime);

    // 5. UI Updates
    this.uiManager.updateHUD(
      this.economy.getFormattedDate(),
      this.economy.getFormattedTime(),
      this.economy.getFormattedFunds(),
      this.economy.getFormattedPopulation()
    );

    if (this.cameraController.mode === 'cab') {
      const target = this.trainManager.getFollowTarget(0);
      if (target) {
        this.uiManager.updateCabSpeed(target.speed);
      }
    }

    const allTiles = this.worldMap.getAllTiles();
    const trackCount = allTiles.filter(t => t.type.includes('rail') || t.type.includes('station')).length;
    const stationCount = allTiles.filter(t => t.type.includes('station')).length;
    const reportData = this.economy.getFinancialReport(trackCount, this.trainManager.getTrains().length, stationCount);
    this.uiManager.updateFinancialReport(reportData);

    // Auto-save
    this.autoSaveTimer += deltaTime;
    if (this.autoSaveTimer >= 30) {
      this.autoSaveTimer = 0;
      this.saveGame();
    }

    // 6. Render
    this.renderer.render();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new GameApp();
});
