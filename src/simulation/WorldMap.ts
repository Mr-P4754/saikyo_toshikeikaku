import * as THREE from 'three';
import { ModelFactory } from '../models/ModelFactory';

export type TileType =
  | 'empty'
  | 'rail_ground'
  | 'rail_elevated'
  | 'rail_curve_ground'
  | 'rail_curve_elevated'
  | 'point_switch_ground'
  | 'point_switch_elevated'
  | 'scissors_crossing_ground'
  | 'scissors_crossing_elevated'
  | 'rail_slope'
  | 'station_ground'
  | 'station_elevated'
  | 'road'
  | 'level_crossing'
  | 'residence'
  | 'commercial'
  | 'nature';

export type CurveDirection = 'N_E' | 'E_S' | 'S_W' | 'W_N';
export type SwitchState = 'straight' | 'diverge';
export type CrossingState = 'straight' | 'cross-a' | 'cross-b';

export interface TileData {
  x: number;
  z: number;
  type: TileType;
  rotation: number; // Straight/road/station/slope/踏切: 0=NS軸,1=EW軸。分岐器・シーサス: 0-3(北,東,南,西)=通過方向。
  level: number;
  mesh?: THREE.Group;
  stationPassengers: number;
  landValue: number;

  // Additional Railway Systems
  curveDir?: CurveDirection;
  switchState?: SwitchState;
  slopeReversed?: boolean;

  // ① 4マス勾配レール: 0(地上側の端)〜3(高架側の端)のパート番号
  slopePart?: number;

  // ③ シーサスクロッシング(2×2)グループ管理: 4マスすべてが持つ、起点座標への参照・自身の役割・開通状態
  groupOrigin?: { x: number; z: number };
  crossingRole?: 0 | 1 | 2 | 3; // 0=A(起点/北西or北東側), 1=B, 2=C, 3=D
  crossingState?: CrossingState;

  // ⑤ 踏切: 交差する道路の軸（rotationと直交する軸）
  crossingRoadAxis?: number;

  // ② 分岐器の分岐方向 ('right': 右分岐 / 'left': 左分岐)
  switchBranchSide?: 'left' | 'right';

  // ① 駅舎ホームの配置方向 ('right': 線路進行右側 / 'left': 線路進行左側)
  stationPlatformSide?: 'left' | 'right';

  // ⑤ 駅の詳細情報・収支・有効長設定
  stationName?: string;
  dailyPassengers?: number;
  totalPassengers?: number;
  totalRevenue?: number;
  stationMaintenance?: number;
  stationNetProfit?: number;
  stationTargetLength?: number;

  // ⑤ 駅グループ識別子（複数マス駅を単一駅として扱う）
  stationGroupId?: string;
  stationPart?: 'single' | 'start' | 'mid' | 'end';

  // ① 駅ダイヤ設定（24時間タイムラインバー方式: 停車、待避、通過、折り返し）
  stationSchedule?: StationSchedule;

  // ① 分岐器ダイヤ設定（24時間タイムラインバー方式: 直進、分岐、交互切替）
  switchSchedule?: SwitchSchedule;
}

export type StationActionMode = 'stop' | 'wait' | 'pass' | 'reverse';

export interface StationSchedule {
  // 10分単位の動作モード（24時間 × 6 = 144要素: 00, 10, 20, 30, 40, 50分）
  slots?: StationActionMode[];
  // 0〜23時の各時間帯の動作モード（互換用）
  hourlyModes: StationActionMode[];
  waitMinutes?: number; // 待避時間（分）
  departureMinute?: number | null; // 毎時XX分発車（未設定ならタイマー）
}

export type SwitchScheduleMode = 'manual' | 'timeline' | 'alternate';

export interface SwitchSchedule {
  mode: SwitchScheduleMode;
  // 10分単位の開通方向（24時間 × 6 = 144要素）
  slots?: Array<'straight' | 'diverge'>;
  // 0〜23時の各時間帯の開通方向 ('straight': 直進, 'diverge': 分岐)
  hourlyDirections: Array<'straight' | 'diverge'>;
}

export function createDefaultStationSchedule(): StationSchedule {
  return {
    slots: new Array(144).fill('stop'),
    hourlyModes: new Array(24).fill('stop'),
    waitMinutes: 20,
    departureMinute: null
  };
}

export function createDefaultSwitchSchedule(): SwitchSchedule {
  return {
    mode: 'manual',
    slots: new Array(144).fill('straight'),
    hourlyDirections: new Array(24).fill('straight')
  };
}

export function getStationSlotMode(schedule: StationSchedule | undefined, hour: number, minute: number): StationActionMode {
  if (!schedule) return 'stop';
  const slotIdx = ((hour % 24) * 6) + Math.min(5, Math.floor((minute % 60) / 10));
  if (schedule.slots && schedule.slots[slotIdx]) {
    return schedule.slots[slotIdx];
  }
  if (schedule.hourlyModes && schedule.hourlyModes[hour % 24]) {
    return schedule.hourlyModes[hour % 24];
  }
  return 'stop';
}

export function getSwitchSlotDirection(schedule: SwitchSchedule | undefined, hour: number, minute: number): 'straight' | 'diverge' {
  if (!schedule) return 'straight';
  const slotIdx = ((hour % 24) * 6) + Math.min(5, Math.floor((minute % 60) / 10));
  if (schedule.slots && schedule.slots[slotIdx]) {
    return schedule.slots[slotIdx];
  }
  if (schedule.hourlyDirections && schedule.hourlyDirections[hour % 24]) {
    return schedule.hourlyDirections[hour % 24];
  }
  return 'straight';
}

// ---------------------------------------------------------------------------
// ① ⑦ ⑧ 線路接続モデル（方向インデックス: 0=北, 1=東, 2=南, 3=西）
// レベルは 0(地上)〜4(高架) の5段階。4マス勾配レールは1マスごとに1段ずつ高さが変わるため、
// 「高い側と低い側」がそのまま隣接しても、レベルが完全一致しない限り接続とは判定されない。
// ---------------------------------------------------------------------------
export interface DirVec { x: number; z: number; }
export interface TileExit {
  idx: number;
  level: number;
  targetOffset?: { dx: number; dz: number }; // ② シーサスクロッシング等の対角線移動用オフセット
}
export const LEVEL_GROUND = 0;
export const LEVEL_ELEVATED = 4;
export const SLOPE_PARTS = 4;

export class WorldMap {
  public static readonly GRID_SIZE = 40;
  public static readonly TILE_SIZE = 2.0;

  public static readonly DIRS: DirVec[] = [
    { x: 0, z: -1 }, // 0: North
    { x: 1, z: 0 },  // 1: East
    { x: 0, z: 1 },  // 2: South
    { x: -1, z: 0 }  // 3: West
  ];

  public static opposite(idx: number): number {
    return (idx + 2) % 4;
  }

  public static rotateCW(idx: number): number {
    return (idx + 1) % 4;
  }

  public static rotateCCW(idx: number): number {
    return (idx + 3) % 4;
  }

  public static curveDirToIndices(cd: CurveDirection): [number, number] {
    switch (cd) {
      case 'N_E': return [0, 1];
      case 'E_S': return [1, 2];
      case 'S_W': return [2, 3];
      case 'W_N': return [3, 0];
    }
  }

  public static indicesToCurveDir(a: number, b: number): CurveDirection {
    const key = [a, b].sort((x, y) => x - y).join(',');
    if (key === '0,1') return 'N_E';
    if (key === '1,2') return 'E_S';
    if (key === '2,3') return 'S_W';
    if (key === '0,3') return 'W_N';
    throw new Error(`Invalid curve direction pair: ${a},${b}`);
  }

  /**
   * ② 高架の橋脚は連続4マスごとに1本だけ設置する（間のマスは橋脚なしでデッキのみ）。
   * 線路の軸方向に沿った絶対座標が4の倍数のマスにのみ橋脚を表示する。
   */
  public static shouldShowPier(x: number, z: number, rotation: number): boolean {
    const coord = rotation === 1 ? x : z;
    return (((coord % 4) + 4) % 4) === 0;
  }

  /**
   * ① ⑦ ⑧ タイルが実際に接続している方向・高さレベルの一覧を返す。
   * 曲線・勾配・分岐器（開通方向）を考慮し、これを基準に列車の経路探索・接続判定を行う。
   */
  public static getTileExits(tile: TileData): TileExit[] {
    const isElevated = tile.type.includes('elevated');
    const level: number = isElevated ? LEVEL_ELEVATED : LEVEL_GROUND;

    switch (tile.type) {
      case 'rail_ground':
      case 'rail_elevated':
      case 'station_ground':
      case 'station_elevated':
      case 'road':
      case 'level_crossing':
        return tile.rotation === 1
          ? [{ idx: 1, level }, { idx: 3, level }]
          : [{ idx: 0, level }, { idx: 2, level }];

      case 'rail_curve_ground':
      case 'rail_curve_elevated': {
        if (!tile.curveDir) return [];
        const [i1, i2] = WorldMap.curveDirToIndices(tile.curveDir);
        return [{ idx: i1, level }, { idx: i2, level }];
      }

      case 'rail_slope': {
        // ① ③ 4マス勾配: パート番号(0-3)ごとに地上(0)〜高架(4)のうち1段分だけ高さが変わる。
        // 隣接タイル同士のレベルが完全一致しない限り「高い側と低い側が隣接しているだけ」で接続とはみなさない。
        const part = tile.slopePart ?? 0;
        const lowLevel = part;
        const highLevel = part + 1;
        const axis: [number, number] = tile.rotation === 1 ? [1, 3] : [0, 2];
        const [lowIdx, highIdx] = tile.slopeReversed ? [axis[1], axis[0]] : [axis[0], axis[1]];
        return [{ idx: lowIdx, level: lowLevel }, { idx: highIdx, level: highLevel }];
      }

      case 'point_switch_ground':
      case 'point_switch_elevated': {
        // ③ 分岐器は1マスに根元(back)、直進(forward)、分岐(branchDir)の3方向のポートを持つ。
        // 合流進入（背向進入）を許可するため、接続先検査としては3方向すべてを有効なポートとして返す。
        const forward = ((tile.rotation % 4) + 4) % 4;
        const back = WorldMap.opposite(forward);
        const branchDir = tile.switchBranchSide === 'left' ? WorldMap.rotateCCW(forward) : WorldMap.rotateCW(forward);
        return [
          { idx: back, level },
          { idx: forward, level },
          { idx: branchDir, level }
        ];
      }

      case 'scissors_crossing_ground':
      case 'scissors_crossing_elevated':
        return WorldMap.getScissorsExits(tile, level);

      default:
        return [];
    }
  }

  /**
   * ② シーサスクロッシング(2×2)の接続方向・対角移動オフセットを役割(A/B/C/D)と開通状態から計算する。
   * along = 通過方向の軸、across = 2本の並行線路を隔てる方向。
   * 'straight': 4マスとも通常の複線としてそれぞれ独立に直進。
   * 'cross-a' : A ⇄ D の対角渡り線が開通（中央のダイヤモンド交差を通って対向線路へ直進移動）。B, Cは直進。
   * 'cross-b' : C ⇄ B の対角渡り線が開通（中央のダイヤモンド交差を通って対向線路へ直進移動）。A, Dは直進。
   */
  private static getScissorsExits(tile: TileData, level: number): TileExit[] {
    const along = tile.rotation === 1 ? 1 : 2;
    const backAlong = WorldMap.opposite(along);
    const across = WorldMap.rotateCW(along);
    const alongVec = WorldMap.DIRS[along];
    const acrossVec = WorldMap.DIRS[across];
    const role = tile.crossingRole ?? 0;
    const state = tile.crossingState ?? 'straight';

    if (state === 'straight') {
      return [{ idx: along, level }, { idx: backAlong, level }];
    }

    if (state === 'cross-a') {
      if (role === 0) {
        // A: 手前から対角のDへ移動（渡り線）
        return [
          { idx: backAlong, level },
          { idx: along, level, targetOffset: { dx: alongVec.x + acrossVec.x, dz: alongVec.z + acrossVec.z } }
        ];
      }
      if (role === 3) {
        // D: 奥から対角のAへ戻る、またはAから進入してきた列車がDの先の主線(along)へ進出
        return [
          { idx: along, level },
          { idx: backAlong, level, targetOffset: { dx: -alongVec.x - acrossVec.x, dz: -alongVec.z - acrossVec.z } }
        ];
      }
      // B, C は主線直進可能
      return [{ idx: along, level }, { idx: backAlong, level }];
    }

    // cross-b
    if (role === 2) {
      // C: 手前から対角のBへ移動（渡り線）
      return [
        { idx: backAlong, level },
        { idx: along, level, targetOffset: { dx: alongVec.x - acrossVec.x, dz: alongVec.z - acrossVec.z } }
      ];
    }
    if (role === 1) {
      // B: 奥から対角のCへ戻る、またはCから進入してきた列車がBの先の主線(along)へ進出
      return [
        { idx: along, level },
        { idx: backAlong, level, targetOffset: { dx: -alongVec.x + acrossVec.x, dz: -alongVec.z + acrossVec.z } }
      ];
    }
    // A, D は主線直進可能
    return [{ idx: along, level }, { idx: backAlong, level }];
  }

  private tiles: Map<string, TileData> = new Map();
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.initializeGrid();
  }

  private getKey(x: number, z: number): string {
    return `${x},${z}`;
  }

  private initializeGrid() {
    const half = Math.floor(WorldMap.GRID_SIZE / 2);
    for (let x = -half; x < half; x++) {
      for (let z = -half; z < half; z++) {
        this.tiles.set(this.getKey(x, z), {
          x,
          z,
          type: 'empty',
          rotation: 0,
          level: 1,
          stationPassengers: 0,
          landValue: 100,
          switchState: 'straight'
        });
      }
    }
  }

  public getTile(x: number, z: number): TileData | undefined {
    return this.tiles.get(this.getKey(x, z));
  }

  public getAllTiles(): TileData[] {
    return Array.from(this.tiles.values());
  }

  /**
   * ② ③ 曲線レール（1マス・斜め接続）の敷設。地上/高架どちらも設置可能。
   */
  public placeCurve(x: number, z: number, curveDir: CurveDirection, isElevated: boolean = false): boolean {
    const tile = this.getTile(x, z);
    if (!tile) return false;

    const tileType: TileType = isElevated ? 'rail_curve_elevated' : 'rail_curve_ground';

    if (tile.mesh) {
      this.scene.remove(tile.mesh);
      tile.mesh = undefined;
    }

    tile.type = tileType;
    tile.curveDir = curveDir;
    tile.rotation = 0;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    tile.slopeReversed = undefined;

    const mesh = ModelFactory.createCurveTrackSegment(curveDir, isElevated);
    mesh.position.set(x * WorldMap.TILE_SIZE, 0, z * WorldMap.TILE_SIZE);
    this.scene.add(mesh);
    tile.mesh = mesh;

    return true;
  }

  /**
   * ① 勾配レール（4マス直線）の敷設。origin を地上側の端として、rotation・reversed で決まる
   * 上り方向へ4マス連続で配置し、各マスが1/4ずつ高さを分担する（地上⇔高架を緩やかに接続）。
   */
  public placeSlope(originX: number, originZ: number, rotation: number, reversed: boolean): boolean {
    const axis: [number, number] = rotation === 1 ? [1, 3] : [0, 2];
    const [, highIdx] = reversed ? [axis[1], axis[0]] : [axis[0], axis[1]];
    const stepDir = WorldMap.DIRS[highIdx];

    const positions = Array.from({ length: SLOPE_PARTS }, (_, i) => ({
      x: originX + stepDir.x * i,
      z: originZ + stepDir.z * i
    }));
    for (const p of positions) {
      if (!this.getTile(p.x, p.z)) return false;
    }

    positions.forEach((p, i) => {
      const tile = this.getTile(p.x, p.z)!;
      this.applySlopeTile(tile, rotation, reversed, i);
    });

    return true;
  }

  /**
   * 勾配レール1マス分のデータ・メッシュを反映する（新規敷設・個別復元の両方で使用）
   */
  private applySlopeTile(tile: TileData, rotation: number, reversed: boolean, part: number) {
    if (tile.mesh) {
      this.scene.remove(tile.mesh);
      tile.mesh = undefined;
    }
    tile.type = 'rail_slope';
    tile.rotation = rotation;
    tile.slopeReversed = reversed;
    tile.slopePart = part;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    tile.curveDir = undefined;

    const mesh = ModelFactory.createSlopeTrackPart(rotation, reversed, part);
    mesh.position.set(tile.x * WorldMap.TILE_SIZE, 0, tile.z * WorldMap.TILE_SIZE);
    this.scene.add(mesh);
    tile.mesh = mesh;
  }

  /**
   * ② 分岐器（ポイント）の敷設。曲線レールと同じ1マスで完結する
   * （進入側＋直進側＋分岐側の曲線レールを1タイル内に収める）。
   * rotation: 0-3 = 通過方向（進入→直進方向）のインデックス（0=北,1=東,2=南,3=西）。
   * branchSide: 'right'(右分岐) または 'left'(左分岐)。
   */
  public placeSwitch(x: number, z: number, rotation: number, isElevated: boolean = false, branchSide: 'left' | 'right' = 'right'): boolean {
    const tile = this.getTile(x, z);
    if (!tile) return false;

    const forward = ((rotation % 4) + 4) % 4;
    const switchType: TileType = isElevated ? 'point_switch_elevated' : 'point_switch_ground';

    if (tile.mesh) {
      this.scene.remove(tile.mesh);
      tile.mesh = undefined;
    }

    tile.type = switchType;
    tile.rotation = forward;
    tile.switchState = 'straight';
    tile.switchBranchSide = branchSide;
    tile.curveDir = undefined;
    tile.slopeReversed = undefined;
    tile.groupOrigin = undefined;
    tile.switchSchedule = tile.switchSchedule || createDefaultSwitchSchedule();

    const mesh = ModelFactory.createSwitchHub(forward, false, isElevated, branchSide);
    mesh.position.set(x * WorldMap.TILE_SIZE, 0, z * WorldMap.TILE_SIZE);
    this.scene.add(mesh);
    tile.mesh = mesh;

    return true;
  }

  /**
   * ③ シーサスクロッシング（複線用の交差分岐）の敷設。2×2マスを使用する。
   * origin=A（左上/北西または北東側の角）。rotation: 0=南北方向に並走(横に2本), 1=東西方向に並走(縦に2本)。
   * A-B が1本目の線路、C-D が2本目の線路（Aから見て右手側=acrossDir に1マスずれた位置）。
   */
  public placeScissorsCrossing(originX: number, originZ: number, rotation: number, isElevated: boolean = false): boolean {
    const along = rotation === 1 ? 1 : 2;
    const across = WorldMap.rotateCW(along);
    const alongVec = WorldMap.DIRS[along];
    const acrossVec = WorldMap.DIRS[across];

    const posA = { x: originX, z: originZ };
    const posB = { x: originX + alongVec.x, z: originZ + alongVec.z };
    const posC = { x: originX + acrossVec.x, z: originZ + acrossVec.z };
    const posD = { x: originX + alongVec.x + acrossVec.x, z: originZ + alongVec.z + acrossVec.z };
    const positions = [posA, posB, posC, posD];

    for (const p of positions) {
      if (!this.getTile(p.x, p.z)) return false;
    }

    const crossingType: TileType = isElevated ? 'scissors_crossing_elevated' : 'scissors_crossing_ground';

    positions.forEach((p, role) => {
      const t = this.getTile(p.x, p.z)!;
      if (t.mesh) {
        this.scene.remove(t.mesh);
        t.mesh = undefined;
      }
      t.type = crossingType;
      t.rotation = rotation === 1 ? 1 : 0;
      t.curveDir = undefined;
      t.slopeReversed = undefined;
      t.switchState = 'straight';
      t.groupOrigin = { x: originX, z: originZ };
      t.crossingRole = role as 0 | 1 | 2 | 3;
      t.crossingState = 'straight';

      const mesh = ModelFactory.createScissorsCrossingTile(along, role as 0 | 1 | 2 | 3, isElevated);
      mesh.position.set(p.x * WorldMap.TILE_SIZE, 0, p.z * WorldMap.TILE_SIZE);
      this.scene.add(mesh);
      t.mesh = mesh;
    });

    return true;
  }

  /**
   * ③ シーサスクロッシングの開通状態を straight → cross-a → cross-b → straight … と切り替える。
   * グループ内のどのマスをクリックしても起点(A)を切り替え、4マス全てのメッシュを再構築する。
   */
  public cycleCrossingState(x: number, z: number): CrossingState | null {
    const clicked = this.getTile(x, z);
    if (!clicked || !clicked.groupOrigin) return null;
    const origin = this.getTile(clicked.groupOrigin.x, clicked.groupOrigin.z);
    if (!origin || origin.crossingRole !== 0) return null;

    const order: CrossingState[] = ['straight', 'cross-a', 'cross-b'];
    const nextState = order[(order.indexOf(origin.crossingState ?? 'straight') + 1) % order.length];

    const along = origin.rotation === 1 ? 1 : 2;
    const across = WorldMap.rotateCW(along);
    const alongVec = WorldMap.DIRS[along];
    const acrossVec = WorldMap.DIRS[across];
    const isElevated = origin.type.includes('elevated');

    const positions = [
      { x: origin.x, z: origin.z },
      { x: origin.x + alongVec.x, z: origin.z + alongVec.z },
      { x: origin.x + acrossVec.x, z: origin.z + acrossVec.z },
      { x: origin.x + alongVec.x + acrossVec.x, z: origin.z + alongVec.z + acrossVec.z }
    ];

    positions.forEach((p, role) => {
      const t = this.getTile(p.x, p.z);
      if (!t) return;
      t.crossingState = nextState;
      if (t.mesh) {
        this.scene.remove(t.mesh);
        t.mesh = undefined;
      }
      const mesh = ModelFactory.createScissorsCrossingTile(along, role as 0 | 1 | 2 | 3, isElevated, nextState);
      mesh.position.set(p.x * WorldMap.TILE_SIZE, 0, p.z * WorldMap.TILE_SIZE);
      this.scene.add(mesh);
      t.mesh = mesh;
    });

    return nextState;
  }

  /**
   * シーサスクロッシンググループの代表(A)タイルを取得する
   */
  public resolveCrossingOrigin(x: number, z: number): TileData | undefined {
    const tile = this.getTile(x, z);
    if (!tile || !tile.groupOrigin) return undefined;
    return this.getTile(tile.groupOrigin.x, tile.groupOrigin.z);
  }

  /**
   * ② ポイント切り替え（直進 ⇄ 分岐）。分岐器は1マスなのでそのまま切り替える。
   */
  public togglePointSwitch(x: number, z: number): SwitchState | null {
    const tile = this.getTile(x, z);
    if (!tile || !tile.type.startsWith('point_switch')) return null;

    tile.switchState = (tile.switchState === 'straight') ? 'diverge' : 'straight';

    if (tile.mesh) {
      this.scene.remove(tile.mesh);
      tile.mesh = undefined;
    }

    const isElevated = tile.type.includes('elevated');
    const branchSide = tile.switchBranchSide ?? 'right';
    const mesh = ModelFactory.createSwitchHub(tile.rotation, tile.switchState === 'diverge', isElevated, branchSide);
    mesh.position.set(tile.x * WorldMap.TILE_SIZE, 0, tile.z * WorldMap.TILE_SIZE);
    this.scene.add(mesh);
    tile.mesh = mesh;

    return tile.switchState;
  }

  /**
   * ① 本設置済みの線路・駅等のインフラが存在するかを判定（仮置きによる誤上書き防止用）
   */
  public isPermanentTrackOrStation(x: number, z: number): boolean {
    const tile = this.getTile(x, z);
    if (!tile) return false;
    return (
      tile.type.startsWith('rail') ||
      tile.type.startsWith('station') ||
      tile.type.startsWith('point_switch') ||
      tile.type.startsWith('scissors_crossing') ||
      tile.type === 'level_crossing'
    );
  }

  /**
   * 分岐器タイルそのものを取得する（インスペクター表示等で使用。1マスなので自分自身を返すだけ）
   */
  public resolveSwitchHub(x: number, z: number): TileData | undefined {
    const tile = this.getTile(x, z);
    if (!tile || !tile.type.startsWith('point_switch')) return undefined;
    return tile;
  }

  /**
   * ⑤ 踏切の自動検出: 直進レールと道路が直交して同じマスに置かれた場合、上書きするのではなく
   * 両方を兼ねる踏切タイルにする。軸が同じ（平行）場合は従来通り単純に上書きする。
   */
  private tryCreateLevelCrossing(x: number, z: number, type: TileType, rotation: number, level: number): boolean | null {
    const tile = this.getTile(x, z);
    if (!tile) return null;
    const axis = ((rotation % 2) + 2) % 2;

    if (type === 'road' && tile.type === 'rail_ground' && tile.rotation !== axis) {
      return this.applyLevelCrossing(x, z, tile.rotation, axis, level);
    }
    if (type === 'rail_ground' && tile.type === 'road' && tile.rotation !== axis) {
      return this.applyLevelCrossing(x, z, axis, tile.rotation, level);
    }
    return null;
  }

  private applyLevelCrossing(x: number, z: number, railAxis: number, roadAxis: number, level: number): boolean {
    const tile = this.getTile(x, z)!;
    if (tile.mesh) {
      this.scene.remove(tile.mesh);
      tile.mesh = undefined;
    }
    tile.type = 'level_crossing';
    tile.rotation = railAxis;
    tile.crossingRoadAxis = roadAxis;
    tile.level = level;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    tile.curveDir = undefined;
    tile.slopeReversed = undefined;
    tile.slopePart = undefined;
    tile.crossingRole = undefined;
    tile.crossingState = undefined;

    const mesh = ModelFactory.createLevelCrossing(railAxis);
    mesh.position.set(x * WorldMap.TILE_SIZE, 0, z * WorldMap.TILE_SIZE);
    this.scene.add(mesh);
    tile.mesh = mesh;
    return true;
  }

  /**
   * Set single tile
   */
  public setTile(x: number, z: number, type: TileType, rotation: number = 0, level: number = 1, platformSide: 'left' | 'right' = 'right'): boolean {
    const tile = this.getTile(x, z);
    if (!tile) return false;

    // ⑤ 道路とレールが直交して重なる場合は踏切にする
    const crossingResult = this.tryCreateLevelCrossing(x, z, type, rotation, level);
    if (crossingResult !== null) return crossingResult;

    if (tile.mesh) {
      this.scene.remove(tile.mesh);
      tile.mesh = undefined;
    }

    tile.type = type;
    tile.rotation = rotation;
    tile.level = level;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    tile.crossingRole = undefined;
    tile.crossingState = undefined;
    tile.crossingRoadAxis = undefined;

    // ⑧ 複数マス駅ホームの自動パーツ判定 (single / start / mid / end)
    let stationPart: 'single' | 'start' | 'mid' | 'end' = 'single';
    if (type.startsWith('station')) {
      tile.stationPlatformSide = platformSide;
      tile.stationSchedule = tile.stationSchedule || createDefaultStationSchedule();
      tile.stationTargetLength = tile.stationTargetLength || 1;
      stationPart = this.detectStationPart(x, z, tile.rotation, type);
    }
    if (type.startsWith('point_switch')) {
      tile.switchSchedule = tile.switchSchedule || createDefaultSwitchSchedule();
    }

    let mesh: THREE.Group | undefined;
    const hasPole = Math.abs(x + z) % 3 === 0;

    switch (type) {
      case 'rail_ground':
        mesh = ModelFactory.createGroundTrack(tile.rotation, hasPole);
        break;
      case 'rail_elevated':
        mesh = ModelFactory.createElevatedTrack(tile.rotation, WorldMap.shouldShowPier(x, z, tile.rotation));
        break;
      case 'station_ground':
        mesh = ModelFactory.createStation(tile.rotation, false, stationPart, tile.stationPlatformSide ?? 'right');
        break;
      case 'station_elevated':
        mesh = ModelFactory.createStation(tile.rotation, true, stationPart, tile.stationPlatformSide ?? 'right');
        break;
      case 'road':
        mesh = ModelFactory.createRoad(tile.rotation);
        break;
      case 'level_crossing':
        mesh = ModelFactory.createLevelCrossing(tile.rotation);
        break;
      case 'residence':
        mesh = ModelFactory.createHouse(Math.abs(x * 7 + z * 13) % 4);
        break;
      case 'commercial':
        mesh = ModelFactory.createCommercialBuilding(Math.max(2, level + 1));
        break;
      case 'nature':
        mesh = ModelFactory.createTree();
        break;
      default:
        mesh = undefined;
        break;
    }

    if (mesh) {
      mesh.position.set(x * WorldMap.TILE_SIZE, 0, z * WorldMap.TILE_SIZE);
      this.scene.add(mesh);
      tile.mesh = mesh;
    }

    // Update neighboring stations if this is a station
    if (type.startsWith('station')) {
      if (!tile.stationName) {
        tile.stationName = `第${this.getStationCount() + 1}駅`;
      }
      tile.dailyPassengers = tile.dailyPassengers ?? 0;
      tile.totalPassengers = tile.totalPassengers ?? 0;
      tile.totalRevenue = tile.totalRevenue ?? 0;
      tile.stationMaintenance = 200000;
      tile.stationNetProfit = (tile.totalRevenue ?? 0) - (tile.stationMaintenance ?? 0);
      tile.stationTargetLength = this.getStationRunLength(x, z);

      this.updateNeighborStations(x, z, tile.rotation, type);
    }

    return true;
  }

  /**
   * ⑧ 複数マス駅パーツの自動検出
   */
  private detectStationPart(x: number, z: number, rot: number, type: TileType): 'single' | 'start' | 'mid' | 'end' {
    const prev = rot === 1 ? this.getTile(x - 1, z) : this.getTile(x, z - 1);
    const next = rot === 1 ? this.getTile(x + 1, z) : this.getTile(x, z + 1);

    const hasPrev = prev && prev.type === type && prev.rotation === rot;
    const hasNext = next && next.type === type && next.rotation === rot;

    if (hasPrev && hasNext) return 'mid';
    if (!hasPrev && hasNext) return 'start';
    if (hasPrev && !hasNext) return 'end';
    return 'single';
  }

  /**
   * ⑨ 駅の有効長（連続する同一駅タイル数 = 列車の最大両数）を取得
   */
  public getStationRunLength(x: number, z: number): number {
    const tile = this.getTile(x, z);
    if (!tile || !tile.type.startsWith('station')) return 0;

    const rot = tile.rotation;
    const stepX = rot === 1 ? 1 : 0;
    const stepZ = rot === 1 ? 0 : 1;

    let count = 1;
    let cx = x - stepX, cz = z - stepZ;
    while (true) {
      const t = this.getTile(cx, cz);
      if (t && t.type === tile.type && t.rotation === rot) {
        count++;
        cx -= stepX;
        cz -= stepZ;
      } else break;
    }
    cx = x + stepX; cz = z + stepZ;
    while (true) {
      const t = this.getTile(cx, cz);
      if (t && t.type === tile.type && t.rotation === rot) {
        count++;
        cx += stepX;
        cz += stepZ;
      } else break;
    }
    return count;
  }

  public getStationCount(): number {
    return Array.from(this.tiles.values()).filter(t => t.type.startsWith('station')).length;
  }

  /**
   * ④ 駅グループの先頭タイル（最小座標側のタイル）を取得
   */
  public getStationStartTile(x: number, z: number): TileData | null {
    const tile = this.getTile(x, z);
    if (!tile || !tile.type.startsWith('station')) return null;

    const rot = tile.rotation;
    const stepX = rot === 1 ? 1 : 0;
    const stepZ = rot === 1 ? 0 : 1;

    let cur = tile;
    while (true) {
      const t = this.getTile(cur.x - stepX, cur.z - stepZ);
      if (t && t.type === tile.type && t.rotation === rot) {
        cur = t;
      } else break;
    }
    return cur;
  }

  /**
   * ④ 駅グループを構成する全タイルを取得
   */
  public getStationTiles(x: number, z: number): TileData[] {
    const startTile = this.getStationStartTile(x, z);
    if (!startTile) return [];

    const rot = startTile.rotation;
    const stationType = startTile.type;
    const stepX = rot === 1 ? 1 : 0;
    const stepZ = rot === 1 ? 0 : 1;

    const tiles: TileData[] = [];
    let curX = startTile.x, curZ = startTile.z;
    while (true) {
      const t = this.getTile(curX, curZ);
      if (t && t.type === stationType && t.rotation === rot) {
        tiles.push(t);
        curX += stepX;
        curZ += stepZ;
      } else break;
    }
    return tiles;
  }

  /**
   * ④ 既存の駅のホーム有効長（1〜4両）を設定・変更する
   * 始点タイルを基準に、指定した長さ分になるよう駅タイルを延伸または短縮する。
   */
  public setStationLength(x: number, z: number, targetLength: number): boolean {
    if (targetLength < 1 || targetLength > 4) return false;
    const tile = this.getTile(x, z);
    if (!tile || !tile.type.startsWith('station')) return false;

    const rot = tile.rotation;
    const stationType = tile.type;
    const startTile = this.getStationStartTile(x, z);
    if (!startTile) return false;

    const stepX = rot === 1 ? 1 : 0;
    const stepZ = rot === 1 ? 0 : 1;
    const stationName = startTile.stationName || `駅 (${startTile.x}, ${startTile.z})`;

    // 現在の駅タイル列を取得
    const currentTiles: TileData[] = [];
    let curX = startTile.x, curZ = startTile.z;
    while (true) {
      const t = this.getTile(curX, curZ);
      if (t && t.type === stationType && t.rotation === rot) {
        currentTiles.push(t);
        curX += stepX;
        curZ += stepZ;
      } else break;
    }

    const currentLen = currentTiles.length;
    if (currentLen === targetLength) return true;

    if (targetLength > currentLen) {
      // 延伸：末尾から追加
      for (let i = currentLen; i < targetLength; i++) {
        const nx = startTile.x + stepX * i;
        const nz = startTile.z + stepZ * i;
        const targetTile = this.getTile(nx, nz);
        if (!targetTile) return false;
        // 更地または線路なら駅に置換可能
        if (targetTile.type !== 'empty' && !targetTile.type.includes('rail')) {
          return false; // スペース不足
        }
      }
      for (let i = currentLen; i < targetLength; i++) {
        const nx = startTile.x + stepX * i;
        const nz = startTile.z + stepZ * i;
        this.setTile(nx, nz, stationType, rot, 1);
        const t = this.getTile(nx, nz);
        if (t) {
          t.stationName = stationName;
          t.stationTargetLength = targetLength;
          t.stationSchedule = startTile.stationSchedule;
        }
      }
    } else {
      // 短縮：余剰タイルを撤去（または地上/高架線路へ戻す）
      const normalTrack: TileType = stationType.includes('elevated') ? 'rail_elevated' : 'rail_ground';
      for (let i = targetLength; i < currentLen; i++) {
        const nx = startTile.x + stepX * i;
        const nz = startTile.z + stepZ * i;
        this.setTile(nx, nz, normalTrack, rot, 1);
      }
    }

    // 更新後の全駅タイルのパーツ（start, mid, end, single）とメッシュを再構築
    for (let i = 0; i < targetLength; i++) {
      const nx = startTile.x + stepX * i;
      const nz = startTile.z + stepZ * i;
      const t = this.getTile(nx, nz);
      if (t && t.type === stationType) {
        t.stationTargetLength = targetLength;
        t.stationSchedule = startTile.stationSchedule;
        const part = (targetLength === 1)
          ? 'single'
          : (i === 0 ? 'start' : (i === targetLength - 1 ? 'end' : 'mid'));

        if (t.mesh) this.scene.remove(t.mesh);
        const isElevated = stationType.includes('elevated');
        const platformSide = startTile.stationPlatformSide ?? 'right';
        t.stationPlatformSide = platformSide;
        const mesh = ModelFactory.createStation(rot, isElevated, part, platformSide);
        mesh.position.set(nx * WorldMap.TILE_SIZE, 0, nz * WorldMap.TILE_SIZE);
        this.scene.add(mesh);
        t.mesh = mesh;
      }
    }

    return true;
  }

  /**
   * ⑤ 駅グループ全体の集計情報（合計乗降客数、合計運賃収入、維持費、純利益）を取得
   */
  public getStationAggregateData(x: number, z: number): {
    name: string;
    length: number;
    dailyPassengers: number;
    totalPassengers: number;
    totalRevenue: number;
    maintenance: number;
    netProfit: number;
  } | null {
    const startTile = this.getStationStartTile(x, z);
    if (!startTile) return null;

    const rot = startTile.rotation;
    const stationType = startTile.type;
    const stepX = rot === 1 ? 1 : 0;
    const stepZ = rot === 1 ? 0 : 1;

    let length = 0;
    let daily = 0;
    let totalPass = 0;
    let totalRev = 0;

    let curX = startTile.x, curZ = startTile.z;
    while (true) {
      const t = this.getTile(curX, curZ);
      if (t && t.type === stationType && t.rotation === rot) {
        length++;
        daily += t.dailyPassengers ?? 0;
        totalPass += t.totalPassengers ?? 0;
        totalRev += t.totalRevenue ?? 0;
        curX += stepX;
        curZ += stepZ;
      } else break;
    }

    const maintenance = length * 150000; // 1両あたり月¥150,000
    const netProfit = totalRev - maintenance;

    return {
      name: startTile.stationName || `駅 (${startTile.x}, ${startTile.z})`,
      length,
      dailyPassengers: daily,
      totalPassengers: totalPass,
      totalRevenue: totalRev,
      maintenance,
      netProfit
    };
  }

  private updateNeighborStations(x: number, z: number, rot: number, type: TileType) {
    const neighbors = rot === 1
      ? [this.getTile(x - 1, z), this.getTile(x + 1, z)]
      : [this.getTile(x, z - 1), this.getTile(x, z + 1)];

    neighbors.forEach(n => {
      if (n && n.type === type && n.mesh) {
        const part = this.detectStationPart(n.x, n.z, n.rotation, n.type);
        this.scene.remove(n.mesh);
        const isElevated = n.type.includes('elevated');
        const newMesh = ModelFactory.createStation(n.rotation, isElevated, part, n.stationPlatformSide ?? 'right');
        newMesh.position.set(n.x * WorldMap.TILE_SIZE, 0, n.z * WorldMap.TILE_SIZE);
        this.scene.add(newMesh);
        n.mesh = newMesh;
      }
    });
  }

  /**
   * ② 分岐器の開通状態を明示的に指定して切り替える
   */
  public setSwitchState(x: number, z: number, state: SwitchState): void {
    const tile = this.getTile(x, z);
    if (!tile || !tile.type.startsWith('point_switch')) return;
    if (tile.switchState === state) return;

    tile.switchState = state;
    if (tile.mesh) {
      this.scene.remove(tile.mesh);
      tile.mesh = undefined;
    }
    const isElevated = tile.type.includes('elevated');
    const branchSide = tile.switchBranchSide ?? 'right';
    const mesh = ModelFactory.createSwitchHub(tile.rotation, tile.switchState === 'diverge', isElevated, branchSide);
    mesh.position.set(tile.x * WorldMap.TILE_SIZE, 0, tile.z * WorldMap.TILE_SIZE);
    this.scene.add(mesh);
    tile.mesh = mesh;
  }

  /**
   * ⑤ 指定された有効長（1〜4マス）の駅ホームを一括敷設する。
   * 全マスに共通の stationGroupId を割り当て、先頭・中間・末尾のパーツを正確に適用する。
   */
  public placeStationGroup(
    originX: number,
    originZ: number,
    length: number,
    rotation: number,
    isElevated: boolean = false,
    name?: string,
    platformSide: 'left' | 'right' = 'right'
  ): boolean {
    const rot = rotation % 2;
    const stepX = rot === 1 ? 1 : 0;
    const stepZ = rot === 1 ? 0 : 1;
    const stationType: TileType = isElevated ? 'station_elevated' : 'station_ground';

    // 敷設可能チェック
    for (let i = 0; i < length; i++) {
      const tx = originX + stepX * i;
      const tz = originZ + stepZ * i;
      const t = this.getTile(tx, tz);
      if (!t) return false;
      if (this.isPermanentTrackOrStation(tx, tz)) return false;
    }

    const groupId = `st_${Date.now()}_${originX}_${originZ}`;
    const stationName = name || `第${this.getStationCount() + 1}駅`;

    for (let i = 0; i < length; i++) {
      const tx = originX + stepX * i;
      const tz = originZ + stepZ * i;
      const part: 'single' | 'start' | 'mid' | 'end' =
        length === 1 ? 'single' : (i === 0 ? 'start' : (i === length - 1 ? 'end' : 'mid'));

      const tile = this.getTile(tx, tz)!;
      if (tile.mesh) {
        this.scene.remove(tile.mesh);
        tile.mesh = undefined;
      }

      tile.type = stationType;
      tile.rotation = rot;
      tile.level = isElevated ? LEVEL_ELEVATED : LEVEL_GROUND;
      tile.stationGroupId = groupId;
      tile.stationPart = part;
      tile.stationPlatformSide = platformSide;
      tile.stationName = stationName;
      tile.stationTargetLength = length;
      tile.dailyPassengers = 0;
      tile.totalPassengers = 0;
      tile.totalRevenue = 0;
      tile.stationMaintenance = 150000 * length;
      tile.stationNetProfit = 0;
      tile.stationSchedule = createDefaultStationSchedule();

      const mesh = ModelFactory.createStation(rot, isElevated, part, platformSide);
      mesh.position.set(tx * WorldMap.TILE_SIZE, 0, tz * WorldMap.TILE_SIZE);
      this.scene.add(mesh);
      tile.mesh = mesh;
    }

    return true;
  }

  private resetTileData(tile: TileData) {
    if (tile.mesh) {
      this.scene.remove(tile.mesh);
      tile.mesh = undefined;
    }
    tile.type = 'empty';
    tile.rotation = 0;
    tile.level = 1;
    tile.stationPassengers = 0;
    tile.curveDir = undefined;
    tile.switchState = 'straight';
    tile.groupOrigin = undefined;
    tile.crossingRole = undefined;
    tile.crossingState = undefined;
    tile.crossingRoadAxis = undefined;
    tile.slopeReversed = undefined;
    tile.slopePart = undefined;
    tile.stationGroupId = undefined;
    tile.stationPart = undefined;
    tile.stationPlatformSide = undefined;
    tile.stationSchedule = undefined;
    tile.switchSchedule = undefined;
    tile.stationName = undefined;
    tile.dailyPassengers = undefined;
    tile.totalPassengers = undefined;
    tile.totalRevenue = undefined;
    tile.stationMaintenance = undefined;
    tile.stationNetProfit = undefined;
    tile.stationTargetLength = undefined;
  }

  /**
   * ⑤ 撤去処理。駅タイルの場合は同一駅グループ（有効長分の全マス）を一括撤去する。
   * シーサスクロッシンググループの一員を撤去した場合は残りを単体線路化する。
   */
  public demolishTile(x: number, z: number): boolean {
    const tile = this.getTile(x, z);
    if (!tile || tile.type === 'empty') return false;

    // ⑤ 駅タイルの場合: 同一駅グループ全体を一括撤去する
    if (tile.type.startsWith('station')) {
      const tilesToDemolish: TileData[] = [];
      if (tile.stationGroupId) {
        const targetGroupId = tile.stationGroupId;
        this.tiles.forEach(t => {
          if (t.stationGroupId === targetGroupId) {
            tilesToDemolish.push(t);
          }
        });
      } else {
        // レガシー駅の場合: 連続する駅マスを収集
        const startTile = this.getStationStartTile(x, z);
        if (startTile) {
          const rot = startTile.rotation;
          const stType = startTile.type;
          const stepX = rot === 1 ? 1 : 0;
          const stepZ = rot === 1 ? 0 : 1;
          let curX = startTile.x, curZ = startTile.z;
          while (true) {
            const t = this.getTile(curX, curZ);
            if (t && t.type === stType && t.rotation === rot) {
              tilesToDemolish.push(t);
              curX += stepX;
              curZ += stepZ;
            } else break;
          }
        } else {
          tilesToDemolish.push(tile);
        }
      }

      for (const st of tilesToDemolish) {
        const prevType = st.type;
        const rot = st.rotation;
        const sx = st.x;
        const sz = st.z;
        this.resetTileData(st);
        this.updateNeighborStations(sx, sz, rot, prevType);
      }
      return true;
    }

    // シーサスクロッシングの独立化処理
    if (tile.groupOrigin) {
      const origin = this.getTile(tile.groupOrigin.x, tile.groupOrigin.z);
      if (origin && origin.crossingRole === 0) {
        const along = origin.rotation === 1 ? 1 : 2;
        const across = WorldMap.rotateCW(along);
        const alongVec = WorldMap.DIRS[along];
        const acrossVec = WorldMap.DIRS[across];
        const group = [
          { x: origin.x, z: origin.z },
          { x: origin.x + alongVec.x, z: origin.z + alongVec.z },
          { x: origin.x + acrossVec.x, z: origin.z + acrossVec.z },
          { x: origin.x + alongVec.x + acrossVec.x, z: origin.z + alongVec.z + acrossVec.z }
        ];
        for (const p of group) {
          if (p.x === x && p.z === z) continue;
          const t = this.getTile(p.x, p.z);
          if (t) t.groupOrigin = undefined;
        }
      }
    }

    const prevType = tile.type;
    const rot = tile.rotation;
    this.resetTileData(tile);

    if (prevType.startsWith('station')) {
      this.updateNeighborStations(x, z, rot, prevType);
    }

    return true;
  }

  public clearAll() {
    this.tiles.forEach(tile => {
      this.resetTileData(tile);
      tile.landValue = 100;
    });
  }

  public serialize(): string {
    const nonEmpties: any[] = [];
    this.tiles.forEach(t => {
      // ③ シーサスクロッシングの非起点マス(B/C/D)は起点(A)から復元可能なため保存対象から除外
      if (t.groupOrigin && t.crossingRole !== 0) return;
      if (t.type !== 'empty') {
        nonEmpties.push({
          x: t.x,
          z: t.z,
          type: t.type,
          rot: t.rotation,
          lvl: t.level,
          curveDir: t.curveDir,
          sw: t.switchState,
          slopeRev: t.slopeReversed,
          slopePart: t.slopePart,
          crossState: t.crossingState,
          roadAxis: t.crossingRoadAxis
        });
      }
    });
    return JSON.stringify(nonEmpties);
  }

  public deserialize(jsonStr: string) {
    try {
      const data = JSON.parse(jsonStr);
      this.clearAll();
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item.type.startsWith('point_switch')) {
            this.placeSwitch(item.x, item.z, item.rot || 0, item.type.includes('elevated'));
            if (item.sw === 'diverge') {
              this.togglePointSwitch(item.x, item.z);
            }
          } else if (item.type.startsWith('scissors_crossing')) {
            this.placeScissorsCrossing(item.x, item.z, item.rot || 0, item.type.includes('elevated'));
            const target: CrossingState = item.crossState || 'straight';
            while (this.getTile(item.x, item.z)?.crossingState !== target) {
              const before = this.getTile(item.x, item.z)?.crossingState;
              this.cycleCrossingState(item.x, item.z);
              if (this.getTile(item.x, item.z)?.crossingState === before) break; // 安全弁
            }
          } else if (item.type.startsWith('rail_curve') && item.curveDir !== undefined) {
            this.placeCurve(item.x, item.z, item.curveDir, item.type.includes('elevated'));
          } else if (item.type === 'rail_slope') {
            // 各マスを個別に復元する（グループの一部が撤去され欠けていても復元できるように）
            const tile = this.getTile(item.x, item.z);
            if (tile) {
              this.applySlopeTile(tile, item.rot || 0, !!item.slopeRev, item.slopePart || 0);
            }
          } else if (item.type === 'level_crossing') {
            this.applyLevelCrossing(item.x, item.z, item.rot || 0, item.roadAxis ?? (1 - (item.rot || 0)), item.lvl || 1);
          } else {
            this.setTile(item.x, item.z, item.type, item.rot || 0, item.lvl || 1);
          }
        }
      }
    } catch (e) {
      console.error('Failed to load save data', e);
    }
  }
}
