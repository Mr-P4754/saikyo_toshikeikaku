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
  | 'rail_slope'
  | 'station_ground'
  | 'station_elevated'
  | 'road'
  | 'residence'
  | 'commercial'
  | 'nature';

export type CurveDirection = 'N_E' | 'E_S' | 'S_W' | 'W_N';
export type SwitchState = 'straight' | 'diverge';

export interface TileData {
  x: number;
  z: number;
  type: TileType;
  rotation: number; // Straight/road/station/slope: 0=NS axis,1=EW axis. Point switch hub: 0-3 = forward direction index (N,E,S,W).
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

  // ⑦ 分岐器(2×2)グループ管理: 分岐器を構成する4マスすべてが持つ、起点(ハブ)座標への参照
  switchGroupOrigin?: { x: number; z: number };
}

// ---------------------------------------------------------------------------
// ① ⑦ ⑧ 線路接続モデル（方向インデックス: 0=北, 1=東, 2=南, 3=西）
// レベルは 0(地上)〜4(高架) の5段階。4マス勾配レールは1マスごとに1段ずつ高さが変わるため、
// 「高い側と低い側」がそのまま隣接しても、レベルが完全一致しない限り接続とは判定されない。
// ---------------------------------------------------------------------------
export interface DirVec { x: number; z: number; }
export interface TileExit { idx: number; level: number; }
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
        const forward = ((tile.rotation % 4) + 4) % 4;
        const back = WorldMap.opposite(forward);
        const right = WorldMap.rotateCW(forward);
        const exits: TileExit[] = [{ idx: back, level }];
        if (tile.switchState === 'diverge') {
          exits.push({ idx: right, level });
        } else {
          exits.push({ idx: forward, level });
        }
        return exits;
      }

      default:
        return [];
    }
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
    tile.switchGroupOrigin = undefined;
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
    tile.switchGroupOrigin = undefined;
    tile.curveDir = undefined;

    const mesh = ModelFactory.createSlopeTrackPart(rotation, reversed, part);
    mesh.position.set(tile.x * WorldMap.TILE_SIZE, 0, tile.z * WorldMap.TILE_SIZE);
    this.scene.add(mesh);
    tile.mesh = mesh;
  }

  /**
   * ⑦ ⑧ 分岐器（ポイント）の敷設。2×2マスを使用し、直進側と分岐側がゆるやかなS字で自然に分かれる。
   * rotation: 0-3 = 通過方向（進入→直進方向）のインデックス（0=北,1=東,2=南,3=西）。分岐は進行方向の右手側に伸びる。
   */
  public placeSwitch(originX: number, originZ: number, rotation: number, isElevated: boolean = false): boolean {
    const forward = ((rotation % 4) + 4) % 4;
    const right = WorldMap.rotateCW(forward);
    const fVec = WorldMap.DIRS[forward];
    const rVec = WorldMap.DIRS[right];

    const hubPos = { x: originX, z: originZ };
    const throughPos = { x: originX + fVec.x, z: originZ + fVec.z };
    const legAPos = { x: originX + rVec.x, z: originZ + rVec.z }; // 分岐: 経路1（直進軸→右方向へ曲がる手前）
    const legBPos = { x: originX + fVec.x + rVec.x, z: originZ + fVec.z + rVec.z }; // 分岐: 経路2（右方向へ抜ける）

    const positions = [hubPos, throughPos, legAPos, legBPos];
    for (const p of positions) {
      if (!this.getTile(p.x, p.z)) return false;
    }

    const switchType: TileType = isElevated ? 'point_switch_elevated' : 'point_switch_ground';
    const railType: TileType = isElevated ? 'rail_elevated' : 'rail_ground';
    const curveType: TileType = isElevated ? 'rail_curve_elevated' : 'rail_curve_ground';

    const clearMesh = (t: TileData) => {
      if (t.mesh) {
        this.scene.remove(t.mesh);
        t.mesh = undefined;
      }
    };

    // Hub（ポイント本体）
    const hub = this.getTile(hubPos.x, hubPos.z)!;
    clearMesh(hub);
    hub.type = switchType;
    hub.rotation = forward;
    hub.switchState = 'straight';
    hub.curveDir = undefined;
    hub.slopeReversed = undefined;
    hub.switchGroupOrigin = { x: hubPos.x, z: hubPos.z };
    const hubMesh = ModelFactory.createSwitchHub(forward, false, isElevated);
    hubMesh.position.set(hubPos.x * WorldMap.TILE_SIZE, 0, hubPos.z * WorldMap.TILE_SIZE);
    this.scene.add(hubMesh);
    hub.mesh = hubMesh;

    // Through（直進側の延長）
    const through = this.getTile(throughPos.x, throughPos.z)!;
    clearMesh(through);
    through.type = railType;
    through.rotation = (forward === 1 || forward === 3) ? 1 : 0;
    through.switchState = 'straight';
    through.curveDir = undefined;
    through.slopeReversed = undefined;
    through.switchGroupOrigin = { x: hubPos.x, z: hubPos.z };
    const throughMesh = isElevated
      ? ModelFactory.createElevatedTrack(through.rotation, WorldMap.shouldShowPier(throughPos.x, throughPos.z, through.rotation))
      : ModelFactory.createGroundTrack(through.rotation, false);
    throughMesh.position.set(throughPos.x * WorldMap.TILE_SIZE, 0, throughPos.z * WorldMap.TILE_SIZE);
    this.scene.add(throughMesh);
    through.mesh = throughMesh;

    // LegA（ハブ→右方向へ曲がり始める最初の1マス）: 接続方向 = 後方(=進入軸の反対) と 前方(=forward)
    const legA = this.getTile(legAPos.x, legAPos.z)!;
    clearMesh(legA);
    const legACurveDir = WorldMap.indicesToCurveDir(WorldMap.opposite(right), forward);
    legA.type = curveType;
    legA.curveDir = legACurveDir;
    legA.rotation = 0;
    legA.switchState = 'straight';
    legA.slopeReversed = undefined;
    legA.switchGroupOrigin = { x: hubPos.x, z: hubPos.z };
    const legAMesh = ModelFactory.createCurveTrackSegment(legACurveDir, isElevated);
    legAMesh.position.set(legAPos.x * WorldMap.TILE_SIZE, 0, legAPos.z * WorldMap.TILE_SIZE);
    this.scene.add(legAMesh);
    legA.mesh = legAMesh;

    // LegB（外側へ抜ける最終マス）: 接続方向 = 後方(=forwardの反対) と 右方向(=right)
    const legB = this.getTile(legBPos.x, legBPos.z)!;
    clearMesh(legB);
    const legBCurveDir = WorldMap.indicesToCurveDir(WorldMap.opposite(forward), right);
    legB.type = curveType;
    legB.curveDir = legBCurveDir;
    legB.rotation = 0;
    legB.switchState = 'straight';
    legB.slopeReversed = undefined;
    legB.switchGroupOrigin = { x: hubPos.x, z: hubPos.z };
    const legBMesh = ModelFactory.createCurveTrackSegment(legBCurveDir, isElevated);
    legBMesh.position.set(legBPos.x * WorldMap.TILE_SIZE, 0, legBPos.z * WorldMap.TILE_SIZE);
    this.scene.add(legBMesh);
    legB.mesh = legBMesh;

    return true;
  }

  /**
   * ② ポイント切り替え（直進 ⇄ 分岐）。分岐器グループのどのマスをクリックしても起点(ハブ)を切り替える。
   */
  public togglePointSwitch(x: number, z: number): SwitchState | null {
    let tile = this.getTile(x, z);
    if (!tile) return null;

    if (tile.switchGroupOrigin && !tile.type.startsWith('point_switch')) {
      tile = this.getTile(tile.switchGroupOrigin.x, tile.switchGroupOrigin.z);
    }
    if (!tile || !tile.type.startsWith('point_switch')) return null;

    tile.switchState = (tile.switchState === 'straight') ? 'diverge' : 'straight';

    // Rebuild hub mesh only (through/leg tracks are always physically present)
    if (tile.mesh) {
      this.scene.remove(tile.mesh);
      tile.mesh = undefined;
    }

    const isElevated = tile.type.includes('elevated');
    const mesh = ModelFactory.createSwitchHub(tile.rotation, tile.switchState === 'diverge', isElevated);
    mesh.position.set(tile.x * WorldMap.TILE_SIZE, 0, tile.z * WorldMap.TILE_SIZE);
    this.scene.add(mesh);
    tile.mesh = mesh;

    return tile.switchState;
  }

  /**
   * 分岐器グループの代表(ハブ)タイルを取得する（インスペクター表示等で使用）
   */
  public resolveSwitchHub(x: number, z: number): TileData | undefined {
    const tile = this.getTile(x, z);
    if (!tile) return undefined;
    if (tile.type.startsWith('point_switch')) return tile;
    if (tile.switchGroupOrigin) return this.getTile(tile.switchGroupOrigin.x, tile.switchGroupOrigin.z);
    return undefined;
  }

  /**
   * Set single tile
   */
  public setTile(x: number, z: number, type: TileType, rotation: number = 0, level: number = 1): boolean {
    const tile = this.getTile(x, z);
    if (!tile) return false;

    if (tile.mesh) {
      this.scene.remove(tile.mesh);
      tile.mesh = undefined;
    }

    tile.type = type;
    tile.rotation = rotation;
    tile.level = level;
    tile.switchState = 'straight';
    tile.switchGroupOrigin = undefined;

    // ⑧ 複数マス駅ホームの自動パーツ判定 (single / start / mid / end)
    let stationPart: 'single' | 'start' | 'mid' | 'end' = 'single';
    if (type.startsWith('station')) {
      stationPart = this.detectStationPart(x, z, tile.rotation, type);
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
        mesh = ModelFactory.createStation(tile.rotation, false, stationPart);
        break;
      case 'station_elevated':
        mesh = ModelFactory.createStation(tile.rotation, true, stationPart);
        break;
      case 'road':
        mesh = ModelFactory.createRoad(tile.rotation);
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

  private updateNeighborStations(x: number, z: number, rot: number, type: TileType) {
    const neighbors = rot === 1
      ? [this.getTile(x - 1, z), this.getTile(x + 1, z)]
      : [this.getTile(x, z - 1), this.getTile(x, z + 1)];

    neighbors.forEach(n => {
      if (n && n.type === type && n.mesh) {
        const part = this.detectStationPart(n.x, n.z, n.rotation, n.type);
        this.scene.remove(n.mesh);
        const isElevated = n.type.includes('elevated');
        const newMesh = ModelFactory.createStation(n.rotation, isElevated, part);
        newMesh.position.set(n.x * WorldMap.TILE_SIZE, 0, n.z * WorldMap.TILE_SIZE);
        this.scene.add(newMesh);
        n.mesh = newMesh;
      }
    });
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
    tile.switchGroupOrigin = undefined;
    tile.slopeReversed = undefined;
    tile.slopePart = undefined;
  }

  /**
   * ⑤ 撤去は常にクリックした「そのマス1つだけ」を対象とする（分岐器・勾配グループでも一括撤去はしない）。
   * 分岐器グループの一員を撤去した場合、残りのマスはグループから独立した単体の線路として残る。
   */
  public demolishTile(x: number, z: number): boolean {
    const tile = this.getTile(x, z);
    if (!tile || tile.type === 'empty') return false;

    if (tile.switchGroupOrigin) {
      const hub = tile.type.startsWith('point_switch')
        ? tile
        : this.getTile(tile.switchGroupOrigin.x, tile.switchGroupOrigin.z);
      if (hub) {
        const forward = ((hub.rotation % 4) + 4) % 4;
        const right = WorldMap.rotateCW(forward);
        const fVec = WorldMap.DIRS[forward];
        const rVec = WorldMap.DIRS[right];
        const group = [
          { x: hub.x, z: hub.z },
          { x: hub.x + fVec.x, z: hub.z + fVec.z },
          { x: hub.x + rVec.x, z: hub.z + rVec.z },
          { x: hub.x + fVec.x + rVec.x, z: hub.z + fVec.z + rVec.z }
        ];
        for (const p of group) {
          if (p.x === x && p.z === z) continue;
          const t = this.getTile(p.x, p.z);
          if (t) t.switchGroupOrigin = undefined; // グループから独立させるのみ（撤去はしない）
        }
      }
    }

    const prevType = tile.type;
    const rot = tile.rotation;
    this.resetTileData(tile);

    // Update neighboring stations if demolished tile was a station
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
      // 分岐器のthrough/leg部品は起点(ハブ)から復元可能なため保存対象から除外
      if (t.switchGroupOrigin && !t.type.startsWith('point_switch')) return;
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
          slopePart: t.slopePart
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
          } else if (item.type.startsWith('rail_curve') && item.curveDir !== undefined) {
            this.placeCurve(item.x, item.z, item.curveDir, item.type.includes('elevated'));
          } else if (item.type === 'rail_slope') {
            // 各マスを個別に復元する（グループの一部が撤去され欠けていても復元できるように）
            const tile = this.getTile(item.x, item.z);
            if (tile) {
              this.applySlopeTile(tile, item.rot || 0, !!item.slopeRev, item.slopePart || 0);
            }
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
