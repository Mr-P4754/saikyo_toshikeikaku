import { TileType, TileData } from '../simulation/WorldMap';
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
  'point-switch': { cost: 4000000, tileType: null, name: '分岐器(地上)', icon: '🔀' },
  'point-switch-elevated': { cost: 7000000, tileType: null, name: '分岐器(高架)', icon: '🔀' },
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
    tools: ['rail-straight', 'rail-elevated', 'rail-curve', 'rail-curve-elevated', 'rail-slope', 'point-switch', 'point-switch-elevated'],
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
  private guideToggleBtn = document.getElementById('btn-guide-toggle')!;
  private quickGuide = document.getElementById('quick-guide')!;
  private closeGuideBtn = document.getElementById('btn-close-guide')!;

  private reportBtn = document.getElementById('btn-report')!;
  private reportModal = document.getElementById('report-modal')!;
  private closeReportBtn = document.getElementById('btn-close-report')!;

  private camViewBtn = document.getElementById('btn-cam-view')!;
  private camViewText = document.getElementById('cam-view-text')!;
  private timeToggleBtn = document.getElementById('btn-time-toggle')!;
  private timeIcon = document.getElementById('time-icon')!;
  private timeText = document.getElementById('time-text')!;
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

  // ⑧ 回転ヒント表示 / ⑦ 設置決定・キャンセルボタン
  private rotationHint = document.getElementById('rotation-hint')!;
  private rotationValueEl = document.getElementById('rotation-value')!;
  private confirmPlacementBtn = document.getElementById('btn-confirm-placement')!;
  private cancelPlacementBtn = document.getElementById('btn-cancel-placement')!;
  private rotatePlacementBtn = document.getElementById('btn-rotate-placement')!;

  private inspectorPanel = document.getElementById('inspector-panel')!;
  private inspectCoords = document.getElementById('inspect-coords')!;
  private inspectType = document.getElementById('inspect-type')!;
  private inspectExtraVal = document.getElementById('inspect-extra-val')!;
  private inspectActions = document.getElementById('inspect-actions')!;
  private closeInspectBtn = document.getElementById('btn-close-inspect')!;

  // ⑤ & ⑦ Vehicle Modal references
  private vehicleModal = document.getElementById('vehicle-modal')!;
  private vehicleGrid = document.getElementById('vehicle-grid')!;
  private closeVehicleBtn = document.getElementById('btn-close-vehicle')!;
  private vehTotalPrice = document.getElementById('veh-total-price')!;
  private confirmBuyTrainBtn = document.getElementById('btn-confirm-buy-train')!;

  private selectedVehicle: VehicleModelInfo = VEHICLE_CATALOG[5]; // Default: 2310系
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
  public onConfirmBuyTrain: (model: VehicleModelInfo, cars: 1 | 2 | 3 | 4) => void = () => {};
  // ① 列車撤去
  public onRemoveTrain: (trainId: number) => void = () => {};
  // ⑦ 仮置き中プレースメントの決定・キャンセル
  public onConfirmPlacement: () => void = () => {};
  public onCancelPlacement: () => void = () => {};
  // ⑤ タッチデバイス用の回転ボタン（右クリックできない端末向け）
  public onRotatePlacement: () => void = () => {};

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

    // ⑦ 設置決定・キャンセルボタン / ⑤ 回転ボタン（タッチ端末で右クリックの代替）
    this.confirmPlacementBtn.addEventListener('click', () => this.onConfirmPlacement());
    this.cancelPlacementBtn.addEventListener('click', () => this.onCancelPlacement());
    this.rotatePlacementBtn.addEventListener('click', () => this.onRotatePlacement());

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

    // ④ Guide Toggle
    this.guideToggleBtn?.addEventListener('click', () => {
      this.quickGuide.classList.toggle('hidden');
    });
    this.closeGuideBtn?.addEventListener('click', () => {
      this.quickGuide.classList.add('hidden');
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

    this.toolSubmenu.classList.remove('hidden');
    this.categoryBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-category') === categoryId));

    // ⑦ サブメニューがガイドバナーと重なって操作ボタンを隠してしまわないよう、開いている間は自動的に隠す
    this.quickGuide.classList.add('hidden');
  }

  private closeSubmenu() {
    this.toolSubmenu.classList.add('hidden');
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
        <div class="veh-nickname">"${veh.nickname}"</div>
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
      this.timeText.textContent = '昼間';
    } else if (time === 'sunset') {
      this.timeIcon.textContent = '🌅';
      this.timeText.textContent = '夕暮れ';
    } else {
      this.timeIcon.textContent = '🌙';
      this.timeText.textContent = '夜景';
    }
  }

  public updateHUD(dateStr: string, timeStr: string, fundsStr: string, popStr: string) {
    this.dateDisplay.textContent = dateStr;
    this.clockDisplay.textContent = timeStr;
    this.fundsDisplay.textContent = fundsStr;
    this.popDisplay.textContent = popStr;
  }

  /**
   * ⑧ 現在選択中のツールの回転ヒントを表示/更新する
   */
  public setRotationHint(visible: boolean, label: string = '') {
    this.rotationHint.classList.toggle('hidden', !visible);
    if (visible) {
      this.rotationValueEl.textContent = label;
      // ⑦ 設置ヒント・決定ボタンとガイドバナーが重なって隠れないよう、表示中は自動的に隠す
      this.quickGuide.classList.add('hidden');
    }
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
      this.camViewText.textContent = '前面展望';
      this.camViewBtn.classList.add('active');
    } else {
      this.cabOverlay.classList.add('hidden');
      this.camViewText.textContent = '自由視点';
      this.camViewBtn.classList.remove('active');
    }
  }

  public updateCabSpeed(speed: number) {
    this.cabSpeedVal.textContent = String(Math.round(speed));
  }

  /**
   * ② ポイント切り替えボタンを含むインスペクター表示
   */
  public showInspector(tile: TileData, switchHub?: TileData, stationRunLength?: number) {
    this.inspectorPanel.classList.remove('hidden');
    this.inspectCoords.textContent = `(${tile.x}, ${tile.z})`;

    const typeNames: Record<TileType, string> = {
      empty: '更地',
      rail_ground: '線路 (地上)',
      rail_elevated: '高架線路',
      rail_curve_ground: '曲線レール (地上)',
      rail_curve_elevated: '曲線レール (高架)',
      point_switch_ground: '分岐器・ポイント (地上・2×2)',
      point_switch_elevated: '分岐器・ポイント (高架・2×2)',
      rail_slope: '勾配線路 (スロープ)',
      station_ground: '駅舎 (地上)',
      station_elevated: '高架駅',
      road: '道路',
      residence: `住宅区画 (Lv.${tile.level})`,
      commercial: `商業オフィスビル (Lv.${tile.level})`,
      nature: '森林・緑地'
    };
    this.inspectType.textContent = typeNames[tile.type] || tile.type;
    this.inspectActions.innerHTML = '';

    if (switchHub) {
      const isStraight = (switchHub.switchState !== 'diverge');
      this.inspectExtraVal.textContent = `開通方向: ${isStraight ? '【直進】' : '【分岐】'}`;

      const switchBtn = document.createElement('button');
      switchBtn.className = 'switch-toggle-btn';
      switchBtn.textContent = `🔀 進路切替: ${isStraight ? '分岐方向へ開通' : '直進方向へ開通'}`;
      switchBtn.addEventListener('click', () => {
        this.onTogglePointSwitch(switchHub.x, switchHub.z);
      });
      this.inspectActions.appendChild(switchBtn);
    } else if (tile.type.startsWith('station')) {
      const runLen = stationRunLength ?? 1;
      this.inspectExtraVal.textContent = `待機乗客: ${tile.stationPassengers}人 / 有効長: ${runLen}両（超える編成は通過）`;
    } else if (tile.type === 'residence' || tile.type === 'commercial') {
      this.inspectExtraVal.textContent = `地価: ¥${(tile.landValue * 10000).toLocaleString()}`;
    } else {
      this.inspectExtraVal.textContent = '良好';
    }
  }

  /**
   * ① 列車（編成）を選択/撤去するためのインスペクター表示
   */
  public showTrainInspector(train: TrainInstance) {
    this.inspectorPanel.classList.remove('hidden');
    this.inspectCoords.textContent = `編成 #${train.id}`;
    this.inspectType.textContent = train.name;
    this.inspectExtraVal.textContent =
      `${train.carCount}両編成 / 乗客 ${train.passengers}人 (定員${train.capacity}人)`;

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
}
