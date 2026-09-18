import * as THREE from 'three';
import { EngineRenderer } from './engine/Renderer';
import { CameraController } from './engine/CameraController';
import { AudioManager } from './engine/AudioManager';
import { ModelFactory } from './models/ModelFactory';
import { WorldMap, CurveDirection, TileType, createDefaultStationSchedule } from './simulation/WorldMap';
import { TrainManager } from './simulation/TrainManager';
import { CityGrowth } from './simulation/CityGrowth';
import { Economy } from './simulation/Economy';
import { UIManager, TOOL_CONFIG, ActiveTool, FleetItem } from './ui/UIManager';
import { VehicleModelInfo, getVehicleById, getRunningCostPerDay } from './simulation/VehicleCatalog';

const CURVE_DIR_ORDER: CurveDirection[] = ['N_E', 'E_S', 'S_W', 'W_N'];
const CURVE_DIR_LABEL: Record<CurveDirection, string> = {
  N_E: '北 → 東', E_S: '東 → 南', S_W: '南 → 西', W_N: '西 → 北'
};
const AXIS_LABEL = ['南北方向', '東西方向'];
const DIR_LABEL = ['北', '東', '南', '西'];

const ROTATABLE_TOOLS: ActiveTool[] = [
  'rail-straight', 'rail-elevated', 'rail-curve', 'rail-curve-elevated',
  'rail-slope', 'point-switch', 'point-switch-elevated',
  'scissors-crossing', 'scissors-crossing-elevated',
  'station-small', 'station-elevated', 'road'
];
// ⑥ 「仮置き（複数マス可・回転可）→決定でまとめて本設置」の対象ツール（選択・撤去・列車購入は対象外）
const PLACEMENT_TOOLS: ActiveTool[] = [
  'rail-straight', 'rail-elevated', 'rail-curve', 'rail-curve-elevated', 'rail-slope',
  'point-switch', 'point-switch-elevated', 'scissors-crossing', 'scissors-crossing-elevated',
  'station-small', 'station-elevated',
  'road', 'building-res', 'building-com', 'nature'
];

// ⑤ 速度レベル(0-3) → ゲームプレイ倍率（列車・都市成長） / ゲーム内分速（現実1秒あたりのゲーム内分数）
const GAMEPLAY_MULT = [0, 1, 2, 4];
const CALENDAR_MIN_PER_SEC = [0, 10, 60, 360]; // 通常=10分/秒, 高速=60分/秒(1時間/秒), 超高速=360分/秒(6時間/秒)

// ② カテゴリ別撤去ツールが対象とするタイル種別
const TRACK_TILE_TYPES: TileType[] = [
  'rail_ground', 'rail_elevated', 'rail_curve_ground', 'rail_curve_elevated',
  'point_switch_ground', 'point_switch_elevated',
  'scissors_crossing_ground', 'scissors_crossing_elevated',
  'rail_slope', 'level_crossing'
];
const STATION_TILE_TYPES: TileType[] = ['station_ground', 'station_elevated'];
const CITY_TILE_TYPES: TileType[] = ['road', 'residence', 'commercial', 'nature', 'level_crossing'];
const DEMOLISH_SCOPE: Partial<Record<ActiveTool, TileType[]>> = {
  'demolish-track': TRACK_TILE_TYPES,
  'demolish-station': STATION_TILE_TYPES,
  'demolish-city': CITY_TILE_TYPES
};

// 線路・駅・分岐器・シーサスクロッシング・踏切など「列車が乗れる/敷設延長に数える」タイルかどうか
function isTrackLikeType(type: TileType): boolean {
  return (
    type.includes('rail') ||
    type.includes('station') ||
    type.includes('switch') ||
    type.includes('scissors_crossing') ||
    type === 'level_crossing'
  );
}

// ⑥ 仮置き中の1件（同じツールで複数件をまとめて保持し、最後にまとめて確定する）
interface PendingItem {
  tool: ActiveTool;
  x: number;
  z: number;
  rotation: number;
  ghost: THREE.Object3D | null;
  stationPart?: 'single' | 'start' | 'mid' | 'end';
  stationGroupId?: string; // ⑤ 駅グループ識別子
  switchBranchSide?: 'left' | 'right'; // ② 分岐器の左右分岐
  stationPlatformSide?: 'left' | 'right'; // ① 駅ホームの左右配置
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
  // ② 分岐器の左右分岐方向 ('right': 右分岐, 'left': 左分岐)
  private currentSwitchSide: 'left' | 'right' = 'right';
  // ① 駅舎ホームの配置方向 ('right': 右側, 'left': 左側)
  private currentStationSide: 'left' | 'right' = 'right';

  // ⑦ 車両基地・保有列車管理
  private fleetRegistry: FleetItem[] = [];
  private nextFleetId: number = 1;
  private deployingFleetId: string | null = null;
  private deployDirectionIdx: number = 0;

  // ④ 現在選択されている駅ホーム有効長（1〜4両）
  private currentStationLength: 1 | 2 | 3 | 4 = 2;

  // ⑤ インスペクターで選択中のオブジェクト追跡
  private selectedTilePos: { x: number; z: number } | null = null;
  private selectedTrainId: number | null = null;

  // ⑥ 仮置き中のプレースメント一覧（同じツールで複数件をまとめて保持し、決定ボタンで一括確定する）
  private pendingItems: PendingItem[] = [];
  private ghostMaterial = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.5,
    depthWrite: false
  });

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
    this.uiManager.getCurrentHour = () => this.economy.getHour();
    this.uiManager.getCurrentMinute = () => this.economy.getMinute();

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

    // ③ シーサスクロッシング開通状態切り替えハンドラ
    this.uiManager.onCycleCrossing = (x, z) => {
      this.worldMap.cycleCrossingState(x, z);
      const tile = this.worldMap.getTile(x, z);
      if (tile) {
        this.uiManager.showInspector(tile);
        this.audioManager.playBuildSound();
      }
    };

    // ② 駅ダイヤ変更ハンドラ（駅グループの全タイルに同一スケジュールを同期）
    this.uiManager.onStationScheduleChanged = (tile, sched) => {
      const tiles = this.worldMap.getStationTiles(tile.x, tile.z);
      for (const t of tiles) {
        t.stationSchedule = sched;
      }
    };

    // ⑤ & ⑦ 車両購入確定ハンドラ: 購入後、車両基地（fleetRegistry）に配属
    this.uiManager.onConfirmBuyTrain = (model: VehicleModelInfo, cars: 1 | 2 | 3 | 4) => {
      const totalPrice = model.basePrice * cars;
      if (!this.economy.spendFunds(totalPrice, true)) {
        alert(`資金が不足しています！ (必要: ¥${totalPrice.toLocaleString()})`);
        return;
      }

      const fleetId = `fleet-${this.nextFleetId++}`;
      const countOfModel = this.fleetRegistry.filter(f => f.model.id === model.id).length + 1;
      const fleetItem: FleetItem = {
        id: fleetId,
        name: `${model.name} ${countOfModel}号`,
        model,
        cars,
        status: 'in_depot'
      };
      this.fleetRegistry.push(fleetItem);
      this.audioManager.playStationBell();

      alert(`🎉 ${fleetItem.name} を購入し、車両基地へ配属しました！\n右上の「🚆 車両管理」からいつでも線路へ配置できます。`);
      this.syncFleetStats();
      this.uiManager.showFleetModal(this.fleetRegistry);
    };

    // ⑦ 車両管理モーダル開閉
    this.uiManager.onOpenFleetModal = () => {
      this.syncFleetStats();
      this.uiManager.showFleetModal(this.fleetRegistry);
    };

    // ⑦ 保有列車を線路に配置するモードに入る
    this.uiManager.onDeployFleetTrain = (fleetId: string) => {
      const item = this.fleetRegistry.find(f => f.id === fleetId);
      if (!item) return;

      this.deployingFleetId = fleetId;
      this.deployDirectionIdx = 0;
      this.cancelPendingPlacements();
      this.uiManager.setRotationHint(true, `🚆 【${item.name}】配置先を選択: 線路をクリック（🔄回転で進行方向切替）`);
    };

    // ⑦ 営業中の列車を車庫へ回送（回収）する
    this.uiManager.onRecallFleetTrain = (fleetId: string) => {
      const item = this.fleetRegistry.find(f => f.id === fleetId);
      if (!item || item.status !== 'deployed' || item.activeTrainId === undefined) return;

      const train = this.trainManager.getTrainById(item.activeTrainId);
      if (train) {
        item.totalPassengers = (item.totalPassengers ?? 0) + train.totalPassengers;
        item.totalRevenue = (item.totalRevenue ?? 0) + train.totalRevenue;
      }
      this.trainManager.removeTrain(item.activeTrainId);
      item.status = 'in_depot';
      item.activeTrainId = undefined;
      this.audioManager.playDemolishSound();
      this.syncFleetStats();
      this.uiManager.showFleetModal(this.fleetRegistry);
    };

    // ⑦ 営業中の列車にカメラ追従
    this.uiManager.onTrackFleetTrain = (fleetId: string) => {
      const item = this.fleetRegistry.find(f => f.id === fleetId);
      if (!item || item.status !== 'deployed' || item.activeTrainId === undefined) return;
      const train = this.trainManager.getTrainById(item.activeTrainId);
      if (train) {
        this.cameraController.target.set(train.frontPosition.x, 0, train.frontPosition.z);
        this.uiManager.showTrainInspector(train);
      }
    };

    // ② 分岐器の左右分岐切替
    this.uiManager.onToggleSwitchSide = () => {
      this.currentSwitchSide = this.currentSwitchSide === 'right' ? 'left' : 'right';
      this.uiManager.setSwitchSideButtonVisible(true, this.currentSwitchSide);
      if (this.pendingItems.length > 0) {
        const lastItem = this.pendingItems[this.pendingItems.length - 1];
        if (lastItem.tool.startsWith('point-switch')) {
          lastItem.switchBranchSide = this.currentSwitchSide;
          this.refreshGhostFor(lastItem);
        }
      }
      this.updateRotationHint(this.uiManager.getActiveTool());
    };

    // ① 駅舎ホームの左右配置切替
    this.uiManager.onToggleStationSide = () => {
      this.toggleStationSide();
    };

    // ② 開発テスト用: 資金無限モード切替
    this.uiManager.onToggleInfiniteFunds = () => {
      this.toggleInfiniteFunds();
    };

    // ① 列車撤去ハンドラ
    this.uiManager.onRemoveTrain = (trainId: number) => {
      // fleetRegistry内のステータスも戻す
      const fleetItem = this.fleetRegistry.find(f => f.activeTrainId === trainId);
      if (fleetItem) {
        fleetItem.status = 'in_depot';
        fleetItem.activeTrainId = undefined;
      }
      if (this.trainManager.removeTrain(trainId)) {
        this.audioManager.playDemolishSound();
      }
    };

    this.uiManager.onToolChanged = (tool: ActiveTool) => {
      // ⑥ ツールを切り替えたら仮置き中のプレースメントは全て破棄する
      this.cancelPendingPlacements();
      this.deployingFleetId = null;
      this.hoverPlane.scale.set(1, 1, 1);

      if (tool === 'train-buy') {
        this.uiManager.openVehicleModal();
      }

      this.updateRotationHint(tool);
    };

    // ⑦ 「設置を決定」ボタン
    this.uiManager.onConfirmPlacement = () => {
      this.confirmPendingPlacements();
    };

    // ⑦ 「キャンセル」ボタン
    this.uiManager.onCancelPlacement = () => {
      this.cancelPendingPlacements();
      this.updateRotationHint(this.uiManager.getActiveTool());
    };

    // ⑤ タッチデバイス用「回転」ボタン（右クリックの代替）
    this.uiManager.onRotatePlacement = () => {
      this.rotateCurrentPlacement();
    };

    // ④ 駅ホーム有効長セレクター変更コールバック
    this.uiManager.onStationLengthChanged = (len) => {
      this.currentStationLength = len;
      this.cancelPendingPlacements();
      this.updateRotationHint(this.uiManager.getActiveTool());
    };

    // ④ インスペクターからの駅有効長設定変更コールバック
    this.uiManager.onSetStationLength = (x, z, targetLen) => {
      const ok = this.worldMap.setStationLength(x, z, targetLen);
      if (ok) {
        this.audioManager.playBuildSound();
        const tile = this.worldMap.getTile(x, z);
        if (tile) {
          const stData = this.worldMap.getStationAggregateData(x, z);
          this.uiManager.showInspector(tile, undefined, targetLen, stData);
        }
      } else {
        alert('ホームを延伸するためのスペース（更地または線路）が不足しています。');
      }
    };
  }

  /**
   * ⑦ 保有列車の累計乗客数・収支を運行中のインスタンスと同期
   */
  private syncFleetStats() {
    for (const item of this.fleetRegistry) {
      if (item.status === 'deployed' && item.activeTrainId !== undefined) {
        const train = this.trainManager.getTrainById(item.activeTrainId);
        if (train) {
          item.totalPassengers = train.totalPassengers;
          item.totalRevenue = train.totalRevenue;
        }
      }
    }
  }

  /**
   * ⑥⑧ 現在のツール・回転状態、仮置き件数・合計金額に応じたヒント表示を更新（スッキリした要点表示）
   */
  private updateRotationHint(tool: ActiveTool) {
    if (this.deployingFleetId) {
      const item = this.fleetRegistry.find(f => f.id === this.deployingFleetId);
      this.uiManager.setSwitchSideButtonVisible(false);
      this.uiManager.setRotationHint(true, `🚆 【${item?.name}】配置先: 線路をクリック（進行方向: ${DIR_LABEL[this.deployDirectionIdx]}）`);
      return;
    }

    if (!ROTATABLE_TOOLS.includes(tool)) {
      this.uiManager.setRotationHint(false);
      this.uiManager.setSwitchSideButtonVisible(false);
      this.uiManager.setStationSideButtonsVisible(false);
      return;
    }

    const isSwitch = (tool === 'point-switch' || tool === 'point-switch-elevated');
    const isStation = tool.startsWith('station');
    this.uiManager.setSwitchSideButtonVisible(isSwitch, this.currentSwitchSide);
    this.uiManager.setStationSideButtonsVisible(isStation, this.currentStationSide);

    let label: string;
    if (tool === 'rail-curve' || tool === 'rail-curve-elevated') {
      label = `向き: ${CURVE_DIR_LABEL[CURVE_DIR_ORDER[this.currentRotation]]}`;
    } else if (isSwitch) {
      label = `通過方向: ${DIR_LABEL[this.currentRotation]}（分岐: ${this.currentSwitchSide === 'left' ? '左' : '右'}）`;
    } else if (tool === 'scissors-crossing' || tool === 'scissors-crossing-elevated') {
      label = `並走方向: ${AXIS_LABEL[this.currentRotation % 2]}`;
    } else if (tool === 'rail-slope') {
      const axis = this.currentRotation % 2;
      const reversed = this.currentRotation >= 2;
      const axisDirs = axis === 1 ? ['西', '東'] : ['北', '南'];
      const [low, high] = reversed ? [axisDirs[1], axisDirs[0]] : axisDirs;
      label = `上り方向: ${low} → ${high}`;
    } else if (isStation) {
      const sideText = this.currentStationSide === 'left' ? '左' : '右';
      label = `向き: ${AXIS_LABEL[this.currentRotation % 2]}（${this.currentStationLength}両・ホーム${sideText}側）`;
    } else {
      label = `向き: ${AXIS_LABEL[this.currentRotation % 2]}`;
    }

    const items = this.pendingItems.filter(p => p.tool === tool);
    if (items.length > 0) {
      const total = items.reduce((sum, it) => sum + TOOL_CONFIG[it.tool].cost, 0);
      label = `🔶 仮置き ${items.length}件 (¥${total.toLocaleString()}) | ${label}`;
    }

    this.uiManager.setRotationHint(true, label);
  }

  /**
   * ① 駅舎ホームの配置方向（右側・左側）を切り替える
   */
  private toggleStationSide() {
    this.currentStationSide = this.currentStationSide === 'right' ? 'left' : 'right';
    const tool = this.uiManager.getActiveTool();
    if (tool.startsWith('station') && this.pendingItems.length > 0) {
      for (const item of this.pendingItems) {
        if (item.tool.startsWith('station')) {
          item.stationPlatformSide = this.currentStationSide;
          this.refreshGhostFor(item);
        }
      }
    }
    this.audioManager.playSelectSound();
    this.updateRotationHint(tool);
  }

  /**
   * ② 開発テスト用: 資金無限モードのON/OFF切り替え
   */
  private toggleInfiniteFunds() {
    const isInf = this.economy.toggleInfiniteFunds();
    this.uiManager.updateInfiniteFundsUI(isInf);
    this.audioManager.playSelectSound();
    // メッセージ表示
    const msg = isInf
      ? '💰 【開発テスト用】資金無限モードを [ON] にしました。資金が減少しなくなります。'
      : '💰 資金無限モードを [OFF] に戻しました。通常の資金管理に戻ります。';
    console.log(msg);
  }

  /**
   * ① ⑤ 設置向きを回転。右クリック・タッチ用の回転ボタン両方から呼ばれる。
   * 仮置き中のマスが存在する場合は、直前に仮置きしたマス（線路等）の方角を即座に更新してゴーストを再描画する。
   */
  private rotateCurrentPlacement() {
    if (this.deployingFleetId) {
      // 進行方向（0-3: 北, 東, 南, 西）の切替
      this.deployDirectionIdx = (this.deployDirectionIdx + 1) % 4;
      const item = this.fleetRegistry.find(f => f.id === this.deployingFleetId);
      this.uiManager.setRotationHint(true, `🚆 【${item?.name}】配置先: 線路をクリック（進行方向: ${DIR_LABEL[this.deployDirectionIdx]}）`);
      return;
    }

    const tool = this.uiManager.getActiveTool();
    if (!ROTATABLE_TOOLS.includes(tool)) return;

    if (tool === 'point-switch' || tool === 'point-switch-elevated') {
      this.currentRotation = (this.currentRotation + 1) % 4;
      if (this.currentRotation === 0) {
        // 4方向一巡したら左右反転（北右→東右→南右→西右→北左→東左→南左→西左）
        this.currentSwitchSide = this.currentSwitchSide === 'right' ? 'left' : 'right';
      }
    } else {
      this.currentRotation = (this.currentRotation + 1) % 4;
    }

    // ① 直前に仮置きしたアイテムの方角を更新
    if (this.pendingItems.length > 0) {
      if (tool.startsWith('station')) {
        // 駅の場合：直前の駅グループ（currentStationLengthマス分）を回転
        const stationItems = this.pendingItems.filter(p => p.tool === tool);
        if (stationItems.length > 0) {
          const groupCount = Math.min(stationItems.length, this.currentStationLength);
          const startIdx = stationItems.length - groupCount;
          const originX = stationItems[startIdx].x;
          const originZ = stationItems[startIdx].z;
          const axis = this.currentRotation % 2;
          const stepX = axis === 1 ? 1 : 0;
          const stepZ = axis === 1 ? 0 : 1;

          for (let i = 0; i < groupCount; i++) {
            const it = stationItems[startIdx + i];
            it.x = originX + stepX * i;
            it.z = originZ + stepZ * i;
            it.rotation = this.currentRotation;
            this.refreshGhostFor(it);
          }
        }
      } else {
        // 単一マスの線路・カーブ・スロープ・分岐器・シーサス等
        const lastItem = this.pendingItems[this.pendingItems.length - 1];
        if (ROTATABLE_TOOLS.includes(lastItem.tool)) {
          lastItem.rotation = this.currentRotation;
          if (lastItem.tool.startsWith('point-switch')) {
            lastItem.switchBranchSide = this.currentSwitchSide;
          }
          this.refreshGhostFor(lastItem);
        }
      }
    }

    this.updateRotationHint(tool);
  }

  private setupInteraction() {
    const dom = this.renderer.renderer.domElement;
    let mouseDownPos = { x: 0, y: 0 };
    let hasDragged = false;

    dom.addEventListener('mousedown', (e) => {
      mouseDownPos = { x: e.clientX, y: e.clientY };
      hasDragged = false;
    });

    // Mouse move for hover cursor
    dom.addEventListener('mousemove', (e) => {
      const rect = dom.getBoundingClientRect();
      this.mousePos.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mousePos.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      if (!hasDragged && Math.hypot(e.clientX - mouseDownPos.x, e.clientY - mouseDownPos.y) > 6) {
        hasDragged = true;
      }

      this.updateHover();
    });

    // ⑤ 左クリックで設置・選択・撤去（メインアクション）
    dom.addEventListener('click', (e) => {
      if (hasDragged) return;
      if (e.button !== 0) return;
      if (this.cameraController.mode === 'cab') return;

      this.handleTileClick();
    });

    // ⑤ 右クリックで設置向きを回転（0-3を循環）
    dom.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (hasDragged) return;
      if (this.cameraController.mode === 'cab') return;

      const tool = this.uiManager.getActiveTool();
      if (ROTATABLE_TOOLS.includes(tool)) {
        this.rotateCurrentPlacement();
      }
    });

    // Escape で仮置き中のプレースメントを全てキャンセル / M で資金無限モード切替
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.cancelPendingPlacements();
        this.updateRotationHint(this.uiManager.getActiveTool());
      } else if (e.key === 'm' || e.key === 'M') {
        this.toggleInfiniteFunds();
      }
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
  // ⑥ 仮置き（プレースメント・ゴースト）フロー：複数マスをまとめて仮置きし、最後に一括確定する
  // ---------------------------------------------------------------------

  /**
   * 現在のツール・向きに応じたプレビュー用メッシュ（半透明ゴースト）を生成する。
   * 分岐器・シーサスクロッシング・勾配は複数マスにまたがるため、実際の設置と同じレイアウトを
   * 起点タイルからの相対オフセットで組み立てたグループとして返す。
   */
  private createGhostMesh(
    tool: ActiveTool,
    rotation: number,
    stationPart: 'single' | 'start' | 'mid' | 'end' = 'single',
    branchSide: 'left' | 'right' = this.currentSwitchSide,
    platformSide: 'left' | 'right' = this.currentStationSide
  ): THREE.Object3D | null {
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
        mesh = ModelFactory.createSwitchHub(rotation, false, false, branchSide);
        break;
      case 'point-switch-elevated':
        mesh = ModelFactory.createSwitchHub(rotation, false, true, branchSide);
        break;
      case 'scissors-crossing':
        mesh = this.createScissorsGhostGroup(rotation, false);
        break;
      case 'scissors-crossing-elevated':
        mesh = this.createScissorsGhostGroup(rotation, true);
        break;
      case 'station-small':
        mesh = ModelFactory.createStation(axis, false, stationPart, platformSide);
        break;
      case 'station-elevated':
        mesh = ModelFactory.createStation(axis, true, stationPart, platformSide);
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
   * 勾配(4×1)ゴースト。WorldMap.placeSlope と同じレイアウト計算で4パーツを並べる。
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
   * ③ シーサスクロッシング(2×2)ゴースト。WorldMap.placeScissorsCrossing と同じレイアウトで4パーツを並べる。
   */
  private createScissorsGhostGroup(rotation: number, isElevated: boolean): THREE.Group {
    const group = new THREE.Group();
    const along = rotation === 1 ? 1 : 2;
    const across = WorldMap.rotateCW(along);
    const alongVec = WorldMap.DIRS[along];
    const acrossVec = WorldMap.DIRS[across];

    const offsets: { x: number; z: number; role: 0 | 1 | 2 | 3 }[] = [
      { x: 0, z: 0, role: 0 },
      { x: alongVec.x, z: alongVec.z, role: 1 },
      { x: acrossVec.x, z: acrossVec.z, role: 2 },
      { x: alongVec.x + acrossVec.x, z: alongVec.z + acrossVec.z, role: 3 }
    ];

    for (const o of offsets) {
      const part = ModelFactory.createScissorsCrossingTile(along, o.role, isElevated);
      part.position.set(o.x * WorldMap.TILE_SIZE, 0, o.z * WorldMap.TILE_SIZE);
      group.add(part);
    }
    return group;
  }

  /**
   * ⑥ 指定した仮置きアイテムのゴーストを（再）生成する
   */
  private refreshGhostFor(item: PendingItem) {
    if (item.ghost) {
      this.renderer.scene.remove(item.ghost);
      item.ghost = null;
    }
    const branchSide = item.switchBranchSide ?? this.currentSwitchSide;
    const platformSide = item.stationPlatformSide ?? this.currentStationSide;
    const ghost = this.createGhostMesh(item.tool, item.rotation, item.stationPart ?? 'single', branchSide, platformSide);
    if (ghost) {
      ghost.position.set(item.x * WorldMap.TILE_SIZE, 0, item.z * WorldMap.TILE_SIZE);
      this.renderer.scene.add(ghost);
    }
    item.ghost = ghost;
  }

  private cancelPendingPlacements() {
    for (const item of this.pendingItems) {
      if (item.ghost) this.renderer.scene.remove(item.ghost);
    }
    this.pendingItems = [];
    this.uiManager.setPlacementButtonsVisible(false);
  }

  /**
   * ⑥ 仮置きを追加する（まだワールドには反映しない・課金しない）。
   * 駅ツールの場合は、選択された有効長（1〜4両）に応じて複数マスを一括して仮置きする。
   * 既に同じ位置に仮置き済みなら、その1件（または駅グループ）を取り消す（トグル）。
   */
  private stagePendingPlacement(tool: ActiveTool, x: number, z: number) {
    if (tool === 'station-small' || tool === 'station-elevated') {
      const len = this.currentStationLength;
      const axis = this.currentRotation % 2;
      const stepX = axis === 1 ? 1 : 0;
      const stepZ = axis === 1 ? 0 : 1;

      // 既存グループ（x, z 付近）があればトグル解除
      const existingIdx = this.pendingItems.findIndex(p => p.tool === tool && p.x === x && p.z === z);
      if (existingIdx !== -1) {
        // 同じ駅グループ（連続するアイテム）をまとめて解除
        const originItem = this.pendingItems[existingIdx];
        const toRemove = this.pendingItems.filter(p => {
          return p.tool === tool && Math.abs(p.x - originItem.x) <= 4 && Math.abs(p.z - originItem.z) <= 4;
        });
        for (const rem of toRemove) {
          if (rem.ghost) this.renderer.scene.remove(rem.ghost);
        }
        this.pendingItems = this.pendingItems.filter(p => !toRemove.includes(p));
        this.uiManager.setPlacementButtonsVisible(this.pendingItems.length > 0);
        this.updateRotationHint(tool);
        return;
      }

      // ① 本設置済みの線路・駅への誤上書きを防止
      for (let i = 0; i < len; i++) {
        const tx = x + stepX * i;
        const tz = z + stepZ * i;
        if (this.worldMap.isPermanentTrackOrStation(tx, tz)) {
          return; // 本設置済みインフラがあるため仮置き不可
        }
      }

      // ④ 指定有効長分（1〜4マス）のホームをまとめて仮置き
      const groupId = `st_${Date.now()}_${x}_${z}`;
      for (let i = 0; i < len; i++) {
        const tx = x + stepX * i;
        const tz = z + stepZ * i;
        const part = (len === 1) ? 'single' : (i === 0 ? 'start' : (i === len - 1 ? 'end' : 'mid'));
        const item: PendingItem = {
          tool,
          x: tx,
          z: tz,
          rotation: this.currentRotation,
          ghost: null,
          stationPart: part,
          stationGroupId: groupId,
          stationPlatformSide: this.currentStationSide
        };
        this.pendingItems.push(item);
        this.refreshGhostFor(item);
      }
      this.uiManager.setPlacementButtonsVisible(true);
      this.updateRotationHint(tool);
      return;
    }

    const existingIdx = this.pendingItems.findIndex(p => p.tool === tool && p.x === x && p.z === z);
    if (existingIdx !== -1) {
      const [removed] = this.pendingItems.splice(existingIdx, 1);
      if (removed.ghost) this.renderer.scene.remove(removed.ghost);
      this.uiManager.setPlacementButtonsVisible(this.pendingItems.length > 0);
      this.updateRotationHint(tool);
      return;
    }

    // ① 本設置済みの線路・駅への誤上書きを防止
    if (this.worldMap.isPermanentTrackOrStation(x, z)) {
      return; // 本設置済みインフラがあるため仮置き不可
    }

    const item: PendingItem = {
      tool,
      x,
      z,
      rotation: this.currentRotation,
      ghost: null,
      switchBranchSide: tool.startsWith('point-switch') ? this.currentSwitchSide : undefined
    };
    this.pendingItems.push(item);
    this.refreshGhostFor(item);
    this.uiManager.setPlacementButtonsVisible(true);
    this.updateRotationHint(tool);
  }

  /**
   * ⑥⑦ 仮置き中の全アイテムを「設置を決定」ボタンでまとめて確定する。
   * 所持金の判定はここで一括して行い（合計金額が足りなければ何も設置しない）、
   * 足りていれば全アイテムを一括で本設置する。
   */
  private confirmPendingPlacements() {
    if (this.pendingItems.length === 0) return;

    const items = this.pendingItems;
    const total = items.reduce((sum, it) => sum + TOOL_CONFIG[it.tool].cost, 0);

    if (!this.economy.spendFunds(total, true)) {
      alert(`資金が不足しています！(必要: ¥${total.toLocaleString()})`);
      return;
    }

    let placedCount = 0;
    let refund = 0;
    for (const item of items) {
      const ok = this.executePlacement(
        item.tool,
        item.x,
        item.z,
        item.rotation,
        item.switchBranchSide,
        item.stationPart,
        item.stationGroupId,
        item.stationPlatformSide
      );
      if (ok) {
        placedCount++;
      } else {
        refund += TOOL_CONFIG[item.tool].cost;
      }
    }
    if (refund > 0) {
      this.economy.spendFunds(-refund, true); // 設置に失敗した分だけ返金
    }
    if (placedCount > 0) {
      this.audioManager.playBuildSound();
    }
    if (placedCount < items.length) {
      alert(`${items.length - placedCount}件はスペース不足のため設置できませんでした（その分は返金されます）。`);
    }

    this.cancelPendingPlacements();
    this.updateRotationHint(this.uiManager.getActiveTool());
  }

  /**
   * 実際の設置処理（WorldMap 反映のみ。課金は呼び出し側で一括して行う）。成否を返す。
   */
  private executePlacement(
    tool: ActiveTool,
    x: number,
    z: number,
    rotation: number,
    branchSide: 'left' | 'right' = 'right',
    stationPart?: 'single' | 'start' | 'mid' | 'end',
    stationGroupId?: string,
    stationPlatformSide: 'left' | 'right' = 'right'
  ): boolean {
    // ① 本設置済みの線路・駅への誤上書きを防止
    if (this.worldMap.isPermanentTrackOrStation(x, z)) {
      return false;
    }

    // ② ③ 曲線レール敷設（地上/高架、1マス斜め接続）
    if (tool === 'rail-curve' || tool === 'rail-curve-elevated') {
      const isElevated = tool === 'rail-curve-elevated';
      const curveDir = CURVE_DIR_ORDER[rotation];
      return this.worldMap.placeCurve(x, z, curveDir, isElevated);
    }

    // ② 分岐器敷設（地上/高架、1マス、左右分岐対応）
    if (tool === 'point-switch' || tool === 'point-switch-elevated') {
      const isElevated = tool === 'point-switch-elevated';
      return this.worldMap.placeSwitch(x, z, rotation, isElevated, branchSide);
    }

    // ③ シーサスクロッシング敷設（地上/高架、2×2）
    if (tool === 'scissors-crossing' || tool === 'scissors-crossing-elevated') {
      const isElevated = tool === 'scissors-crossing-elevated';
      return this.worldMap.placeScissorsCrossing(x, z, rotation, isElevated);
    }

    // ① 勾配レール敷設（4マス直線、地上⇔高架を緩やかに接続）
    if (tool === 'rail-slope') {
      const axis = rotation % 2;
      const reversed = rotation >= 2;
      return this.worldMap.placeSlope(x, z, axis, reversed);
    }

    // ⑧ 通常の建設（向きは rotation の軸成分を使用）
    const config = TOOL_CONFIG[tool];
    if (config.tileType) {
      const tileRotation = ROTATABLE_TOOLS.includes(tool) ? rotation % 2 : 0;
      const ok = this.worldMap.setTile(x, z, config.tileType as TileType, tileRotation, 1, stationPlatformSide);
      if (ok) {
        if (tool === 'station-small' || tool === 'station-elevated') {
          const tile = this.worldMap.getTile(x, z);
          if (tile) {
            tile.stationPlatformSide = stationPlatformSide;
            tile.stationTargetLength = this.currentStationLength;
            tile.stationSchedule = tile.stationSchedule || createDefaultStationSchedule();
            if (stationGroupId) tile.stationGroupId = stationGroupId;
            if (stationPart) {
              tile.stationPart = stationPart;
              if (tile.mesh) {
                this.renderer.scene.remove(tile.mesh);
                const isElevated = tool === 'station-elevated';
                const newMesh = ModelFactory.createStation(tileRotation, isElevated, stationPart, stationPlatformSide);
                newMesh.position.set(x * WorldMap.TILE_SIZE, 0, z * WorldMap.TILE_SIZE);
                this.renderer.scene.add(newMesh);
                tile.mesh = newMesh;
              }
            }
          }
        }
        if (config.tileType === 'residence') {
          this.economy.addPopulation(30);
        } else if (config.tileType === 'commercial') {
          this.economy.addPopulation(100);
        }
      }
      return ok;
    }

    return false;
  }

  private handleTileClick() {
    if (!this.hoveredTile) return;
    const { x, z } = this.hoveredTile;
    const tool = this.uiManager.getActiveTool();

    // ⑦ 保有列車の線路配置モード中
    if (this.deployingFleetId) {
      const tile = this.worldMap.getTile(x, z);
      if (!tile || !isTrackLikeType(tile.type)) {
        alert('列車は線路または駅の上に配置してください。');
        return;
      }
      const item = this.fleetRegistry.find(f => f.id === this.deployingFleetId);
      if (item) {
        const train = this.trainManager.spawnTrain(
          x,
          z,
          item.model,
          item.cars,
          this.deployDirectionIdx,
          item.id
        );
        if (train) {
          item.status = 'deployed';
          item.activeTrainId = train.id;
          this.audioManager.playStationBell();
          alert(`🚅 【${item.name}】が線路に配置され、営業運行を開始しました！`);
        } else {
          alert('配置に失敗しました。線路の接続や方向をご確認ください。');
        }
      }
      this.deployingFleetId = null;
      this.uiManager.setRotationHint(false);
      this.updateRotationHint(tool);
      return;
    }

    // Select mode（① 列車を優先的にレイキャスト）
    if (tool === 'select') {
      const train = this.raycastTrain();
      if (train) {
        this.selectedTrainId = train.id;
        this.selectedTilePos = null;
        this.uiManager.showTrainInspector(train);
        return;
      }
      const tile = this.worldMap.getTile(x, z);
      if (tile) {
        this.selectedTrainId = null;
        this.selectedTilePos = { x, z };
        const hub = this.worldMap.resolveSwitchHub(x, z);
        const runLength = tile.type.startsWith('station') ? this.worldMap.getStationRunLength(x, z) : undefined;
        const stData = tile.type.startsWith('station') ? this.worldMap.getStationAggregateData(x, z) : undefined;
        this.uiManager.showInspector(tile, hub, runLength, stData);
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

    // ⑤ & ⑦ 列車購入モード（クリックで車両購入モーダルを開く）
    if (tool === 'train-buy') {
      this.uiManager.openVehicleModal();
      return;
    }

    // ⑥⑦ 仮置き（回転可・複数マス可）。本設置は「設置を決定」ボタンでまとめて行う。
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
    // 西側駅（2マスホーム: X=-6, X=-5）
    this.worldMap.placeStationGroup(-6, 0, 2, 1, false, '西中央駅');

    // 中間地上線路
    for (let x = -4; x <= 0; x++) {
      this.worldMap.setTile(x, 0, 'rail_ground', 1);
    }

    // ① 勾配レール（4マス直線: X=1[地上]→X=4[高架] へ緩やかに上る）
    this.worldMap.placeSlope(1, 0, 1, true);

    // 東側高架駅（2マスホーム: X=5, X=6）
    this.worldMap.placeStationGroup(5, 0, 2, 1, true, '東高架駅');

    // ② 分岐器（ポイント、1マス）を西側駅の手前に設置。forward=1(東)で通過、分岐は南側(+Z)へ。
    this.worldMap.placeSwitch(-3, 0, 1, false);

    // 道路（線路と交差する箇所は自動で踏切になる）
    for (let x = -7; x <= 7; x++) {
      this.worldMap.setTile(x, 2, 'road', 1);
    }

    // ⑤ 踏切のデモ: 地上線路(X=-2, Z=0, 南北軸なし=東西軸)と直交する道路を重ねて自動生成させる
    this.worldMap.setTile(-2, -1, 'road', 0);
    this.worldMap.setTile(-2, 0, 'road', 0);
    this.worldMap.setTile(-2, 1, 'road', 0);

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
    this.cancelPendingPlacements();
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
    this.trainManager.update(
      deltaTime,
      gameplayMult,
      (fare) => {
        this.economy.addFunds(fare);
      },
      this.economy.getHour(),
      this.economy.getMinute()
    );

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
        const trackCount = allTiles.filter(t => isTrackLikeType(t.type)).length;
        const trainRunningCost = this.trainManager.getTrains().reduce(
          (sum, t) => sum + getRunningCostPerDay(t.model, t.carCount) * 30,
          0
        );
        const maint = trackCount * 500000 + trainRunningCost;
        this.economy.spendFunds(maint, false);

        // ⑤ 列車ごとの運行維持費を計上
        this.trainManager.deductPeriodicOperatingCosts();
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

    // ⑤ 選択中オブジェクトのインスペクターリアルタイム更新（列車乗客数や駅収支の変化を反映）
    if (this.selectedTrainId !== null) {
      const train = this.trainManager.getTrains().find(t => t.id === this.selectedTrainId);
      if (train) {
        this.uiManager.showTrainInspector(train);
      } else {
        this.selectedTrainId = null;
      }
    } else if (this.selectedTilePos !== null) {
      const tile = this.worldMap.getTile(this.selectedTilePos.x, this.selectedTilePos.z);
      if (tile && tile.type.startsWith('station')) {
        const hub = this.worldMap.resolveSwitchHub(tile.x, tile.z);
        const runLength = this.worldMap.getStationRunLength(tile.x, tile.z);
        const stData = this.worldMap.getStationAggregateData(tile.x, tile.z);
        this.uiManager.showInspector(tile, hub, runLength, stData);
      }
    }

    const allTiles = this.worldMap.getAllTiles();
    const trackCount = allTiles.filter(t => isTrackLikeType(t.type)).length;
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
