import {
  TileType,
  TileData,
  StationActionMode,
  StationSchedule,
  createDefaultStationSchedule,
  createDefaultSwitchSchedule
} from '../simulation/WorldMap';
import { FinancialReportData } from '../simulation/Economy';
import { CameraMode } from '../engine/CameraController';
import { VEHICLE_CATALOG, VehicleModelInfo } from '../simulation/VehicleCatalog';
import { TrainInstance } from '../simulation/TrainManager';

export type ActiveTool =
  | 'select'
  | 'rail-straight'
  | 'rail-curve'
  | 'rail-curve-elevated'
  | 'point-switch'
  | 'point-switch-elevated'
  | 'scissors-crossing'
  | 'scissors-crossing-elevated'
  | 'rail-slope'
  | 'rail-elevated'
  | 'station-small'
  | 'station-elevated'
  | 'train-buy'
  | 'road'
  | 'building-res'
  | 'building-com'
  | 'nature'
  // ② 撤去はカテゴリごとに分割し、該当カテゴリの物のみ削除できるようにする
  | 'demolish-track'
  | 'demolish-station'
  | 'demolish-city'
  | 'demolish-train';

export const TOOL_CONFIG: Record<ActiveTool, { cost: number; tileType: TileType | null; name: string; icon: string }> = {
  'select': { cost: 0, tileType: null, name: '選択/情報', icon: '👆' },
  'rail-straight': { cost: 2000000, tileType: 'rail_ground', name: '線路(地上)', icon: '🛤️' },
  'rail-elevated': { cost: 5000000, tileType: 'rail_elevated', name: '高架線路', icon: '🌉' },
  'rail-curve': { cost: 6000000, tileType: null, name: '曲線(地上)', icon: '↪️' },
  'rail-curve-elevated': { cost: 9000000, tileType: null, name: '曲線(高架)', icon: '🌀' },
  'rail-slope': { cost: 5000000, tileType: 'rail_slope', name: '勾配スロープ', icon: '📈' },
  // ② 分岐器は1×1マスになったので価格を単体線路タイル相当に見直す
  'point-switch': { cost: 2500000, tileType: null, name: '分岐器(地上)', icon: '🔀' },
  'point-switch-elevated': { cost: 4000000, tileType: null, name: '分岐器(高架)', icon: '🔀' },
  // ③ シーサスクロッシング（複線用交差分岐、2×2）
  'scissors-crossing': { cost: 8000000, tileType: null, name: 'シーサス(地上)', icon: '✖️' },
  'scissors-crossing-elevated': { cost: 12000000, tileType: null, name: 'シーサス(高架)', icon: '✖️' },
  'station-small': { cost: 20000000, tileType: 'station_ground', name: '駅舎(地上)', icon: '🚉' },
  'station-elevated': { cost: 40000000, tileType: 'station_elevated', name: '高架駅', icon: '🚊' },
  'train-buy': { cost: 0, tileType: null, name: '列車購入', icon: '🚆' },
  'road': { cost: 1000000, tileType: 'road', name: '道路', icon: '🛣️' },
  'building-res': { cost: 10000000, tileType: 'residence', name: '住宅区画', icon: '🏡' },
  'building-com': { cost: 30000000, tileType: 'commercial', name: '商業ビル', icon: '🏢' },
  'nature': { cost: 500000, tileType: 'nature', name: '植林', icon: '🌲' },
  'demolish-track': { cost: 1000000, tileType: 'empty', name: '撤去(線路)', icon: '🚜' },
  'demolish-station': { cost: 1000000, tileType: 'empty', name: '撤去(駅)', icon: '🚜' },
  'demolish-city': { cost: 1000000, tileType: 'empty', name: '撤去(街づくり)', icon: '🚜' },
  'demolish-train': { cost: 0, tileType: 'empty', name: '撤去(列車)', icon: '🚮' }
};

// ⑤ ツールのカテゴリー分け（多層モーダル化してツールバーをすっきりさせる）
export interface ToolCategory {
  id: string;
  name: string;
  icon: string;
  tools: ActiveTool[];
  // ② このカテゴリ専用の撤去ツール（そのカテゴリに属する物だけ撤去できる）
  demolishTool: ActiveTool;
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: 'track',
    name: '線路',
    icon: '🛤️',
    tools: [
      'rail-straight', 'rail-elevated', 'rail-curve', 'rail-curve-elevated', 'rail-slope',
      'point-switch', 'point-switch-elevated', 'scissors-crossing', 'scissors-crossing-elevated'
    ],
    demolishTool: 'demolish-track'
  },
  {
    id: 'station',
    name: '駅',
    icon: '🚉',
    tools: ['station-small', 'station-elevated'],
    demolishTool: 'demolish-station'
  },
  {
    id: 'city',
    name: '街づくり',
    icon: '🏙️',
    tools: ['road', 'building-res', 'building-com', 'nature'],
    demolishTool: 'demolish-city'
  },
  {
    id: 'train',
    name: '列車',
    icon: '🚆',
    tools: ['train-buy'],
    demolishTool: 'demolish-train'
  }
];

// ⑦ 車両基地・保有列車アイテムのインターフェース
export interface FleetItem {
  id: string;
  name: string;
  model: VehicleModelInfo;
  cars: 1 | 2 | 3 | 4;
  status: 'in_depot' | 'deployed';
  activeTrainId?: number;
  totalPassengers?: number;
  totalRevenue?: number;
}

export class UIManager {
  private activeTool: ActiveTool = 'select';

  // DOM references
  private dateDisplay = document.getElementById('date-display')!;
  private fundsDisplay = document.getElementById('funds-display')!;
  private popDisplay = document.getElementById('population-display')!;

  private speedButtons = {
    pause: document.getElementById('btn-speed-pause')!,
    s1: document.getElementById('btn-speed-1')!,
    s2: document.getElementById('btn-speed-2')!,
    s3: document.getElementById('btn-speed-3')!
  };

  private audioToggleBtn = document.getElementById('btn-audio-toggle')!;
  private guideToggleBtn = document.getElementById('btn-guide-toggle');
  private helpModal = document.getElementById('help-modal')!;
  private closeHelpBtn = document.getElementById('btn-close-help')!;

  // ⑦ 車両管理モーダル references
  private fleetToggleBtn = document.getElementById('btn-fleet-toggle');
  private fleetFromModalBtn = document.getElementById('btn-fleet-from-modal');
  private fleetModal = document.getElementById('fleet-modal')!;
  private closeFleetBtn = document.getElementById('btn-close-fleet')!;
  private fleetList = document.getElementById('fleet-list')!;

  private reportBtn = document.getElementById('btn-report')!;
  private reportModal = document.getElementById('report-modal')!;
  private closeReportBtn = document.getElementById('btn-close-report')!;

  private camViewBtn = document.getElementById('btn-cam-view')!;
  private camViewText = document.getElementById('cam-view-text');
  private timeToggleBtn = document.getElementById('btn-time-toggle')!;
  private timeIcon = document.getElementById('time-icon')!;
  private timeText = document.getElementById('time-text');
  private gridToggleBtn = document.getElementById('btn-grid-toggle')!;

  private cabOverlay = document.getElementById('cab-view-overlay')!;
  private cabSpeedVal = document.getElementById('cab-speed-val')!;
  private exitCabBtn = document.getElementById('btn-exit-cab')!;

  private clockDisplay = document.getElementById('clock-display')!;

  // ⑤ カテゴリー化された多層ツールバー
  private categoryBtns = document.querySelectorAll<HTMLElement>('.category-btn');
  private topLevelToolBtns = document.querySelectorAll<HTMLElement>('#build-toolbar .tool-btn');
  private toolSubmenu = document.getElementById('tool-submenu')!;
  private submenuTitle = document.getElementById('submenu-title')!;
  private submenuGrid = document.getElementById('submenu-grid')!;
  private closeSubmenuBtn = document.getElementById('btn-close-submenu')!;
  private activeCategoryId: string | null = null;

  // ⑧ 回転バー / ⑦ 設置決定・キャンセル / ② 分岐切替 / ① 駅ホーム左右切替
  private rotationHint = document.getElementById('rotation-hint')!;
  private rotationValueEl = document.getElementById('rotation-value')!;
  private confirmPlacementBtn = document.getElementById('btn-confirm-placement')!;
  private cancelPlacementBtn = document.getElementById('btn-cancel-placement')!;
  private rotatePlacementBtn = document.getElementById('btn-rotate-placement')!;
  private switchSideBtn = document.getElementById('btn-switch-side-toggle')!;
  private stationSideHintBtn = document.getElementById('btn-station-side-hint-toggle');

  // ④ 駅ホーム有効長セレクター & ① ホーム左右切替ボタン
  private stationLengthSelector = document.getElementById('station-length-selector')!;
  private stationLengthBtns = document.querySelectorAll<HTMLElement>('.st-len-btn');
  private stationSideBtn = document.getElementById('btn-station-side-toggle');
  private selectedStationLength: 1 | 2 | 3 | 4 = 2;

  // ② 開発テスト用: 資金無限モードトリガー
  private fundsCardBtn = document.getElementById('btn-funds-toggle');
  private infiniteFundsReportBtn = document.getElementById('btn-infinite-funds');

  private inspectorPanel = document.getElementById('inspector-panel')!;
  private inspectCoords = document.getElementById('inspect-coords')!;
  private inspectType = document.getElementById('inspect-type')!;
  private inspectExtraVal = document.getElementById('inspect-extra-val')!;
  private inspectFinancialBox = document.getElementById('inspect-financial-box')!;
  private inspectActions = document.getElementById('inspect-actions')!;
  private closeInspectBtn = document.getElementById('btn-close-inspect')!;

  // ①② 大型ダイヤ設定モーダル（10分刻み）用プロパティ
  public getCurrentHour?: () => number;
  public getCurrentMinute?: () => number;
  private scheduleModal = document.getElementById('schedule-modal')!;
  private scheduleModalTitle = document.getElementById('schedule-modal-title')!;
  private scheduleModalBody = document.getElementById('schedule-modal-body')!;
  private closeScheduleBtn = document.getElementById('btn-close-schedule')!;
  private selectedScheduleHour: number = 8;
  private currentEditingTile: TileData | null = null;
  private currentEditingSwitchHub: TileData | null = null;
  private currentEditingStationData: any = null;
  private stationPaletteMode: StationActionMode = 'stop';
  private switchPaletteDir: 'straight' | 'diverge' = 'straight';

  // ⑤ & ⑦ Vehicle Modal references
  private vehicleModal = document.getElementById('vehicle-modal')!;
  private vehicleGrid = document.getElementById('vehicle-grid')!;
  private closeVehicleBtn = document.getElementById('btn-close-vehicle')!;
  private vehTotalPrice = document.getElementById('veh-total-price')!;
  private confirmBuyTrainBtn = document.getElementById('btn-confirm-buy-train')!;

  private selectedVehicle: VehicleModelInfo = VEHICLE_CATALOG[0]; // Default: 通勤型列車
  private selectedCarCount: 1 | 2 | 3 | 4 = 3; // Default: 3両

  // Callbacks
  public onToolChanged: (tool: ActiveTool) => void = () => {};
  // ⑤ speed: 0=一時停止, 1=通常速度, 2=高速, 3=超高速（実際のゲーム内時間換算は main.ts 側で行う）
  public onSpeedChanged: (speedLevel: number) => void = () => {};
  public onAudioToggled: () => void = () => {};
  public onTimeToggled: () => void = () => {};
  public onGridToggled: (visible: boolean) => void = () => {};
  public onCameraModeToggled: () => void = () => {};
  public onExitCab: () => void = () => {};
  public onSaveRequested: () => void = () => {};
  public onResetRequested: () => void = () => {};
  public onTogglePointSwitch: (x: number, z: number) => void = () => {};
  // ③ シーサスクロッシングの開通状態切替
  public onCycleCrossing: (x: number, z: number) => void = () => {};
  public onConfirmBuyTrain: (model: VehicleModelInfo, cars: 1 | 2 | 3 | 4) => void = () => {};
  // ① 列車撤去
  public onRemoveTrain: (trainId: number) => void = () => {};
  // ⑦ 仮置き中プレースメントの決定・キャンセル
  public onConfirmPlacement: () => void = () => {};
  public onCancelPlacement: () => void = () => {};
  public onRotatePlacement: () => void = () => {};
  // ④ 駅有効長セレクター変更 / インスペクターからの変更
  public onStationLengthChanged: (length: 1 | 2 | 3 | 4) => void = () => {};
  public onSetStationLength: (x: number, z: number, targetLength: number) => void = () => {};
  // ⑦ 車両基地モーダル開閉・デプロイ・回送・追跡
  public onOpenFleetModal: () => void = () => {};
  public onDeployFleetTrain: (fleetId: string) => void = () => {};
  public onRecallFleetTrain: (fleetId: string) => void = () => {};
  public onTrackFleetTrain: (fleetId: string) => void = () => {};
  // ② 分岐器の左右分岐切替
  public onToggleSwitchSide: () => void = () => {};
  // ① 駅舎ホーム左右切替
  public onToggleStationSide: () => void = () => {};
  // ② 開発テスト用: 資金無限モード切替
  public onToggleInfiniteFunds: () => void = () => {};
  // ② 駅ダイヤ変更通知（駅グループ全タイル同期用）
  public onStationScheduleChanged?: (tile: TileData, schedule: StationSchedule) => void;

  constructor() {
    this.bindEvents();
    this.buildVehicleCatalogUI();
  }

  private bindEvents() {
    // ⑤ 最上段ツール（選択・列車購入・撤去）
    this.topLevelToolBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.getAttribute('data-tool') as ActiveTool;
        this.selectTool(tool);
        this.closeSubmenu();
      });
    });

    // ④ 駅ホーム有効長セレクターボタン
    this.stationLengthBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.stationLengthBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const len = parseInt(btn.getAttribute('data-len') || '2') as 1 | 2 | 3 | 4;
        this.selectedStationLength = len;
        this.onStationLengthChanged(len);
      });
    });

    // ⑤ カテゴリーボタン → サブメニュー（多層モーダル）を開閉
    this.categoryBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const category = btn.getAttribute('data-category')!;
        if (this.activeCategoryId === category && !this.toolSubmenu.classList.contains('hidden')) {
          this.closeSubmenu();
        } else {
          this.openSubmenu(category);
        }
      });
    });

    this.closeSubmenuBtn.addEventListener('click', () => this.closeSubmenu());

    // ⑦ 設置決定・キャンセルボタン / ⑤ 回転ボタン / ② 分岐左右切替 / ① 駅ホーム左右切替
    this.confirmPlacementBtn.addEventListener('click', () => this.onConfirmPlacement());
    this.cancelPlacementBtn.addEventListener('click', () => this.onCancelPlacement());
    this.rotatePlacementBtn.addEventListener('click', () => this.onRotatePlacement());
    this.switchSideBtn.addEventListener('click', () => this.onToggleSwitchSide());
    this.stationSideBtn?.addEventListener('click', () => this.onToggleStationSide());
    this.stationSideHintBtn?.addEventListener('click', () => this.onToggleStationSide());

    // ② 開発テスト用 資金無限モード切替
    this.fundsCardBtn?.addEventListener('click', () => this.onToggleInfiniteFunds());
    this.infiniteFundsReportBtn?.addEventListener('click', () => this.onToggleInfiniteFunds());

    // Speed buttons
    const setSpeed = (speed: number, activeBtn: HTMLElement) => {
      Object.values(this.speedButtons).forEach(b => b.classList.remove('active'));
      activeBtn.classList.add('active');
      this.onSpeedChanged(speed);
    };

    this.speedButtons.pause.addEventListener('click', () => setSpeed(0, this.speedButtons.pause));
    this.speedButtons.s1.addEventListener('click', () => setSpeed(1, this.speedButtons.s1));
    this.speedButtons.s2.addEventListener('click', () => setSpeed(2, this.speedButtons.s2));
    this.speedButtons.s3.addEventListener('click', () => setSpeed(3, this.speedButtons.s3));

    // Audio
    this.audioToggleBtn.addEventListener('click', () => {
      this.onAudioToggled();
    });

    // ④ 操作ヘルプモーダル開閉
    this.guideToggleBtn?.addEventListener('click', () => {
      this.helpModal.classList.remove('hidden');
    });
    this.closeHelpBtn?.addEventListener('click', () => {
      this.helpModal.classList.add('hidden');
    });

    // ⑦ 車両管理モーダル開閉
    this.fleetToggleBtn?.addEventListener('click', () => {
      this.onOpenFleetModal();
    });
    this.fleetFromModalBtn?.addEventListener('click', () => {
      this.vehicleModal.classList.add('hidden');
      this.onOpenFleetModal();
    });
    this.closeFleetBtn?.addEventListener('click', () => {
      this.fleetModal.classList.add('hidden');
    });

    // ①② 大型ダイヤ設定モーダル開閉
    this.closeScheduleBtn?.addEventListener('click', () => {
      this.scheduleModal.classList.add('hidden');
    });

    // View controls
    this.camViewBtn.addEventListener('click', () => {
      this.onCameraModeToggled();
    });

    this.timeToggleBtn.addEventListener('click', () => {
      this.onTimeToggled();
    });

    let gridVisible = true;
    this.gridToggleBtn.addEventListener('click', () => {
      gridVisible = !gridVisible;
      this.gridToggleBtn.classList.toggle('active', gridVisible);
      this.onGridToggled(gridVisible);
    });

    // Cab Exit
    this.exitCabBtn.addEventListener('click', () => {
      this.onExitCab();
    });

    // Report modal
    this.reportBtn.addEventListener('click', () => {
      this.reportModal.classList.remove('hidden');
    });
    this.closeReportBtn.addEventListener('click', () => {
      this.reportModal.classList.add('hidden');
    });

    // Inspector
    this.closeInspectBtn.addEventListener('click', () => {
      this.inspectorPanel.classList.add('hidden');
    });

    // ⑤ & ⑦ Vehicle Modal Close & Confirm
    this.closeVehicleBtn.addEventListener('click', () => {
      this.vehicleModal.classList.add('hidden');
    });

    this.confirmBuyTrainBtn.addEventListener('click', () => {
      this.vehicleModal.classList.add('hidden');
      this.onConfirmBuyTrain(this.selectedVehicle, this.selectedCarCount);
    });

    // Car Count buttons
    const carBtns = document.querySelectorAll('.cars-btn');
    carBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        carBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const count = parseInt(btn.getAttribute('data-cars') || '3') as 1 | 2 | 3 | 4;
        this.selectedCarCount = count;
        this.updateVehiclePriceDisplay();
      });
    });

    // Save & Reset
    document.getElementById('btn-save-game')?.addEventListener('click', () => {
      this.onSaveRequested();
      alert('💾 ゲームデータを保存しました！');
    });

    document.getElementById('btn-reset-city')?.addEventListener('click', () => {
      if (confirm('本当に都市を更地に戻して初期化しますか？')) {
        this.onResetRequested();
        this.reportModal.classList.add('hidden');
      }
    });
  }

  /**
   * ⑤ カテゴリーサブメニュー（多層モーダル）を開く
   */
  private openSubmenu(categoryId: string) {
    const category = TOOL_CATEGORIES.find(c => c.id === categoryId);
    if (!category) return;

    this.activeCategoryId = categoryId;
    this.submenuTitle.textContent = `${category.icon} ${category.name}`;
    this.submenuGrid.innerHTML = '';

    category.tools.forEach(tool => {
      const config = TOOL_CONFIG[tool];
      const btn = document.createElement('button');
      btn.className = `tool-btn submenu-tool-btn ${this.activeTool === tool ? 'active' : ''}`;
      btn.innerHTML = `
        <span class="tool-icon">${config.icon}</span>
        <span class="tool-name">${config.name}</span>
        <span class="tool-cost">¥${(config.cost / 10000).toLocaleString()}万</span>
      `;
      btn.addEventListener('click', () => {
        this.selectTool(tool);
        this.closeSubmenu();
      });
      this.submenuGrid.appendChild(btn);
    });

    // ② このカテゴリー専用の撤去ボタン（該当カテゴリの物のみ削除できる）
    const demoConfig = TOOL_CONFIG[category.demolishTool];
    const demoBtn = document.createElement('button');
    demoBtn.className = `tool-btn submenu-tool-btn delete-tool ${this.activeTool === category.demolishTool ? 'active' : ''}`;
    demoBtn.innerHTML = `
      <span class="tool-icon">${demoConfig.icon}</span>
      <span class="tool-name">${demoConfig.name}</span>
      <span class="tool-cost">${demoConfig.cost > 0 ? '¥' + (demoConfig.cost / 10000).toLocaleString() + '万' : '無料'}</span>
    `;
    demoBtn.addEventListener('click', () => {
      this.selectTool(category.demolishTool);
      this.closeSubmenu();
    });
    this.submenuGrid.appendChild(demoBtn);

    // ⑥ 列車カテゴリの場合は「車両基地・保有管理」ボタンも配置
    if (categoryId === 'train') {
      const fleetBtn = document.createElement('button');
      fleetBtn.className = 'tool-btn submenu-tool-btn fleet-btn';
      fleetBtn.innerHTML = `
        <span class="tool-icon">🚆</span>
        <span class="tool-name">保有車両・基地管理</span>
        <span class="tool-cost">一覧</span>
      `;
      fleetBtn.addEventListener('click', () => {
        this.closeSubmenu();
        this.onOpenFleetModal();
      });
      this.submenuGrid.appendChild(fleetBtn);
    }

    this.toolSubmenu.classList.remove('hidden');
    this.categoryBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-category') === categoryId));

    // ③ サブメニューが開いている間は、ヒントやセレクターを一時非表示にしてボタンの操作性を確保
    this.rotationHint.classList.add('hidden');
    this.stationLengthSelector.classList.add('hidden');
  }

  private closeSubmenu() {
    this.toolSubmenu.classList.add('hidden');
    // サブメニューを閉じた後、選択中のツールに応じてセレクターを再表示
    const isStationTool = (this.activeTool === 'station-small' || this.activeTool === 'station-elevated');
    this.stationLengthSelector.classList.toggle('hidden', !isStationTool);
  }

  /**
   * ツール選択の共通処理（最上段ボタン／サブメニュー双方から呼ばれる）
   */
  private selectTool(tool: ActiveTool) {
    this.activeTool = tool;

    // 最上段ボタンのハイライト更新
    this.topLevelToolBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-tool') === tool));

    // カテゴリーボタンのハイライト（選択中ツールが属するカテゴリー、またはそのカテゴリの撤去ツールであれば強調）
    const ownerCategory = TOOL_CATEGORIES.find(c => c.tools.includes(tool) || c.demolishTool === tool);
    this.categoryBtns.forEach(b => b.classList.toggle('active', ownerCategory?.id === b.getAttribute('data-category')));

    // ④ 駅ツールの場合はホーム有効長セレクターを表示
    const isStationTool = (tool === 'station-small' || tool === 'station-elevated');
    this.stationLengthSelector.classList.toggle('hidden', !isStationTool);

    this.onToolChanged(tool);
  }

  /**
   * ⑤ 車両カタログUIの生成
   */
  private buildVehicleCatalogUI() {
    this.vehicleGrid.innerHTML = '';

    VEHICLE_CATALOG.forEach(veh => {
      const card = document.createElement('div');
      card.className = `veh-item-card ${veh.id === this.selectedVehicle.id ? 'selected' : ''}`;

      const stripeHex = '#' + veh.stripeColor.toString(16).padStart(6, '0');

      card.innerHTML = `
        <div class="veh-stripe-bar" style="background: ${stripeHex}"></div>
        <div class="veh-name">${veh.name}</div>
        <div class="veh-specs">
          <span>最高速度: ${veh.maxSpeed} km/h</span>
          <span>1両定員: ${veh.baseCapacity}名</span>
        </div>
        <div class="veh-price">¥${(veh.basePrice / 10000).toLocaleString()}万/両</div>
      `;

      card.addEventListener('click', () => {
        document.querySelectorAll('.veh-item-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedVehicle = veh;
        this.updateVehiclePriceDisplay();
      });

      this.vehicleGrid.appendChild(card);
    });

    this.updateVehiclePriceDisplay();
  }

  private updateVehiclePriceDisplay() {
    const total = this.selectedVehicle.basePrice * this.selectedCarCount;
    this.vehTotalPrice.textContent = '¥' + total.toLocaleString();
  }

  public openVehicleModal() {
    this.vehicleModal.classList.remove('hidden');
  }

  public getActiveTool(): ActiveTool {
    return this.activeTool;
  }

  public setAudioMuted(isMuted: boolean) {
    this.audioToggleBtn.textContent = isMuted ? '🔇' : '🔊';
  }

  public setTimeDisplay(time: 'day' | 'sunset' | 'night') {
    if (time === 'day') {
      this.timeIcon.textContent = '☀️';
      if (this.timeText) this.timeText.textContent = '昼間';
    } else if (time === 'sunset') {
      this.timeIcon.textContent = '🌅';
      if (this.timeText) this.timeText.textContent = '夕暮れ';
    } else {
      this.timeIcon.textContent = '🌙';
      if (this.timeText) this.timeText.textContent = '夜景';
    }
  }

  public updateHUD(dateStr: string, timeStr: string, fundsStr: string, popStr: string) {
    this.dateDisplay.textContent = dateStr;
    this.clockDisplay.textContent = timeStr;
    this.fundsDisplay.textContent = fundsStr;
    this.popDisplay.textContent = popStr;
  }

  public getSelectedStationLength(): 1 | 2 | 3 | 4 {
    return this.selectedStationLength;
  }

  /**
   * ⑧ 現在選択中のツールの回転バーを表示/更新する
   */
  public setRotationHint(visible: boolean, label: string = '') {
    this.rotationHint.classList.toggle('hidden', !visible);
    if (visible) {
      this.rotationValueEl.textContent = label;
    }
  }

  /**
   * ② 分岐器の左右分岐切替ボタンの表示・テキスト更新
   */
  public setSwitchSideButtonVisible(visible: boolean, side: 'left' | 'right' = 'right') {
    this.switchSideBtn.classList.toggle('hidden', !visible);
    this.switchSideBtn.textContent = side === 'left' ? '🔀 分岐: 左' : '🔀 分岐: 右';
  }

  /**
   * ① 駅ホーム左右切替ボタンの表示・テキスト更新
   */
  public setStationSideButtonsVisible(visible: boolean, side: 'left' | 'right' = 'right') {
    const text = side === 'left' ? '🏢 ホーム: 左側' : '🏢 ホーム: 右側';
    if (this.stationSideBtn) {
      this.stationSideBtn.textContent = text;
    }
    if (this.stationSideHintBtn) {
      this.stationSideHintBtn.classList.toggle('hidden', !visible);
      this.stationSideHintBtn.textContent = text;
    }
  }

  /**
   * ② 開発テスト用: 資金無限モードのUI表示更新
   */
  public updateInfiniteFundsUI(isInfinite: boolean) {
    this.fundsCardBtn?.classList.toggle('infinite-funds', isInfinite);
    if (this.infiniteFundsReportBtn) {
      this.infiniteFundsReportBtn.textContent = isInfinite ? '💰 資金無限: ON (Mキー)' : '💰 資金無限モード切替 (Mキー)';
      this.infiniteFundsReportBtn.classList.toggle('active', isInfinite);
    }
  }

  /**
   * ⑦ 車両基地・保有列車管理モーダルの表示・一覧レンダリング
   */
  public showFleetModal(fleet: FleetItem[]) {
    this.fleetList.innerHTML = '';
    if (fleet.length === 0) {
      this.fleetList.innerHTML = `
        <div class="fleet-empty-hint">
          保有している列車はありません。<br>
          下部メニューの「列車」→「車両購入」から列車を購入すると、ここに配属されます。
        </div>
      `;
    } else {
      fleet.forEach(item => {
        const card = document.createElement('div');
        card.className = 'fleet-item-card';

        const isDeployed = item.status === 'deployed';
        const badgeClass = isDeployed ? 'deployed' : 'in-depot';
        const badgeText = isDeployed ? '🟢 営業運行中' : '⚪ 車庫待機中';

        card.innerHTML = `
          <div class="fleet-item-info">
            <div class="fleet-item-header">
              <span class="fleet-item-name">${item.name}</span>
              <span class="fleet-badge ${badgeClass}">${badgeText}</span>
            </div>
            <div class="fleet-item-stats">
              <span>形式: ${item.model.name}</span>
              <span>両数: ${item.cars}両編成</span>
              <span>最高速度: ${item.model.maxSpeed}km/h</span>
              <span>運賃: ¥${item.model.farePerRide}</span>
              <span>運行費: ¥${(item.model.dailyRunningCostPerCar * item.cars).toLocaleString()}/日</span>
            </div>
          </div>
          <div class="fleet-item-actions">
            ${isDeployed ? `
              <button class="fleet-btn-track" data-id="${item.id}">📍 追跡</button>
              <button class="fleet-btn-recall" data-id="${item.id}">📥 車庫へ回送</button>
            ` : `
              <button class="fleet-btn-deploy" data-id="${item.id}">🚀 線路に配置する</button>
            `}
          </div>
        `;

        const deployBtn = card.querySelector('.fleet-btn-deploy');
        deployBtn?.addEventListener('click', () => {
          this.fleetModal.classList.add('hidden');
          this.onDeployFleetTrain(item.id);
        });

        const recallBtn = card.querySelector('.fleet-btn-recall');
        recallBtn?.addEventListener('click', () => {
          this.onRecallFleetTrain(item.id);
        });

        const trackBtn = card.querySelector('.fleet-btn-track');
        trackBtn?.addEventListener('click', () => {
          this.fleetModal.classList.add('hidden');
          this.onTrackFleetTrain(item.id);
        });

        this.fleetList.appendChild(card);
      });
    }

    this.fleetModal.classList.remove('hidden');
  }

  public closeFleetModal() {
    this.fleetModal.classList.add('hidden');
  }

  /**
   * ⑦ 仮置き中のみ「設置を決定」「キャンセル」ボタンを表示する
   */
  public setPlacementButtonsVisible(visible: boolean) {
    this.confirmPlacementBtn.classList.toggle('hidden', !visible);
    this.cancelPlacementBtn.classList.toggle('hidden', !visible);
  }

  public setCameraModeUI(mode: CameraMode) {
    if (mode === 'cab') {
      this.cabOverlay.classList.remove('hidden');
      if (this.camViewText) this.camViewText.textContent = '前面展望';
      this.camViewBtn.classList.add('active');
    } else {
      this.cabOverlay.classList.add('hidden');
      if (this.camViewText) this.camViewText.textContent = '自由視点';
      this.camViewBtn.classList.remove('active');
    }
  }

  public updateCabSpeed(speed: number) {
    this.cabSpeedVal.textContent = String(Math.round(speed));
  }

  /**
   * ② ポイント切り替えボタン・④ 駅有効長設定・⑤ 詳細収支を含むインスペクター表示
   */
  public showInspector(
    tile: TileData,
    switchHub?: TileData,
    stationRunLength?: number,
    stationData?: {
      name: string;
      length: number;
      dailyPassengers: number;
      totalPassengers: number;
      totalRevenue: number;
      maintenance: number;
      netProfit: number;
    } | null
  ) {
    this.inspectorPanel.classList.remove('hidden');
    this.inspectCoords.textContent = `(${tile.x}, ${tile.z})`;

    const typeNames: Record<TileType, string> = {
      empty: '更地',
      rail_ground: '線路 (地上)',
      rail_elevated: '高架線路',
      rail_curve_ground: '曲線レール (地上)',
      rail_curve_elevated: '曲線レール (高架)',
      point_switch_ground: '分岐器・ポイント (地上)',
      point_switch_elevated: '分岐器・ポイント (高架)',
      scissors_crossing_ground: 'シーサスクロッシング (地上・2×2)',
      scissors_crossing_elevated: 'シーサスクロッシング (高架・2×2)',
      rail_slope: '勾配線路 (スロープ)',
      station_ground: '駅舎 (地上)',
      station_elevated: '高架駅',
      road: '道路',
      level_crossing: '踏切',
      residence: `住宅区画 (Lv.${tile.level})`,
      commercial: `商業オフィスビル (Lv.${tile.level})`,
      nature: '森林・緑地'
    };
    this.inspectType.textContent = typeNames[tile.type] || tile.type;
    this.inspectActions.innerHTML = '';
    this.inspectFinancialBox.classList.add('hidden');
    this.inspectFinancialBox.innerHTML = '';

    if (switchHub) {
      const isStraight = (switchHub.switchState !== 'diverge');
      const switchSched = switchHub.switchSchedule || { mode: 'timeline' };
      this.inspectExtraVal.textContent = `開通: ${isStraight ? '【直進】' : '【分岐】'} (動作: ${
        switchSched.mode === 'timeline' ? 'タイムライン指定' :
        switchSched.mode === 'alternate' ? '交互切替' : '手動'
      })`;

      const switchBtn = document.createElement('button');
      switchBtn.className = 'switch-toggle-btn';
      switchBtn.textContent = `🔀 手動進路切替: ${isStraight ? '分岐方向へ開通' : '直進方向へ開通'}`;
      switchBtn.addEventListener('click', () => {
        if (!switchHub.switchSchedule) switchHub.switchSchedule = createDefaultSwitchSchedule();
        // ③ 手動で切り替えた時はモードを manual にし、列車通過時に勝手に straight へ戻されないようにする
        switchHub.switchSchedule.mode = 'manual';
        this.onTogglePointSwitch(switchHub.x, switchHub.z);
      });
      this.inspectActions.appendChild(switchBtn);

      // ①② 大型ダイヤ設定モーダルを開くボタン
      const openSchedBtn = document.createElement('button');
      openSchedBtn.className = 'sched-modal-open-btn';
      openSchedBtn.innerHTML = '<span>⏱️ 分岐ダイヤ設定を開く（10分刻み）</span>';
      openSchedBtn.addEventListener('click', () => {
        this.openScheduleModal(tile, switchHub, stationData);
      });
      this.inspectActions.appendChild(openSchedBtn);

      // ① 分岐器 24時間タイムラインバー簡易表示
      this.renderSwitchScheduleUI(this.inspectActions, tile, switchHub, stationRunLength, stationData);

    } else if (tile.type.startsWith('scissors_crossing')) {
      const stateLabel: Record<string, string> = {
        straight: '【複線・直進】', 'cross-a': '【交差A（片方向）】', 'cross-b': '【交差B（もう片方向）】'
      };
      this.inspectExtraVal.textContent = `開通状態: ${stateLabel[tile.crossingState ?? 'straight']}`;

      const crossBtn = document.createElement('button');
      crossBtn.className = 'switch-toggle-btn';
      crossBtn.textContent = '✖️ 開通状態を切替（直進→交差A→交差B）';
      crossBtn.addEventListener('click', () => {
        this.onCycleCrossing(tile.x, tile.z);
      });
      this.inspectActions.appendChild(crossBtn);
    } else if (tile.type.startsWith('station')) {
      const runLen = stationRunLength ?? (stationData ? stationData.length : 1);
      const stName = stationData?.name || tile.stationName || '駅';
      this.inspectType.textContent = `${typeNames[tile.type]} - ${stName}`;
      this.inspectExtraVal.textContent = `待機乗客: ${tile.stationPassengers}人 / 有効長: ${runLen}両`;

      // ⑤ 駅 財務・収支・利用状況ボックスの表示
      if (stationData) {
        this.inspectFinancialBox.classList.remove('hidden');
        const profitSign = stationData.netProfit >= 0 ? '+' : '';
        const profitClass = stationData.netProfit >= 0 ? 'positive' : 'negative';
        this.inspectFinancialBox.innerHTML = `
          <div class="fin-title">🚉 駅 財務・利用状況</div>
          <div class="fin-row"><span class="fin-label">本日乗降客:</span><span class="fin-val">${stationData.dailyPassengers.toLocaleString()}人</span></div>
          <div class="fin-row"><span class="fin-label">累計乗降客:</span><span class="fin-val">${stationData.totalPassengers.toLocaleString()}人</span></div>
          <div class="fin-row"><span class="fin-label">累計運賃収入:</span><span class="fin-val positive">+¥${stationData.totalRevenue.toLocaleString()}</span></div>
          <div class="fin-row"><span class="fin-label">月額維持管理費:</span><span class="fin-val negative">-¥${stationData.maintenance.toLocaleString()}</span></div>
          <div class="fin-row"><span class="fin-label">駅純収支:</span><span class="fin-val ${profitClass}">${profitSign}¥${stationData.netProfit.toLocaleString()}</span></div>
        `;
      }

      // ④ ホーム有効長変更ボタン群（1両〜4両）
      const editBox = document.createElement('div');
      editBox.className = 'st-edit-len-box';
      editBox.innerHTML = `
        <span class="st-edit-len-label">有効長変更:</span>
        <div class="st-edit-len-btns">
          <button class="st-edit-btn ${runLen === 1 ? 'active' : ''}" data-target-len="1">1両</button>
          <button class="st-edit-btn ${runLen === 2 ? 'active' : ''}" data-target-len="2">2両</button>
          <button class="st-edit-btn ${runLen === 3 ? 'active' : ''}" data-target-len="3">3両</button>
          <button class="st-edit-btn ${runLen === 4 ? 'active' : ''}" data-target-len="4">4両</button>
        </div>
      `;
      editBox.querySelectorAll<HTMLElement>('.st-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const targetLen = parseInt(btn.getAttribute('data-target-len') || '2');
          this.onSetStationLength(tile.x, tile.z, targetLen);
        });
      });
      this.inspectActions.appendChild(editBox);

      // ①② 大型ダイヤ設定モーダルを開くボタン
      const openSchedBtn = document.createElement('button');
      openSchedBtn.className = 'sched-modal-open-btn';
      openSchedBtn.innerHTML = '<span>⏱️ 駅ダイヤ設定を開く（10分刻み）</span>';
      openSchedBtn.addEventListener('click', () => {
        this.openScheduleModal(tile, switchHub, stationData);
      });
      this.inspectActions.appendChild(openSchedBtn);

      // ① 駅 24時間タイムラインバー簡易表示
      this.renderStationScheduleUI(this.inspectActions, tile, switchHub, stationRunLength, stationData);

    } else if (tile.type === 'level_crossing') {
      this.inspectExtraVal.textContent = '道路と線路が交差する踏切です。';
    } else if (tile.type === 'residence' || tile.type === 'commercial') {
      this.inspectExtraVal.textContent = `地価: ¥${(tile.landValue * 10000).toLocaleString()}`;
    } else {
      this.inspectExtraVal.textContent = '良好';
    }
  }

  /**
   * ① ⑤ 列車（編成）詳細情報・収支・撤去インスペクター表示
   */
  public showTrainInspector(train: TrainInstance) {
    this.inspectorPanel.classList.remove('hidden');
    this.inspectCoords.textContent = `編成 #${train.id}`;
    this.inspectType.textContent = train.name;
    const occupancy = Math.round((train.passengers / Math.max(1, train.capacity)) * 100);
    this.inspectExtraVal.textContent = `${train.carCount}両編成 / 乗客 ${train.passengers}人 (乗車率 ${occupancy}%)`;

    // ⑤ 列車財務・収支ボックス
    this.inspectFinancialBox.classList.remove('hidden');
    const profitSign = train.monthlyProfit >= 0 ? '+' : '';
    const profitClass = train.monthlyProfit >= 0 ? 'positive' : 'negative';
    this.inspectFinancialBox.innerHTML = `
      <div class="fin-title">🚆 列車 財務・運行状況</div>
      <div class="fin-row"><span class="fin-label">現在乗客 / 定員:</span><span class="fin-val">${train.passengers} / ${train.capacity}人 (${occupancy}%)</span></div>
      <div class="fin-row"><span class="fin-label">累計乗客数:</span><span class="fin-val">${train.totalPassengers.toLocaleString()}人</span></div>
      <div class="fin-row"><span class="fin-label">累計運賃収入:</span><span class="fin-val positive">+¥${train.totalRevenue.toLocaleString()}</span></div>
      <div class="fin-row"><span class="fin-label">累計運行維持費:</span><span class="fin-val negative">-¥${train.totalCost.toLocaleString()}</span></div>
      <div class="fin-row"><span class="fin-label">列車純収支:</span><span class="fin-val ${profitClass}">${profitSign}¥${train.monthlyProfit.toLocaleString()}</span></div>
    `;

    this.inspectActions.innerHTML = '';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'switch-toggle-btn train-remove-btn';
    removeBtn.textContent = '🚮 この列車を撤去';
    removeBtn.addEventListener('click', () => {
      this.onRemoveTrain(train.id);
      this.inspectorPanel.classList.add('hidden');
    });
    this.inspectActions.appendChild(removeBtn);
  }

  public updateFinancialReport(rep: FinancialReportData) {
    document.getElementById('rep-fare-income')!.textContent = '¥' + rep.fareIncome.toLocaleString();
    document.getElementById('rep-land-value')!.textContent = '¥' + rep.landValue.toLocaleString();
    document.getElementById('rep-construction-cost')!.textContent = '-¥' + rep.constructionCost.toLocaleString();
    document.getElementById('rep-maintenance-cost')!.textContent = '-¥' + rep.maintenanceCost.toLocaleString();

    const netElem = document.getElementById('rep-net-profit')!;
    netElem.textContent = (rep.netProfit >= 0 ? '+' : '') + '¥' + rep.netProfit.toLocaleString();
    netElem.className = rep.netProfit >= 0 ? 'positive' : 'negative';

    document.getElementById('rep-total-pop')!.textContent = rep.totalPopulation.toLocaleString() + '人';
    document.getElementById('rep-track-length')!.textContent = rep.trackLength + ' km';
    document.getElementById('rep-train-count')!.textContent = rep.trainCount + ' 編成';
    document.getElementById('rep-station-count')!.textContent = rep.stationCount + ' 駅';
  }

  /**
   * ① 分岐器用 24時間タイムラインバー方式ダイヤ設定UIの描画
   */
  private renderSwitchScheduleUI(
    container: HTMLElement,
    tile: TileData,
    switchHub: TileData,
    stationRunLength?: number,
    stationData?: any
  ) {
    if (!switchHub.switchSchedule) {
      switchHub.switchSchedule = createDefaultSwitchSchedule();
    }
    const sched = switchHub.switchSchedule;
    if (!Array.isArray(sched.hourlyDirections) || sched.hourlyDirections.length !== 24) {
      sched.hourlyDirections = new Array(24).fill('straight');
    }

    const swSchedBox = document.createElement('div');
    swSchedBox.className = 'schedule-box';

    const currentHour = this.getCurrentHour ? this.getCurrentHour() : 0;

    swSchedBox.innerHTML = `
      <div class="schedule-title">⏱️ 分岐ダイヤ設定（タイムライン指定）</div>
      <div class="schedule-row">
        <span class="schedule-label">動作モード:</span>
        <div class="schedule-btn-group" id="sw-mode-btns">
          <button class="schedule-btn ${sched.mode === 'timeline' ? 'active' : ''}" data-mode="timeline">📅 タイムライン</button>
          <button class="schedule-btn ${sched.mode === 'alternate' ? 'active' : ''}" data-mode="alternate">🔄 交互切替</button>
          <button class="schedule-btn ${sched.mode === 'manual' ? 'active' : ''}" data-mode="manual">🎛️ 手動</button>
        </div>
      </div>
    `;

    // 動作モード切替イベント
    swSchedBox.querySelectorAll<HTMLElement>('#sw-mode-btns .schedule-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode') as 'timeline' | 'alternate' | 'manual';
        sched.mode = mode;
        this.showInspector(tile, switchHub, stationRunLength, stationData);
      });
    });

    if (sched.mode === 'timeline') {
      const timelineContainer = document.createElement('div');
      timelineContainer.className = 'timeline-bar-container';

      timelineContainer.innerHTML = `
        <div class="timeline-bar-header">
          <span>24時間開通指定（ドラッグで塗り分け）</span>
          <span>現在: ${currentHour}時</span>
        </div>
        <div class="timeline-palette">
          <span style="font-size:10px;color:#94a3b8;">ペン:</span>
          <button class="palette-btn ${this.switchPaletteDir === 'straight' ? 'active' : ''}" data-dir="straight">
            <span class="palette-dot straight"></span>直進
          </button>
          <button class="palette-btn ${this.switchPaletteDir === 'diverge' ? 'active' : ''}" data-dir="diverge">
            <span class="palette-dot diverge"></span>分岐
          </button>
        </div>
        <div class="timeline-cells-wrapper" id="switch-timeline-cells"></div>
        <div class="timeline-presets">
          <button class="preset-btn" data-preset="all-straight">全日直進</button>
          <button class="preset-btn" data-preset="all-diverge">全日分岐</button>
          <button class="preset-btn" data-preset="rush-diverge">朝夕分岐(7-9,17-19)</button>
          <button class="preset-btn" data-preset="day-night">昼直進/夜分岐</button>
          <button class="preset-btn" data-preset="alternating">1h毎交互</button>
        </div>
      `;

      // パレット選択
      timelineContainer.querySelectorAll<HTMLElement>('.palette-btn').forEach(pBtn => {
        pBtn.addEventListener('click', () => {
          this.switchPaletteDir = pBtn.getAttribute('data-dir') as 'straight' | 'diverge';
          timelineContainer.querySelectorAll<HTMLElement>('.palette-btn').forEach(b => b.classList.remove('active'));
          pBtn.classList.add('active');
        });
      });

      // 24時間セル生成
      const cellsWrapper = timelineContainer.querySelector<HTMLElement>('#switch-timeline-cells')!;
      let isDragging = false;

      const updateCell = (h: number, cellEl: HTMLElement) => {
        sched.hourlyDirections[h] = this.switchPaletteDir;
        cellEl.className = `timeline-cell dir-${this.switchPaletteDir} ${h === currentHour ? 'current-hour' : ''}`;
        cellEl.title = `${h}時: ${this.switchPaletteDir === 'straight' ? '直進' : '分岐'}`;
      };

      for (let h = 0; h < 24; h++) {
        const dir = sched.hourlyDirections[h] || 'straight';
        const cell = document.createElement('div');
        cell.className = `timeline-cell dir-${dir} ${h === currentHour ? 'current-hour' : ''}`;
        cell.textContent = `${h}`;
        cell.title = `${h}時: ${dir === 'straight' ? '直進' : '分岐'}`;

        cell.addEventListener('mousedown', (e) => {
          e.preventDefault();
          isDragging = true;
          updateCell(h, cell);
        });

        cell.addEventListener('mouseenter', () => {
          if (isDragging) {
            updateCell(h, cell);
          }
        });

        cellsWrapper.appendChild(cell);
      }

      window.addEventListener('mouseup', () => {
        isDragging = false;
      });

      // プリセット
      timelineContainer.querySelectorAll<HTMLElement>('.preset-btn').forEach(presetBtn => {
        presetBtn.addEventListener('click', () => {
          const type = presetBtn.getAttribute('data-preset');
          if (type === 'all-straight') {
            sched.hourlyDirections.fill('straight');
          } else if (type === 'all-diverge') {
            sched.hourlyDirections.fill('diverge');
          } else if (type === 'rush-diverge') {
            sched.hourlyDirections.fill('straight');
            [7, 8, 9, 17, 18, 19].forEach(h => sched.hourlyDirections[h] = 'diverge');
          } else if (type === 'day-night') {
            for (let h = 0; h < 24; h++) {
              sched.hourlyDirections[h] = (h >= 6 && h < 18) ? 'straight' : 'diverge';
            }
          } else if (type === 'alternating') {
            for (let h = 0; h < 24; h++) {
              sched.hourlyDirections[h] = (h % 2 === 0) ? 'straight' : 'diverge';
            }
          }
          this.showInspector(tile, switchHub, stationRunLength, stationData);
        });
      });

      swSchedBox.appendChild(timelineContainer);
    } else if (sched.mode === 'alternate') {
      const info = document.createElement('div');
      info.style.cssText = 'font-size:10.5px;color:#94a3b8;margin-top:4px;';
      info.textContent = '※ 列車が通過するたびに直進と分岐を自動で交互に切り替えます。';
      swSchedBox.appendChild(info);
    } else {
      const info = document.createElement('div');
      info.style.cssText = 'font-size:10.5px;color:#94a3b8;margin-top:4px;';
      info.textContent = '※ 上の手動進路切替ボタンからのみ開通方向を切り替えます。';
      swSchedBox.appendChild(info);
    }

    container.appendChild(swSchedBox);
  }

  /**
   * ① 駅用 24時間タイムラインバー方式ダイヤ設定UIの描画
   */
  private renderStationScheduleUI(
    container: HTMLElement,
    tile: TileData,
    switchHub?: TileData,
    stationRunLength?: number,
    stationData?: any
  ) {
    if (!tile.stationSchedule) {
      tile.stationSchedule = createDefaultStationSchedule();
    }
    const sched = tile.stationSchedule;
    if (!Array.isArray(sched.hourlyModes) || sched.hourlyModes.length !== 24) {
      sched.hourlyModes = new Array(24).fill('stop');
    }

    const currentHour = this.getCurrentHour ? this.getCurrentHour() : 0;

    const stSchedBox = document.createElement('div');
    stSchedBox.className = 'schedule-box';

    stSchedBox.innerHTML = `
      <div class="schedule-title">⏱️ 駅ダイヤ設定（タイムライン指定）</div>
      <div class="timeline-bar-container">
        <div class="timeline-bar-header">
          <span>24時間動作指定（ドラッグで塗り分け）</span>
          <span>現在: ${currentHour}時</span>
        </div>
        <div class="timeline-palette">
          <span style="font-size:10px;color:#94a3b8;">ペン:</span>
          <button class="palette-btn ${this.stationPaletteMode === 'stop' ? 'active' : ''}" data-mode="stop">
            <span class="palette-dot stop"></span>停車
          </button>
          <button class="palette-btn ${this.stationPaletteMode === 'wait' ? 'active' : ''}" data-mode="wait">
            <span class="palette-dot wait"></span>待避
          </button>
          <button class="palette-btn ${this.stationPaletteMode === 'pass' ? 'active' : ''}" data-mode="pass">
            <span class="palette-dot pass"></span>通過
          </button>
          <button class="palette-btn ${this.stationPaletteMode === 'reverse' ? 'active' : ''}" data-mode="reverse">
            <span class="palette-dot reverse"></span>折返
          </button>
        </div>
        <div class="timeline-cells-wrapper" id="station-timeline-cells"></div>
        <div class="timeline-presets">
          <button class="preset-btn" data-preset="all-stop">全日停車</button>
          <button class="preset-btn" data-preset="all-pass">全日通過</button>
          <button class="preset-btn" data-preset="rush-wait">朝夕待避(7-9,17-19)</button>
          <button class="preset-btn" data-preset="night-pass">夜間通過(23-5)</button>
          <button class="preset-btn" data-preset="all-reverse">終点折返</button>
        </div>
      </div>
      <div class="schedule-row" style="margin-top: 4px;">
        <span class="schedule-label">定時発車:</span>
        <div class="schedule-btn-group" id="st-dep-btns">
          <button class="schedule-btn ${sched.departureMinute === undefined ? 'active' : ''}" data-dep="none">なし</button>
          <button class="schedule-btn ${sched.departureMinute === 0 ? 'active' : ''}" data-dep="0">毎時00分</button>
          <button class="schedule-btn ${sched.departureMinute === 15 ? 'active' : ''}" data-dep="15">毎時15分</button>
          <button class="schedule-btn ${sched.departureMinute === 30 ? 'active' : ''}" data-dep="30">毎時30分</button>
          <button class="schedule-btn ${sched.departureMinute === 45 ? 'active' : ''}" data-dep="45">毎時45分</button>
        </div>
      </div>
    `;

    // パレット選択
    stSchedBox.querySelectorAll<HTMLElement>('.palette-btn').forEach(pBtn => {
      pBtn.addEventListener('click', () => {
        this.stationPaletteMode = pBtn.getAttribute('data-mode') as StationActionMode;
        stSchedBox.querySelectorAll<HTMLElement>('.palette-btn').forEach(b => b.classList.remove('active'));
        pBtn.classList.add('active');
      });
    });

    // 24時間セル生成
    const cellsWrapper = stSchedBox.querySelector<HTMLElement>('#station-timeline-cells')!;
    let isDragging = false;

    const modeNames: Record<StationActionMode, string> = {
      stop: '停車', wait: '待避', pass: '通過', reverse: '折返'
    };

    if (!Array.isArray(sched.slots) || sched.slots.length !== 144) {
      sched.slots = new Array(144).fill('stop');
      for (let h = 0; h < 24; h++) {
        const m = sched.hourlyModes[h] || 'stop';
        for (let s = 0; s < 6; s++) sched.slots[h * 6 + s] = m;
      }
    }

    const updateCell = (h: number, cellEl: HTMLElement) => {
      sched.hourlyModes[h] = this.stationPaletteMode;
      for (let s = 0; s < 6; s++) {
        sched.slots![h * 6 + s] = this.stationPaletteMode;
      }
      cellEl.className = `timeline-cell mode-${this.stationPaletteMode} ${h === currentHour ? 'current-hour' : ''}`;
      cellEl.title = `${h}時: ${modeNames[this.stationPaletteMode] || this.stationPaletteMode}`;
      if (this.onStationScheduleChanged) {
        this.onStationScheduleChanged(tile, sched);
      }
    };

    for (let h = 0; h < 24; h++) {
      const mode = sched.hourlyModes[h] || 'stop';
      const cell = document.createElement('div');
      cell.className = `timeline-cell mode-${mode} ${h === currentHour ? 'current-hour' : ''}`;
      cell.textContent = `${h}`;
      cell.title = `${h}時: ${modeNames[mode] || mode}`;

      cell.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isDragging = true;
        updateCell(h, cell);
      });

      cell.addEventListener('mouseenter', () => {
        if (isDragging) {
          updateCell(h, cell);
        }
      });

      cellsWrapper.appendChild(cell);
    }

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });

    // プリセット
    stSchedBox.querySelectorAll<HTMLElement>('.preset-btn').forEach(presetBtn => {
      presetBtn.addEventListener('click', () => {
        const type = presetBtn.getAttribute('data-preset');
        if (type === 'all-stop') {
          sched.hourlyModes.fill('stop');
          sched.slots!.fill('stop');
        } else if (type === 'all-pass') {
          sched.hourlyModes.fill('pass');
          sched.slots!.fill('pass');
        } else if (type === 'rush-wait') {
          sched.hourlyModes.fill('stop');
          sched.slots!.fill('stop');
          [7, 8, 9, 17, 18, 19].forEach(h => {
            sched.hourlyModes[h] = 'wait';
            for (let s = 0; s < 6; s++) sched.slots![h * 6 + s] = 'wait';
          });
        } else if (type === 'night-pass') {
          sched.hourlyModes.fill('stop');
          sched.slots!.fill('stop');
          [23, 0, 1, 2, 3, 4, 5].forEach(h => {
            sched.hourlyModes[h] = 'pass';
            for (let s = 0; s < 6; s++) sched.slots![h * 6 + s] = 'pass';
          });
        } else if (type === 'all-reverse') {
          sched.hourlyModes.fill('reverse');
          sched.slots!.fill('reverse');
        }
        if (this.onStationScheduleChanged) {
          this.onStationScheduleChanged(tile, sched);
        }
        this.showInspector(tile, switchHub, stationRunLength, stationData);
      });
    });

    // 定時発車
    stSchedBox.querySelectorAll<HTMLElement>('#st-dep-btns .schedule-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const dep = btn.getAttribute('data-dep');
        sched.departureMinute = (dep === 'none' ? undefined : parseInt(dep || '0'));
        if (this.onStationScheduleChanged) {
          this.onStationScheduleChanged(tile, sched);
        }
        this.showInspector(tile, switchHub, stationRunLength, stationData);
      });
    });

    container.appendChild(stSchedBox);
  }

  /**
   * ①② 大型ダイヤ設定モーダルを開く
   */
  public openScheduleModal(
    tile: TileData,
    switchHub?: TileData,
    stationData?: any
  ) {
    this.currentEditingTile = tile;
    this.currentEditingSwitchHub = switchHub || null;
    this.currentEditingStationData = stationData || null;

    const currentHour = this.getCurrentHour ? this.getCurrentHour() : 8;
    this.selectedScheduleHour = currentHour;

    this.scheduleModal.classList.remove('hidden');
    this.renderScheduleModalContent();
  }

  /**
   * ①② 大型ダイヤ設定モーダルのコンテンツを描画
   */
  private renderScheduleModalContent() {
    if (!this.currentEditingTile) return;

    const currentHour = this.getCurrentHour ? this.getCurrentHour() : 0;
    const currentMinute = this.getCurrentMinute ? this.getCurrentMinute() : 0;
    const currentSlotMinute = Math.floor(currentMinute / 10) * 10;

    const container = this.scheduleModalBody;
    container.innerHTML = '';

    if (this.currentEditingSwitchHub) {
      // -------------------------------------------------------------
      // 分岐器ダイヤ設定（10分刻み）
      // -------------------------------------------------------------
      const hub = this.currentEditingSwitchHub;
      if (!hub.switchSchedule) {
        hub.switchSchedule = createDefaultSwitchSchedule();
      }
      const sched = hub.switchSchedule;
      if (!Array.isArray(sched.slots) || sched.slots.length !== 144) {
        sched.slots = new Array(144).fill('straight');
      }

      this.scheduleModalTitle.textContent = `🔀 分岐ダイヤ設定（10分刻み） - 座標 (${hub.x}, ${hub.z})`;

      const modeRow = document.createElement('div');
      modeRow.className = 'schedule-row';
      modeRow.innerHTML = `
        <span class="schedule-label" style="font-size:12px;font-weight:700;">動作モード:</span>
        <div class="schedule-btn-group" id="modal-sw-mode-btns">
          <button class="schedule-btn ${sched.mode === 'timeline' ? 'active' : ''}" data-mode="timeline">📅 タイムライン (10分単位指定)</button>
          <button class="schedule-btn ${sched.mode === 'alternate' ? 'active' : ''}" data-mode="alternate">🔄 交互切替 (通過毎反転)</button>
          <button class="schedule-btn ${sched.mode === 'manual' ? 'active' : ''}" data-mode="manual">🎛️ 手動開通</button>
        </div>
      `;
      modeRow.querySelectorAll<HTMLElement>('#modal-sw-mode-btns .schedule-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          sched.mode = btn.getAttribute('data-mode') as 'timeline' | 'alternate' | 'manual';
          this.renderScheduleModalContent();
        });
      });
      container.appendChild(modeRow);

      if (sched.mode === 'timeline') {
        // パレット ＆ 現在時刻
        const paletteBox = document.createElement('div');
        paletteBox.className = 'sched-modal-palette-box';
        paletteBox.innerHTML = `
          <div class="timeline-palette">
            <span style="font-size:11px;font-weight:700;color:#cbd5e1;">編集ペン:</span>
            <button class="palette-btn ${this.switchPaletteDir === 'straight' ? 'active' : ''}" data-dir="straight">
              <span class="palette-dot straight"></span>直進
            </button>
            <button class="palette-btn ${this.switchPaletteDir === 'diverge' ? 'active' : ''}" data-dir="diverge">
              <span class="palette-dot diverge"></span>分岐
            </button>
          </div>
          <div class="sched-modal-sub">
            現在ゲーム時刻: <span class="now-time">${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}</span>
          </div>
        `;
        paletteBox.querySelectorAll<HTMLElement>('.palette-btn').forEach(pBtn => {
          pBtn.addEventListener('click', () => {
            this.switchPaletteDir = pBtn.getAttribute('data-dir') as 'straight' | 'diverge';
            paletteBox.querySelectorAll<HTMLElement>('.palette-btn').forEach(b => b.classList.remove('active'));
            pBtn.classList.add('active');
          });
        });
        container.appendChild(paletteBox);

        // 24時間タブ（0〜23時）
        const hourSelector = document.createElement('div');
        hourSelector.className = 'sched-modal-hour-selector';
        hourSelector.innerHTML = `
          <div class="sched-modal-hour-label">
            <span>① 時間帯を選択（0〜23時）</span>
            <span style="color:#94a3b8;font-size:10px;">選択中: <b>${this.selectedScheduleHour}時</b></span>
          </div>
          <div class="sched-hour-tabs" id="modal-hour-tabs"></div>
        `;
        const tabsEl = hourSelector.querySelector<HTMLElement>('#modal-hour-tabs')!;
        for (let h = 0; h < 24; h++) {
          const tab = document.createElement('div');
          tab.className = `sched-hour-tab ${h === this.selectedScheduleHour ? 'active' : ''} ${h === currentHour ? 'now' : ''}`;
          tab.textContent = `${h}`;
          tab.title = `${h}時台を編集`;
          tab.addEventListener('click', () => {
            this.selectedScheduleHour = h;
            this.renderScheduleModalContent();
          });
          tabsEl.appendChild(tab);
        }
        container.appendChild(hourSelector);

        // メイン10分スロット（6枠: 00, 10, 20, 30, 40, 50分）
        const tenMinSection = document.createElement('div');
        tenMinSection.className = 'sched-ten-min-section';
        const selH = this.selectedScheduleHour;
        tenMinSection.innerHTML = `
          <div class="sched-ten-min-header">
            <span>② ${selH}時台の10分刻み設定（クリックで塗り替え）</span>
            <div style="display:flex;gap:4px;">
              <button class="preset-btn" id="btn-fill-hour-straight">この1時間をすべて直進</button>
              <button class="preset-btn" id="btn-fill-hour-diverge">この1時間をすべて分岐</button>
            </div>
          </div>
          <div class="sched-ten-min-grid" id="modal-ten-min-grid"></div>
        `;
        tenMinSection.querySelector<HTMLElement>('#btn-fill-hour-straight')!.addEventListener('click', () => {
          for (let m = 0; m < 6; m++) {
            sched.slots![selH * 6 + m] = 'straight';
          }
          this.renderScheduleModalContent();
        });
        tenMinSection.querySelector<HTMLElement>('#btn-fill-hour-diverge')!.addEventListener('click', () => {
          for (let m = 0; m < 6; m++) {
            sched.slots![selH * 6 + m] = 'diverge';
          }
          this.renderScheduleModalContent();
        });

        const gridEl = tenMinSection.querySelector<HTMLElement>('#modal-ten-min-grid')!;
        for (let m = 0; m < 6; m++) {
          const minVal = m * 10;
          const slotIdx = selH * 6 + m;
          const dir = sched.slots![slotIdx] || 'straight';
          const isCurrentSlot = (selH === currentHour && minVal === currentSlotMinute);

          const card = document.createElement('div');
          card.className = `sched-ten-min-card dir-${dir} ${isCurrentSlot ? 'current-slot' : ''}`;
          card.innerHTML = `
            <span class="time-text">${String(selH).padStart(2, '0')}:${String(minVal).padStart(2, '0')}</span>
            <span class="status-text">${dir === 'straight' ? '直進' : '分岐'}</span>
          `;
          card.addEventListener('click', () => {
            sched.slots![slotIdx] = this.switchPaletteDir;
            sched.hourlyDirections[selH] = sched.slots![selH * 6];
            this.renderScheduleModalContent();
          });
          gridEl.appendChild(card);
        }
        container.appendChild(tenMinSection);

        // 24時間全体マップ（144スロット俯瞰）
        const overviewSec = document.createElement('div');
        overviewSec.className = 'sched-overview-container';
        overviewSec.innerHTML = `
          <div class="sched-overview-header">
            <span>③ 1日全体マップ（24時間 × 6スロット = 全144枠 / クリックでその時間にジャンプ）</span>
          </div>
          <div class="sched-overview-grid" id="modal-overview-grid"></div>
        `;
        const overGridEl = overviewSec.querySelector<HTMLElement>('#modal-overview-grid')!;
        for (let h = 0; h < 24; h++) {
          const col = document.createElement('div');
          col.className = 'sched-overview-col';
          col.title = `${h}時台`;
          for (let m = 0; m < 6; m++) {
            const slotIdx = h * 6 + m;
            const dir = sched.slots![slotIdx] || 'straight';
            const cell = document.createElement('div');
            cell.className = `sched-overview-cell dir-${dir}`;
            cell.addEventListener('click', () => {
              this.selectedScheduleHour = h;
              sched.slots![slotIdx] = this.switchPaletteDir;
              this.renderScheduleModalContent();
            });
            col.appendChild(cell);
          }
          overGridEl.appendChild(col);
        }
        container.appendChild(overviewSec);

        // 一括プリセット
        const presetBox = document.createElement('div');
        presetBox.className = 'timeline-presets';
        presetBox.style.marginTop = '4px';
        presetBox.innerHTML = `
          <span style="font-size:11px;font-weight:700;color:#cbd5e1;margin-right:4px;">一括プリセット:</span>
          <button class="preset-btn" data-preset="all-straight">全日直進</button>
          <button class="preset-btn" data-preset="all-diverge">全日分岐</button>
          <button class="preset-btn" data-preset="rush-diverge">朝夕のみ分岐(7-9,17-19)</button>
          <button class="preset-btn" data-preset="day-night">昼間直進/夜間分岐</button>
          <button class="preset-btn" data-preset="ten-min-alt">10分毎に交互(00直,10分...)</button>
        `;
        presetBox.querySelectorAll<HTMLElement>('.preset-btn').forEach(pBtn => {
          pBtn.addEventListener('click', () => {
            const p = pBtn.getAttribute('data-preset');
            if (p === 'all-straight') {
              sched.slots!.fill('straight');
            } else if (p === 'all-diverge') {
              sched.slots!.fill('diverge');
            } else if (p === 'rush-diverge') {
              sched.slots!.fill('straight');
              [7, 8, 9, 17, 18, 19].forEach(h => {
                for (let m = 0; m < 6; m++) sched.slots![h * 6 + m] = 'diverge';
              });
            } else if (p === 'day-night') {
              for (let h = 0; h < 24; h++) {
                const d = (h >= 6 && h < 18) ? 'straight' : 'diverge';
                for (let m = 0; m < 6; m++) sched.slots![h * 6 + m] = d;
              }
            } else if (p === 'ten-min-alt') {
              for (let i = 0; i < 144; i++) {
                sched.slots![i] = (i % 2 === 0) ? 'straight' : 'diverge';
              }
            }
            this.renderScheduleModalContent();
          });
        });
        container.appendChild(presetBox);

      } else if (sched.mode === 'alternate') {
        const info = document.createElement('div');
        info.style.cssText = 'padding:14px;background:rgba(0,0,0,0.3);border-radius:6px;font-size:12px;color:#cbd5e1;line-height:1.6;';
        info.innerHTML = `
          <b>🔄 交互切替モード</b><br>
          列車が通過するたびに、分岐器が【直進】と【分岐】を自動で交互に反転させます。<br>
          複線駅の進入ポイントや、2つのホームに交互に列車を振り分けたい場合に便利です。
        `;
        container.appendChild(info);
      } else {
        const isStraight = hub.switchState !== 'diverge';
        const manualBox = document.createElement('div');
        manualBox.style.cssText = 'padding:14px;background:rgba(0,0,0,0.3);border-radius:6px;display:flex;flex-direction:column;gap:10px;';
        manualBox.innerHTML = `
          <div style="font-size:12px;color:#cbd5e1;">
            <b>🎛️ 手動モード</b><br>
            列車の通過によって自動で切り替わらず、常に指定した方向へ固定開通します。
          </div>
          <button class="switch-toggle-btn" id="modal-btn-manual-toggle" style="margin-top:4px;">
            🔀 現在の開通方向を切替: ${isStraight ? '【直進中】→ 分岐方向へ開通' : '【分岐中】→ 直進方向へ開通'}
          </button>
        `;
        manualBox.querySelector<HTMLElement>('#modal-btn-manual-toggle')!.addEventListener('click', () => {
          this.onTogglePointSwitch(hub.x, hub.z);
          this.renderScheduleModalContent();
        });
        container.appendChild(manualBox);
      }

    } else if (this.currentEditingTile.type.startsWith('station')) {
      // -------------------------------------------------------------
      // 駅ダイヤ設定（10分刻み）
      // -------------------------------------------------------------
      const tile = this.currentEditingTile;
      if (!tile.stationSchedule) {
        tile.stationSchedule = createDefaultStationSchedule();
      }
      const sched = tile.stationSchedule;
      if (!Array.isArray(sched.slots) || sched.slots.length !== 144) {
        sched.slots = new Array(144).fill('stop');
      }

      const stName = this.currentEditingStationData?.name || tile.stationName || '駅';
      this.scheduleModalTitle.textContent = `⏱️ 駅ダイヤ設定（10分刻みタイムライン） - ${stName}`;

      // ペンパレット ＆ 現在時刻
      const paletteBox = document.createElement('div');
      paletteBox.className = 'sched-modal-palette-box';
      paletteBox.innerHTML = `
        <div class="timeline-palette">
          <span style="font-size:11px;font-weight:700;color:#cbd5e1;">編集ペン:</span>
          <button class="palette-btn ${this.stationPaletteMode === 'stop' ? 'active' : ''}" data-mode="stop">
            <span class="palette-dot stop"></span>停車
          </button>
          <button class="palette-btn ${this.stationPaletteMode === 'wait' ? 'active' : ''}" data-mode="wait">
            <span class="palette-dot wait"></span>待避
          </button>
          <button class="palette-btn ${this.stationPaletteMode === 'pass' ? 'active' : ''}" data-mode="pass">
            <span class="palette-dot pass"></span>通過
          </button>
          <button class="palette-btn ${this.stationPaletteMode === 'reverse' ? 'active' : ''}" data-mode="reverse">
            <span class="palette-dot reverse"></span>折返
          </button>
        </div>
        <div class="sched-modal-sub">
          現在ゲーム時刻: <span class="now-time">${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}</span>
        </div>
      `;
      paletteBox.querySelectorAll<HTMLElement>('.palette-btn').forEach(pBtn => {
        pBtn.addEventListener('click', () => {
          this.stationPaletteMode = pBtn.getAttribute('data-mode') as StationActionMode;
          paletteBox.querySelectorAll<HTMLElement>('.palette-btn').forEach(b => b.classList.remove('active'));
          pBtn.classList.add('active');
        });
      });
      container.appendChild(paletteBox);

      // 24時間タブ（0〜23時）
      const hourSelector = document.createElement('div');
      hourSelector.className = 'sched-modal-hour-selector';
      hourSelector.innerHTML = `
        <div class="sched-modal-hour-label">
          <span>① 時間帯を選択（0〜23時）</span>
          <span style="color:#94a3b8;font-size:10px;">選択中: <b>${this.selectedScheduleHour}時</b></span>
        </div>
        <div class="sched-hour-tabs" id="modal-hour-tabs"></div>
      `;
      const tabsEl = hourSelector.querySelector<HTMLElement>('#modal-hour-tabs')!;
      for (let h = 0; h < 24; h++) {
        const tab = document.createElement('div');
        tab.className = `sched-hour-tab ${h === this.selectedScheduleHour ? 'active' : ''} ${h === currentHour ? 'now' : ''}`;
        tab.textContent = `${h}`;
        tab.title = `${h}時台を編集`;
        tab.addEventListener('click', () => {
          this.selectedScheduleHour = h;
          this.renderScheduleModalContent();
        });
        tabsEl.appendChild(tab);
      }
      container.appendChild(hourSelector);

      // メイン10分スロット（6枠: 00, 10, 20, 30, 40, 50分）
      const tenMinSection = document.createElement('div');
      tenMinSection.className = 'sched-ten-min-section';
      const selH = this.selectedScheduleHour;
      const modeNames: Record<StationActionMode, string> = {
        stop: '停車', wait: '待避', pass: '通過', reverse: '折返'
      };

      tenMinSection.innerHTML = `
        <div class="sched-ten-min-header">
          <span>② ${selH}時台の10分刻み設定（クリックで塗り替え）</span>
          <div style="display:flex;gap:4px;">
            <button class="preset-btn" id="btn-fill-hour-mode">この1時間をすべて[${modeNames[this.stationPaletteMode]}]にする</button>
          </div>
        </div>
        <div class="sched-ten-min-grid" id="modal-ten-min-grid"></div>
      `;
      tenMinSection.querySelector<HTMLElement>('#btn-fill-hour-mode')!.addEventListener('click', () => {
        for (let m = 0; m < 6; m++) {
          sched.slots![selH * 6 + m] = this.stationPaletteMode;
        }
        sched.hourlyModes[selH] = this.stationPaletteMode;
        if (this.onStationScheduleChanged) {
          this.onStationScheduleChanged(tile, sched);
        }
        this.renderScheduleModalContent();
      });

      const gridEl = tenMinSection.querySelector<HTMLElement>('#modal-ten-min-grid')!;
      for (let m = 0; m < 6; m++) {
        const minVal = m * 10;
        const slotIdx = selH * 6 + m;
        const mode = sched.slots![slotIdx] || 'stop';
        const isCurrentSlot = (selH === currentHour && minVal === currentSlotMinute);

        const card = document.createElement('div');
        card.className = `sched-ten-min-card mode-${mode} ${isCurrentSlot ? 'current-slot' : ''}`;
        card.innerHTML = `
          <span class="time-text">${String(selH).padStart(2, '0')}:${String(minVal).padStart(2, '0')}</span>
          <span class="status-text">${modeNames[mode]}</span>
        `;
        card.addEventListener('click', () => {
          sched.slots![slotIdx] = this.stationPaletteMode;
          sched.hourlyModes[selH] = sched.slots![selH * 6];
          if (this.onStationScheduleChanged) {
            this.onStationScheduleChanged(tile, sched);
          }
          this.renderScheduleModalContent();
        });
        gridEl.appendChild(card);
      }
      container.appendChild(tenMinSection);

      // 24時間全体マップ（144スロット俯瞰）
      const overviewSec = document.createElement('div');
      overviewSec.className = 'sched-overview-container';
      overviewSec.innerHTML = `
        <div class="sched-overview-header">
          <span>③ 1日全体マップ（24時間 × 6スロット = 全144枠 / クリックでその時間にジャンプ）</span>
        </div>
        <div class="sched-overview-grid" id="modal-overview-grid"></div>
      `;
      const overGridEl = overviewSec.querySelector<HTMLElement>('#modal-overview-grid')!;
      for (let h = 0; h < 24; h++) {
        const col = document.createElement('div');
        col.className = 'sched-overview-col';
        col.title = `${h}時台`;
        for (let m = 0; m < 6; m++) {
          const slotIdx = h * 6 + m;
          const mode = sched.slots![slotIdx] || 'stop';
          const cell = document.createElement('div');
          cell.className = `sched-overview-cell mode-${mode}`;
          cell.addEventListener('click', () => {
            this.selectedScheduleHour = h;
            sched.slots![slotIdx] = this.stationPaletteMode;
            if (this.onStationScheduleChanged) {
              this.onStationScheduleChanged(tile, sched);
            }
            this.renderScheduleModalContent();
          });
          col.appendChild(cell);
        }
        overGridEl.appendChild(col);
      }
      container.appendChild(overviewSec);

      // 一括プリセット
      const presetBox = document.createElement('div');
      presetBox.className = 'timeline-presets';
      presetBox.style.marginTop = '4px';
      presetBox.innerHTML = `
        <span style="font-size:11px;font-weight:700;color:#cbd5e1;margin-right:4px;">一括プリセット:</span>
        <button class="preset-btn" data-preset="all-stop">全日停車</button>
        <button class="preset-btn" data-preset="all-pass">全日通過</button>
        <button class="preset-btn" data-preset="rush-wait">朝夕待避(7-9,17-19)</button>
        <button class="preset-btn" data-preset="night-pass">夜間通過(23-5)</button>
        <button class="preset-btn" data-preset="all-reverse">終点折返</button>
      `;
      presetBox.querySelectorAll<HTMLElement>('.preset-btn').forEach(pBtn => {
        pBtn.addEventListener('click', () => {
          const p = pBtn.getAttribute('data-preset');
          if (p === 'all-stop') {
            sched.slots!.fill('stop');
          } else if (p === 'all-pass') {
            sched.slots!.fill('pass');
          } else if (p === 'rush-wait') {
            sched.slots!.fill('stop');
            [7, 8, 9, 17, 18, 19].forEach(h => {
              for (let m = 0; m < 6; m++) sched.slots![h * 6 + m] = 'wait';
            });
          } else if (p === 'night-pass') {
            sched.slots!.fill('stop');
            [23, 0, 1, 2, 3, 4, 5].forEach(h => {
              for (let m = 0; m < 6; m++) sched.slots![h * 6 + m] = 'pass';
            });
          } else if (p === 'all-reverse') {
            sched.slots!.fill('reverse');
          }
          if (this.onStationScheduleChanged) {
            this.onStationScheduleChanged(tile, sched);
          }
          this.renderScheduleModalContent();
        });
      });
      container.appendChild(presetBox);

      // 定時発車 & 待避時間
      const extraRow = document.createElement('div');
      extraRow.className = 'schedule-row';
      extraRow.style.marginTop = '4px';
      extraRow.innerHTML = `
        <span class="schedule-label">定時発車:</span>
        <div class="schedule-btn-group" id="modal-st-dep-btns">
          <button class="schedule-btn ${sched.departureMinute === undefined ? 'active' : ''}" data-dep="none">なし</button>
          <button class="schedule-btn ${sched.departureMinute === 0 ? 'active' : ''}" data-dep="0">毎時00分</button>
          <button class="schedule-btn ${sched.departureMinute === 15 ? 'active' : ''}" data-dep="15">毎時15分</button>
          <button class="schedule-btn ${sched.departureMinute === 30 ? 'active' : ''}" data-dep="30">毎時30分</button>
          <button class="schedule-btn ${sched.departureMinute === 45 ? 'active' : ''}" data-dep="45">毎時45分</button>
        </div>
      `;
      extraRow.querySelectorAll<HTMLElement>('#modal-st-dep-btns .schedule-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const dep = btn.getAttribute('data-dep');
          sched.departureMinute = (dep === 'none' ? undefined : parseInt(dep || '0'));
          if (this.onStationScheduleChanged) {
            this.onStationScheduleChanged(tile, sched);
          }
          this.renderScheduleModalContent();
        });
      });
      container.appendChild(extraRow);

      const waitRow = document.createElement('div');
      waitRow.className = 'schedule-row';
      const waitMin = sched.waitMinutes ?? 20;
      waitRow.innerHTML = `
        <span class="schedule-label">待避時間:</span>
        <div class="schedule-btn-group" id="modal-st-wait-btns">
          <button class="schedule-btn ${waitMin === 10 ? 'active' : ''}" data-wait="10">10分</button>
          <button class="schedule-btn ${waitMin === 20 ? 'active' : ''}" data-wait="20">20分</button>
          <button class="schedule-btn ${waitMin === 30 ? 'active' : ''}" data-wait="30">30分</button>
          <button class="schedule-btn ${waitMin === 60 ? 'active' : ''}" data-wait="60">60分</button>
        </div>
      `;
      waitRow.querySelectorAll<HTMLElement>('#modal-st-wait-btns .schedule-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          sched.waitMinutes = parseInt(btn.getAttribute('data-wait') || '20');
          if (this.onStationScheduleChanged) {
            this.onStationScheduleChanged(tile, sched);
          }
          this.renderScheduleModalContent();
        });
      });
      container.appendChild(waitRow);
    }
  }
}
