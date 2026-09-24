import * as THREE from 'three';
import { WorldMap, TileData, SwitchState, CrossingState, StationActionMode, DepartureRule, SplitConfig, getSwitchDirectionAtTime } from './WorldMap';
import { ModelFactory } from '../models/ModelFactory';
import { AudioManager } from '../engine/AudioManager';
import { FollowTarget } from '../graphics/CameraManager';
import { VehicleModelInfo, getVehicleById } from './VehicleCatalog';
import { BlockSignalManager } from '../core/BlockSignal';
import { GridLayer, DeadlockEvent } from '../core/types';
import { layerToHeight } from '../core/Grid3D';
import { GRID_LAYERS } from '../core/constants';
import { CARGO_FARE_PER_CONTAINER_PER_TILE } from '../core/CargoSystem';
import * as ScheduleEngine from '../core/ScheduleEngine';
import { checkCoupleEligibility, validateSplitConfig } from '../core/CouplingSystem';
import { disposeHierarchy } from '../graphics/materials';
import { VehicleMeshBuilder } from '../graphics/vehicles/VehicleMeshBuilder';

// ④ 先頭車の走行履歴サンプル（各車両がこの履歴を「車両間隔ぶん遅れて」辿ることで、
// カーブや勾配・進路変更を編成全体が一斉にではなく1両ずつ順番に通過するようにする）
interface PathSample {
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  cant: number;
  dist: number; // 経路の始点からの累積距離（ワールド単位）
  layer: GridLayer; // 車両が存在する階層
}

export interface TrainInstance {
  id: number;
  name: string;
  model: VehicleModelInfo;
  carCount: number;
  mesh: THREE.Group; // ④ 常に position/rotation ともに単位変換（子の各車両をワールド座標で個別配置する）
  frontPosition: THREE.Vector3; // ④ 先頭車の現在位置（カメラ追従・ATS判定に使用）
  currentTile: { x: number; z: number; layer: GridLayer }; // ④ 先頭車が今いるタイルと階層
  targetTile: { x: number; z: number; layer: GridLayer }; // ④ 先頭車が次に向かうタイルと階層
  direction: THREE.Vector3;
  progress: number;
  speed: number; // tiles per second
  isStopped: boolean;
  isAtsBraked: boolean; // ⑥ ATSによる先行列車接近停止
  isSignalStopped?: boolean; // 閉塞信号による停止
  isTrapped?: boolean; // 孤立（前後とも進行不能）による立ち往生停止
  occupiedTiles: Array<{ x: number; z: number; layer: GridLayer }>; // 最大10両全マスの占有タイル
  stopTimer: number;
  passengers: number;
  capacity: number;
  isReversed: boolean;
  cars: THREE.Group[];
  heightY: number; // Current vertical elevation
  pathHistory: PathSample[]; // ④ 先頭車の走行履歴（各車両の遅延追従に使用）

  // ⑤ 列車収支・乗客データ
  totalPassengers: number;
  totalRevenue: number;
  totalCost: number;
  monthlyProfit: number;
  fleetId?: string; // ⑦ 車両基地での保有ID

  // ⑤ 駅グループ重複停車防止用
  lastStationGroupId: string | null;
  // ② 駅ダイヤ（折り返し待機、定時発車待機）
  isReversingAtStation?: boolean;
  scheduledDepartureMinute?: number | null;

  // ④ 貨物列車の積荷状態（category: 'freight' の編成のみ使用）
  cargoLoad?: number;
  cargoCapacity?: number;
  cargoPickup?: { x: number; z: number } | null;
  cargoTraveledTiles?: number; // 積載中の実走行マス数（運賃計算用）

  // Phase3: 純粋時間軸ダイヤエンジン用の停車状態追跡
  stopMode?: StationActionMode | null; // 現在停車中の動作モード（'hold'は毎フレーム再判定）
  stopElapsedMinutes?: number; // 現在の停車開始からの経過ゲーム内分
  requiredStopMinutes?: number; // 発車可能になるまでの最短停車分数
  // Phase3: 分割後の編成に個別付与される発車ルール（未設定時はホームタイルの共通ダイヤに従う）
  overrideDepartureRule?: DepartureRule | null;
}

/** 貨物駅での積み降ろし・運賃計算をTrainManagerへ橋渡しするフック群 */
export interface CargoHooks {
  tryLoad: (x: number, z: number, capacity: number, layer?: GridLayer) => number;
  tryUnload: (x: number, z: number, containers: number, layer?: GridLayer) => number | boolean;
  isCommercialStation?: (x: number, z: number, layer?: GridLayer) => boolean;
  onStationCargoChanged?: (x: number, z: number, layer?: GridLayer) => void;
}

export class TrainManager {
  private trains: TrainInstance[] = [];
  public blockSignalManager: BlockSignalManager = new BlockSignalManager();
  public onDeadlockDetected?: (event: DeadlockEvent) => void;
  public onTrainSplit?: (parentTrain: TrainInstance, splitTrain: TrainInstance) => void;
  public onTrainCoupled?: (leaderTrain: TrainInstance, followerTrain: TrainInstance) => void;
  private scene: THREE.Scene;
  private worldMap: WorldMap;
  private audioManager: AudioManager;
  private nextTrainId: number = 1;
  private soundTimer: number = 0;
  private listenerPosition: { x: number; z: number } = { x: 0, z: 0 };
  // 高倍速・フレームスキップ時の発車時刻すり抜け防止用（前フレーム時刻追跡）
  private lastUpdateHour: number = -1;
  private lastUpdateMinute: number = -1;

  constructor(scene: THREE.Scene, worldMap: WorldMap, audioManager: AudioManager) {
    this.scene = scene;
    this.worldMap = worldMap;
    this.audioManager = audioManager;
    this.blockSignalManager.onDeadlockDetected = (event) => {
      if (this.onDeadlockDetected) {
        this.onDeadlockDetected(event);
      }
    };
  }

  /**
   * 3D空間音響用カメラ注視点（画面中央）の登録
   */
  public setListenerPosition(pos: { x: number; z: number }): void {
    this.listenerPosition = pos;
  }

  /**
   * 注視点からの距離減衰係数（0.0〜1.0）を算出
   */
  public getDistanceFactor(pos: { x: number; z: number }): number {
    const dx = pos.x - this.listenerPosition.x;
    const dz = pos.z - this.listenerPosition.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist <= 12) return 1.0;
    return Math.max(0.0, 1.0 / (1.0 + (dist - 12) * 0.05));
  }

  public getTrains(): TrainInstance[] {
    return this.trains;
  }

  public getTrainById(id: number): TrainInstance | undefined {
    return this.trains.find(t => t.id === id);
  }

  /**
   * ⑤ & ⑦ スポーン（車種・両数・初期進行方向・保有ID指定）
   */
  public spawnTrain(
    x: number,
    z: number,
    modelInfo: VehicleModelInfo = getVehicleById('commuter-train'),
    carCount: number = 3,
    initialDirIdx?: number,
    fleetId?: string,
    layer?: GridLayer
  ): TrainInstance | null {
    const spawnLayer: GridLayer = layer ?? (this.worldMap.getTile(x, z)?.layer ?? this.worldMap.activeLayer);
    const tile = this.worldMap.getTile(x, z, spawnLayer);
    if (!tile || !this.isTrackTile(tile)) {
      return null;
    }

    const elevOffset = tile.elevationOffset ?? 0;
    const baseHeight = layerToHeight(spawnLayer, elevOffset);

    // Build 3D formation using ModelFactory
    const { group: trainGroup, cars } = ModelFactory.createTrainFormation(modelInfo, carCount);
    this.scene.add(trainGroup);

    const spawnPos = new THREE.Vector3(x * WorldMap.TILE_SIZE, baseHeight, z * WorldMap.TILE_SIZE);
    const exits = WorldMap.getTileExits(tile);
    let chosenDirIdx: number;
    if (initialDirIdx !== undefined) {
      chosenDirIdx = initialDirIdx;
    } else {
      chosenDirIdx = exits.length > 0 ? exits[0].idx : (tile.rotation === 1 ? 1 : 2);
    }
    const dirVec = WorldMap.DIRS[chosenDirIdx];
    const dir = new THREE.Vector3(dirVec.x, 0, dirVec.z).normalize();
    const nextTile = this.findNextTrackTile(x, z, spawnLayer, dir, true);

    // 基準移動速度 (マス/分 = 等速時のマス/秒)
    const speedTilesPerSec = modelInfo.speedTilesPerMinute ?? 1.5;
    const initialYaw = Math.atan2(dir.x, dir.z);

    cars.forEach((car, i) => {
      car.rotation.order = 'YXZ';
      car.position.copy(spawnPos).addScaledVector(dir, -i * ModelFactory.CAR_SPACING);
      car.rotation.set(0, initialYaw, 0);
    });

    // ③ 列車誕生時の「ブラックホール収縮」バグ解消:
    // スポーン時に進行方向の逆向きに「最後尾 (i = carCount - 1) から先頭 (i = 0)」までの
    // 走行履歴配列（累積距離付き）を事前生成し、各車両が1点に圧縮されるのを完全に防止する
    const initialHistory: PathSample[] = [];
    let accumDist = 0;
    for (let i = carCount - 1; i >= 0; i--) {
      const pos = spawnPos.clone().addScaledVector(dir, -i * ModelFactory.CAR_SPACING);
      if (initialHistory.length > 0) {
        accumDist += pos.distanceTo(initialHistory[initialHistory.length - 1].pos);
      }
      initialHistory.push({
        pos,
        yaw: initialYaw,
        pitch: 0,
        cant: 0,
        dist: accumDist,
        layer: spawnLayer
      });
    }

    const trainId = this.nextTrainId++;
    const nextLayer: GridLayer = (nextTile?.layer ?? spawnLayer) as GridLayer;
    const train: TrainInstance = {
      id: trainId,
      name: `${modelInfo.name} ${trainId}号`,
      model: modelInfo,
      carCount,
      mesh: trainGroup,
      frontPosition: spawnPos.clone(),
      currentTile: { x, z, layer: spawnLayer },
      targetTile: nextTile ? { x: nextTile.x, z: nextTile.z, layer: nextLayer } : { x, z, layer: spawnLayer },
      direction: dir,
      progress: 0,
      speed: speedTilesPerSec,
      isStopped: false,
      isAtsBraked: false,
      isSignalStopped: false,
      occupiedTiles: [{ x, z, layer: spawnLayer }],
      stopTimer: 0,
      passengers: 0,
      capacity: modelInfo.category === 'freight' ? 0 : modelInfo.baseCapacity * carCount,
      isReversed: false,
      cars,
      heightY: baseHeight,
      pathHistory: initialHistory,
      totalPassengers: 0,
      totalRevenue: 0,
      totalCost: 0,
      monthlyProfit: 0,
      fleetId,
      lastStationGroupId: null,
      cargoLoad: 0,
      cargoCapacity: modelInfo.category === 'freight' ? Math.max(0, (carCount - 1) * 3) : 0,
      cargoPickup: null,
      cargoTraveledTiles: 0,
      stopMode: null,
      stopElapsedMinutes: 0,
      requiredStopMinutes: 0,
      overrideDepartureRule: null
    };

    // 初期配置の物理姿勢・占有タイルを即座に確定
    this.applyCarTransforms(train);
    train.occupiedTiles = this.calculateOccupiedTiles(train);

    // 貨物列車は購入・配置時点でコンテナ積載数0（空荷・緊締装置のみ表示）
    if (modelInfo.category === 'freight') {
      VehicleMeshBuilder.updateTrainCargoVisual(train.cars, 0);
    }

    this.trains.push(train);
    this.audioManager.playHorn();
    return train;
  }

  /**
   * ワールド座標系のベクトルを最も近い方向インデックス(0=北,1=東,2=南,3=西)に丸める
   */
  private vecToDirIdx(v: THREE.Vector3): number {
    let best = 0;
    let bestDot = -Infinity;
    for (let i = 0; i < 4; i++) {
      const d = WorldMap.DIRS[i];
      const dot = v.x * d.x + v.z * d.z;
      if (dot > bestDot + 1e-4) {
        bestDot = dot;
        best = i;
      }
    }
    return best;
  }

  /**
   * ①③⑦⑧ 実際の線路接続（向き・曲線・勾配レベル・ポイント開通方向）に基づく次タイル探索。
   *
   * ③ 現在タイルが持つ出口は常に高々2方向（進入側=back とその先=forward）であり、
   * 「進入してきた方向の反対（back）」を除いた残りの出口だけが、実際に進める唯一の方向になる。
   * 単に列車の現在の向き（ヘディング）から直進・右・左を試すと、向きが合っていない直線レールでも
   * たまたま90度方向の出口と一致してしまい誤って接続扱いになるため、この方式は採らない。
   * 隣接タイル側にも back 方向の受け口が存在し、かつ双方の高さレベルが一致しない限り「未接続」とし、
   * 有効な接続先が一つも見つからない場合は null を返す（呼び出し側で列車を折り返させる）。
   */
  private findNextTrackTile(currX: number, currZ: number, currLayer: GridLayer, currentDir: THREE.Vector3, isSpawn: boolean = false): TileData | null {
    const curTile = this.worldMap.getTile(currX, currZ, currLayer);
    if (!curTile) return null;

    const curExits = WorldMap.getTileExits(curTile);
    if (curExits.length === 0) return null;

    const headingIdx = this.vecToDirIdx(currentDir);

    let candidateIdxs: number[];
    if (isSpawn) {
      // スポーン時は「進入してきた方向」が存在しないため、現在の向きに一致する出口を優先する
      const matching = curExits.find(e => e.idx === headingIdx);
      candidateIdxs = matching ? [matching.idx] : curExits.map(e => e.idx);
    } else if (curTile.type.startsWith('point_switch')) {
      // ③ 分岐器の場合: 進入方向(incomingSide)によって直進・分岐または合流(back)を決定
      const incomingSide = WorldMap.opposite(headingIdx);
      const forward = ((curTile.rotation % 4) + 4) % 4;
      const back = WorldMap.opposite(forward);
      const branchDir = curTile.switchBranchSide === 'left' ? WorldMap.rotateCCW(forward) : WorldMap.rotateCW(forward);

      if (incomingSide === forward || incomingSide === branchDir) {
        // 合流進入（背向進入）：直進側または分岐側から進入してきた場合は、分岐条件を無視して合流方向（根元=back）へ進行
        candidateIdxs = [back];
      } else {
        // 根元側から進入（対向進入）：現在の開通状態に従って直進または分岐へ進行
        const targetExit = curTile.switchState === 'diverge' ? branchDir : forward;
        candidateIdxs = [targetExit];
      }
    } else {
      // currentDir は「このタイルに進入してきた時の向き」＝back方向はその反対
      const backIdx = WorldMap.opposite(headingIdx);
      const forward = curExits.filter(e => e.idx !== backIdx).map(e => e.idx);
      candidateIdxs = forward.length > 0 ? forward : curExits.map(e => e.idx);
    }

    for (const idx of candidateIdxs) {
      const exit = curExits.find(e => e.idx === idx);
      if (!exit) continue;

      let nx: number;
      let nz: number;
      if (exit.targetOffset) {
        // ② シーサスクロッシング等の対角渡り線（A⇄D、C⇄B）への直接移動
        nx = currX + exit.targetOffset.dx;
        nz = currZ + exit.targetOffset.dz;
      } else {
        const d = WorldMap.DIRS[idx];
        nx = currX + d.x;
        nz = currZ + d.z;
      }

      const backIdx = WorldMap.opposite(idx);

      // まず現在のレイヤーで隣接タイルを探索
      let neighbor = this.worldMap.getTile(nx, nz, currLayer);
      let nExits = neighbor && this.isTrackTile(neighbor) ? WorldMap.getTileExits(neighbor) : [];
      let nExit = nExits.find(e => e.idx === backIdx);

      // 同一レイヤーで接続先が見つからない場合、上下階層（スロープ境界等）を探索
      if (!nExit) {
        for (const candLayer of GRID_LAYERS) {
          if (candLayer === currLayer) continue;
          const candTile = this.worldMap.getTile(nx, nz, candLayer);
          if (!candTile || !this.isTrackTile(candTile)) continue;
          const candExits = WorldMap.getTileExits(candTile);
          const candExit = candExits.find(e => e.idx === backIdx);
          if (candExit) {
            // 高さが一致するかチェック
            if (exit.worldHeight !== undefined && candExit.worldHeight !== undefined) {
              if (Math.abs(exit.worldHeight - candExit.worldHeight) <= 0.05) {
                neighbor = candTile;
                nExits = candExits;
                nExit = candExit;
                break;
              }
            } else if (exit.level === candExit.level) {
              neighbor = candTile;
              nExits = candExits;
              nExit = candExit;
              break;
            }
          }
        }
      }

      if (!neighbor || !nExit) continue; // 隣接タイル側がこちらを向いて接続していない（向き違い・分岐未開通など）

      // ① 階層・標高・レベルの接続判定（高さが異なる線路同士は接続しない）
      if (exit.worldHeight !== undefined && nExit.worldHeight !== undefined) {
        if (Math.abs(exit.worldHeight - nExit.worldHeight) > 0.05) {
          continue; // 山の上と平地など、高さが合っていない場合は接続しない（崖落下防止）
        }
      } else if (nExit.level !== exit.level) {
        continue; // レベル不一致
      }

      return neighbor;
    }

    return null; // 有効な接続なし = 列車は折り返す
  }

  /**
   * 次に進むべきタイルを決定し、方向・目標タイルを更新する。接続先が無ければ（デッドエンド）
   * その場で折り返す。停車中の列車に対しては、発車が確定した瞬間にのみ呼び出すこと。
   */
  private resolveNextTileOrReverse(train: TrainInstance): void {
    const next = this.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer, train.direction);
    if (next) {
      let newDir = new THREE.Vector3(next.x - train.currentTile.x, 0, next.z - train.currentTile.z).normalize();
      // ③ シーサスクロッシング通過後の「方向喪失・横滑り」防止:
      // 対角移動（斜め45度）の場合、進行方向ベクトルに斜め成分が残ると vecToDirIdx で方位誤認を起こすため、
      // クロッシングの主線軸（cardinal direction）に強制補正する
      if (Math.abs(newDir.x) > 0.01 && Math.abs(newDir.z) > 0.01) {
        const curTile = this.worldMap.getTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
        const nextTile = this.worldMap.getTile(next.x, next.z, (next.layer ?? train.currentTile.layer) as GridLayer);
        const scissorsTile = (curTile && curTile.type.startsWith('scissors_crossing')) ? curTile : nextTile;
        if (scissorsTile && scissorsTile.type.startsWith('scissors_crossing')) {
          const along = scissorsTile.rotation === 1 ? 1 : 2;
          const alongVec = WorldMap.DIRS[along];
          const dot = newDir.x * alongVec.x + newDir.z * alongVec.z;
          const finalIdx = dot >= 0 ? along : WorldMap.opposite(along);
          const cardinalDir = WorldMap.DIRS[finalIdx];
          newDir = new THREE.Vector3(cardinalDir.x, 0, cardinalDir.z);
        } else {
          const bestIdx = this.vecToDirIdx(newDir);
          const cardinalDir = WorldMap.DIRS[bestIdx];
          newDir = new THREE.Vector3(cardinalDir.x, 0, cardinalDir.z);
        }
      }
      train.isTrapped = false;
      train.direction.copy(newDir);
      train.targetTile = { x: next.x, z: next.z, layer: (next.layer ?? train.currentTile.layer) as GridLayer };
    } else {
      // ④ 折り返し（デッドエンド）:
      // 【無限反転ループ解消】反対方向（反転先）にも線路が存在するか事前に確認
      const reverseDir = train.direction.clone().negate();
      const carCount = train.carCount;
      const lagDist = (carCount - 1) * ModelFactory.CAR_SPACING;
      const oldRearSample = this.sampleHistoryAtLag(train.pathHistory, lagDist);
      const rearX = Math.round(oldRearSample.pos.x / WorldMap.TILE_SIZE);
      const rearZ = Math.round(oldRearSample.pos.z / WorldMap.TILE_SIZE);
      const reverseNext = this.findNextTrackTile(rearX, rearZ, train.currentTile.layer, reverseDir, true);

      if (reverseNext) {
        // 反対側に進める線路がある場合は正常に反転
        train.isTrapped = false;
        this.reverseTrainDirection(train);
      } else {
        // 前後両方向とも線路がない（孤立・線路分断）: 反転ループを遮断して安全に停止
        train.isTrapped = true;
        train.speed = 0;
        train.progress = 0;
        train.targetTile = { ...train.currentTile };
      }
    }
  }

  private isTrackTile(t: TileData): boolean {
    return (
      t.type.includes('rail') ||
      t.type.includes('station') ||
      t.type === 'signal_yard' ||
      t.type.includes('point_switch') ||
      t.type.includes('scissors_crossing') ||
      t.type === 'level_crossing' ||
      t.type.includes('slope')
    );
  }

  /**
   * ⑥ ATS（先行列車検知・自動停止・閉塞制御）
   */
  private checkAtsCollisionAvoidance() {
    for (let i = 0; i < this.trains.length; i++) {
      const trainA = this.trains[i];
      if (!trainA || !trainA.occupiedTiles || trainA.occupiedTiles.length === 0) continue;
      // 停車中の列車は既に停止しているため、ATS緊急ブレーキ判定の対象外
      if (trainA.isStopped) {
        trainA.isAtsBraked = false;
        continue;
      }
      let mustStop = false;

      for (let j = 0; j < this.trains.length; j++) {
        if (i === j) continue;
        const trainB = this.trains[j];
        if (!trainB || !trainB.occupiedTiles || trainB.occupiedTiles.length === 0) continue;

        // ① 別線路（複線など）の列車に対する立ち往生（ATS誤爆）を防止
        // 占有しているタイル（現在地・目標・全車両）が1つも被っていなければ完全に別線路とみなす
        let isSharingTile = false;
        for (const ta of trainA.occupiedTiles) {
          for (const tb of trainB.occupiedTiles) {
            if (ta.x === tb.x && ta.z === tb.z && ta.layer === tb.layer) {
              isSharingTile = true;
              break;
            }
          }
          if (isSharingTile) break;
        }

        // 別線路であれば完全に衝突判定から除外する
        if (!isSharingTile) continue;

        // 先行列車 trainB のすべての車体ポイント（先頭＋各車両位置）を走査
        const checkPoints = [trainB.frontPosition, ...trainB.cars.map(c => c.position)];
        let closestDist = Infinity;
        let isAhead = false;

        for (const pt of checkPoints) {
          // ① 立体交差除外: 高度差（Y差）が1.5mを超えるポイントは高架上または地下の別階層なので衝突判定から除外
          if (Math.abs(trainA.frontPosition.y - pt.y) > 1.5) {
            continue;
          }

          // 水平距離（XZ平面）を算出
          const dx = pt.x - trainA.frontPosition.x;
          const dz = pt.z - trainA.frontPosition.z;
          const horizontalDist = Math.hypot(dx, dz);

          // 進行方向ベクトルとの内積（前方判定）
          const toPtHoriz = new THREE.Vector3(dx, 0, dz);
          const dot = toPtHoriz.dot(trainA.direction);

          if (dot > 0) {
            // trainA の進行方向前方にある同一階層の車体ポイント
            if (horizontalDist < closestDist) {
              closestDist = horizontalDist;
              isAhead = true;
            }
          } else if (horizontalDist < 2.0) {
            // 同一階層の至近距離接触（横やすれ違い・めり込み防止）
            if (horizontalDist < closestDist) {
              closestDist = horizontalDist;
            }
          }
        }

        // 前方に先行列車が存在し、かつ安全車間距離 (4.2m) 未満であれば ATS 発動
        if (isAhead && closestDist < 4.2) {
          if (this.canBypassAtsForCoupling(trainA, trainB)) {
            continue;
          }
          mustStop = true;
          break;
        }

        // 同一階層の極至近距離衝突防止 (2.0m未満)
        if (closestDist < 2.0) {
          if (this.canBypassAtsForCoupling(trainA, trainB)) {
            continue;
          }
          mustStop = true;
          break;
        }
      }

      trainA.isAtsBraked = mustStop;
    }
  }

  /**
   * Phase3 ①: 誘導信号モード判定
   * 後続(follower)が先行(leader)の停車中ホームへ安全に進入・連結できる場合のみ true を返す。
   * 「先行両数＋後続両数 ≤ 10両」かつ「合計両数 ≤ ホーム有効長」を満たさない場合は、
   * 通常のATS停止距離をそのまま適用し、手前で絶対停止させる。
   */
  private canBypassAtsForCoupling(follower: TrainInstance, leader: TrainInstance): boolean {
    if (!leader.isStopped) return false;

    const followerTile = this.worldMap.getTile(follower.currentTile.x, follower.currentTile.z, follower.currentTile.layer);
    const leaderTile = this.worldMap.getTile(leader.currentTile.x, leader.currentTile.z, leader.currentTile.layer);
    if (!followerTile || !leaderTile) return false;
    if (!leaderTile.type.startsWith('station')) return false; // 信号場・留置線での併合は対象外
    if (!followerTile.stationGroupId || followerTile.stationGroupId !== leaderTile.stationGroupId) return false;

    const effectiveLength = this.worldMap.getStationRunLength(leader.currentTile.x, leader.currentTile.z, leader.currentTile.layer) || 1;
    return checkCoupleEligibility(leader.carCount, follower.carCount, effectiveLength).eligible;
  }

  /**
   * タイルの種類・階層・標高オフセットに応じた接続高さを取得
   */
  private getTileInterpolatedHeight(t?: TileData, defaultLayer: GridLayer = 1): number {
    if (!t) return layerToHeight(defaultLayer);
    const elev = t.elevationOffset ?? 0;
    const tLayer = t.layer ?? defaultLayer;
    const baseH = layerToHeight(tLayer, elev);
    if (t.type === 'rail_slope') {
      const part = t.slopePart ?? 0;
      return baseH + (part + 0.5) * 0.75;
    }
    if (t.type === 'rail_slope_underground') {
      const part = t.slopePart ?? 0;
      return elev - (part + 0.5) * 0.75;
    }
    return baseH;
  }

  /**
   * 現在の progress に応じた先頭車のワールド位置 frontPosition を算出・更新
   */
  private updateTrainFrontPosition(train: TrainInstance): void {
    const fromTile = this.worldMap.getTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
    const toTile = this.worldMap.getTile(train.targetTile.x, train.targetTile.z, train.targetTile.layer);
    const fromH = this.getTileInterpolatedHeight(fromTile, train.currentTile.layer);
    const toH = this.getTileInterpolatedHeight(toTile, train.targetTile.layer);
    train.heightY = THREE.MathUtils.lerp(fromH, toH, train.progress);

    const fromPos = new THREE.Vector3(
      train.currentTile.x * WorldMap.TILE_SIZE,
      fromH,
      train.currentTile.z * WorldMap.TILE_SIZE
    );
    const toPos = new THREE.Vector3(
      train.targetTile.x * WorldMap.TILE_SIZE,
      toH,
      train.targetTile.z * WorldMap.TILE_SIZE
    );
    train.frontPosition.lerpVectors(fromPos, toPos, train.progress);
  }

  /**
   * メイン更新ループ
   */
  public update(
    deltaTime: number,
    speedMultiplier: number,
    onPassengerFare: (amount: number) => void,
    currentHour: number = 0,
    currentMinute: number = 0,
    getDemandMultiplier?: (x: number, z: number, hour: number) => number,
    cargoHooks?: CargoHooks
  ) {
    if (this.trains.length === 0 || speedMultiplier <= 0) return;

    const dt = deltaTime * speedMultiplier;

    // 【時空の歪み解消】サブステッピング（Sub-stepping）の導入
    // 10倍速＋フレーム落ち（0.1sフレームスキップ）等で1フレームに長距離ワープするのを防ぐため、
    // 1サブステップあたりの最大移動進行度を MAX_SUB_STEP_PROGRESS（0.25マス）に制限し、
    // 必要なサブステップ数に均等分割して物理・閉塞・ATS・駅判定を小刻みに確実に実行する。
    const MAX_SUB_STEP_PROGRESS = 0.25;
    let maxSpeed = 1.5;
    for (const t of this.trains) {
      if (t.speed > maxSpeed) maxSpeed = t.speed;
    }
    const maxProgressInFrame = maxSpeed * dt;
    const numSubSteps = Math.min(Math.max(1, Math.ceil(maxProgressInFrame / MAX_SUB_STEP_PROGRESS)), 10);
    const subDt = dt / numSubSteps;

    // Phase3 ①②: 併合で消滅する編成・分割で新規生成される編成は、ループ終了後にまとめて反映する
    const trainsPendingRemoval: number[] = [];
    const trainsPendingAdd: TrainInstance[] = [];

    // サブステップループ開始
    for (let step = 0; step < numSubSteps; step++) {
      // ① 最大10両編成の全マス在線ロック計算 ＆ 閉塞更新（消滅予定の幽霊列車を除外）
      const activeTrains = this.trains.filter(t => !trainsPendingRemoval.includes(t.id));
      for (const train of activeTrains) {
        train.occupiedTiles = this.calculateOccupiedTiles(train);
      }
      this.blockSignalManager.updateOccupancy(
        activeTrains.map(t => ({
          id: t.id,
          name: t.name,
          carCount: t.carCount,
          occupiedTiles: t.occupiedTiles,
          isStopped: !!(t.isStopped || t.isSignalStopped || t.isAtsBraked || t.isTrapped),
          isDeadlocked: !!((t.isSignalStopped || t.isAtsBraked || t.isTrapped) && !t.isStopped),
          speed: t.speed
        })),
        subDt
      );

      // ⑥ ATS 衝突防止チェック（サブステップ毎に評価し、すり抜けを完全防止）
      this.checkAtsCollisionAvoidance();

      for (const train of this.trains) {
        if (trainsPendingRemoval.includes(train.id)) continue;

        // 【無限反転ループ解消】孤立状態の復帰チェック
        if (train.isTrapped) {
          const forwardNext = this.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer, train.direction);
          if (forwardNext) {
            train.isTrapped = false;
            train.speed = train.model.speedTilesPerMinute ?? 1.5;
            this.resolveNextTileOrReverse(train);
          } else {
            const reverseDir = train.direction.clone().negate();
            const carCount = train.carCount;
            const lagDist = (carCount - 1) * ModelFactory.CAR_SPACING;
            const oldRearSample = this.sampleHistoryAtLag(train.pathHistory, lagDist);
            const rearX = Math.round(oldRearSample.pos.x / WorldMap.TILE_SIZE);
            const rearZ = Math.round(oldRearSample.pos.z / WorldMap.TILE_SIZE);
            const reverseNext = this.findNextTrackTile(rearX, rearZ, train.currentTile.layer, reverseDir, true);
            if (reverseNext) {
              train.isTrapped = false;
              train.speed = train.model.speedTilesPerMinute ?? 1.5;
              this.reverseTrainDirection(train);
            } else {
              // 依然として孤立中：進行を安全にスキップ
              continue;
            }
          }
        }
      // ① Station stop & Timed departure（Phase3: ホーム単位の純粋時間軸ダイヤエンジンで判定）
      // 【論理停止バグ解消】赤信号であっても駅の停車タイマー（stopElapsedMinutes）を凍結させず正常に進行させる
      if (train.isStopped) {
        train.stopElapsedMinutes = (train.stopElapsedMinutes ?? 0) + subDt;

        const stoppedTile = this.worldMap.getTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
        const liveSchedule = stoppedTile?.stationSchedule;
        const mode = train.stopMode ?? 'stop';
        const required = train.requiredStopMinutes ?? 0;

        // 分割編成に個別付与された発車ルールがあれば、ホーム共通ダイヤより優先する
        // 既に発車可能状態に達して出発信号待ちだった編成は発車権を継続
        let canDeparture = !!train.isSignalStopped;
        let shouldReverse = !!train.isReversingAtStation;

        if (!canDeparture) {
          if (train.overrideDepartureRule) {
            const rule = train.overrideDepartureRule;
            const currentTotalMin = ((currentHour % 24) * 60 + currentMinute) % 1440;
            const prevTotal = this.lastUpdateHour >= 0
              ? ((this.lastUpdateHour % 24) * 60 + this.lastUpdateMinute) % 1440
              : currentTotalMin;

            if (rule.mode === 'timer') {
              canDeparture = (train.stopElapsedMinutes ?? 0) >= required;
            } else if (rule.mode === 'pattern') {
              const patMin = rule.patternMinute ?? 0;
              canDeparture = ScheduleEngine.isPatternMinuteInRange(prevTotal, currentTotalMin, patMin);
            } else if (rule.mode === 'specific') {
              const specMin = (((rule.specificHour ?? 0) % 24) * 60 + (rule.specificMinute ?? 0)) % 1440;
              canDeparture = ScheduleEngine.isMinuteInRange(prevTotal, currentTotalMin, specMin);
            }
          } else {
            // ホーム共通ダイヤの動的リアルタイム評価（日またぎ・パターン・停車時間・折り返し対応・フレームスキップ対応）
            const evalResult = ScheduleEngine.evaluateStationDeparture(
              liveSchedule,
              currentHour,
              currentMinute,
              train.stopElapsedMinutes ?? 0,
              mode,
              required,
              shouldReverse,
              this.lastUpdateHour,
              this.lastUpdateMinute
            );
            canDeparture = evalResult.canDepart;
            shouldReverse = evalResult.shouldReverse;
          }
        }

        if (canDeparture) {
          // 出発信号機判定: 発車先の目標閉塞が青信号になるまで駅ホームで安全に待機（停止維持）
          const toLayer = train.targetTile.layer;
          const canEnter = this.blockSignalManager.canEnterTile(train.id, train.targetTile.x, train.targetTile.z, toLayer);
          if (!canEnter) {
            train.isSignalStopped = true;
            continue; // 出発信号が赤なので発車保留
          }

          train.isSignalStopped = false;
          train.isStopped = false;
          train.stopMode = null;
          train.stopElapsedMinutes = 0;
          train.overrideDepartureRule = null;
          this.audioManager.playStationBell();

          // 駅折り返しダイヤの場合: 進行方向と反対側の先頭車両が新先頭になり逆走開始
          if (shouldReverse) {
            train.isReversingAtStation = false;
            this.reverseTrainDirection(train);
          } else {
            // Phase3: 発車が確定したこの瞬間に、はじめて進路（次のタイル）を決定する
            this.resolveNextTileOrReverse(train);
          }
        }
        continue;
      }

      // 閉塞信号による走行中の停止判定（赤信号の場合は閉塞手前で自動停止）
      const toLayer = train.targetTile.layer;
      const canEnterBlock = this.blockSignalManager.canEnterTile(train.id, train.targetTile.x, train.targetTile.z, toLayer);
      if (!canEnterBlock) {
        train.isSignalStopped = true;
        continue;
      } else {
        train.isSignalStopped = false;
      }

      // ⑥ ATS brake engaged
      if (train.isAtsBraked) {
        continue;
      }

      // Advance train by subDt
      train.progress += (train.speed * subDt);

      if (train.progress >= 1.0) {
        train.progress -= 1.0;
        if (train.progress >= 1.0) {
          train.progress = 0.999;
        }
        train.currentTile = { ...train.targetTile };

        // 貨物積載中は実走行マス数をインクリメント（正当な距離運賃を計算するため）
        if ((train.cargoLoad ?? 0) > 0) {
          train.cargoTraveledTiles = (train.cargoTraveledTiles ?? 0) + 1;
        }

        const curTileData = this.worldMap.getTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);

        // ⑤ 駅・信号場・貨物駅ホーム到着・停車判定（複数マス駅の奥側停車 ＆ 10分単位ダイヤ判定）
        const isStationOrYard = curTileData && WorldMap.isStationTileType(curTileData.type);
        let wasAbsorbedByCoupling = false;
        if (isStationOrYard && curTileData) {
          const isYard = curTileData.type === 'signal_yard';
          const isCargo = curTileData.type.startsWith('cargo_station') || !!curTileData.isCargoYard;
          const isFreight = train.model.category === 'freight';
          const stGroupId = curTileData.stationGroupId || (() => {
            const st = this.worldMap.getStationStartTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
            return st ? `st_${st.x}_${st.z}` : `st_${train.currentTile.x}_${train.currentTile.z}`;
          })();

          // ⑥ 次のマスを先読みし、次もまだ同じ駅グループのマスかを確認
          const peekNext = this.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer, train.direction);
          const nextIsSameStation = !!(peekNext && WorldMap.isStationTileType(peekNext.type) && (
            peekNext.stationGroupId === stGroupId || (!peekNext.stationGroupId && !curTileData.stationGroupId)
          ));

          // ⑥ 複数マス駅の場合、手前側1マス目ではなくホームの最奥部（先端）に達した時に停車判定
          if (!nextIsSameStation && train.lastStationGroupId !== stGroupId) {
            train.lastStationGroupId = stGroupId;

            // ① 要件(1): ホーム有効長（1〜10両）の安全進入判定
            // 「ホーム有効長 ＜ 編成長」の列車が進入した場合は、客扱い停止（過走・ホームはみ出し）防止のため
            // シンプルに「停車不可（通過扱い）」とする安全判定
            const effectiveLength = this.worldMap.getStationRunLength(train.currentTile.x, train.currentTile.z, train.currentTile.layer)
              || curTileData.stationTargetLength
              || 1;
            let isTooLong = train.carCount > effectiveLength;

            if (!peekNext || isCargo || isYard) {
              // ② 行き止まり（デッドエンド）の場合、または貨物駅・信号場の場合は、
              // 旅客ホームドア・乗降ステップのような制約がなく、ヤード・留置線全体で荷役・待避作業を行うため、
              // 編成が指定有効長を超えていても確実に停車を許容する
              isTooLong = false;
            }

            // Phase3 ①: ホーム単位の純粋時間軸ダイヤエンジンで、現在時刻から今回の動作モードを決定する
            const schedule = curTileData.stationSchedule;
            const rawArrival = ScheduleEngine.resolveArrival(schedule, currentHour, currentMinute);
            if (isTooLong) {
              rawArrival.mode = 'pass';
              rawArrival.requiredStopMinutes = 0;
            }

            // 列車種別と駅種別の適合判定
            let arrival = rawArrival;
            if (rawArrival.mode !== 'pass') {
              // 貨物駅に旅客列車が進入した場合: 旅客用設備がないため客扱いせず通過
              if (isCargo && !isFreight) {
                arrival = { ...rawArrival, mode: 'pass', requiredStopMinutes: 0 };
              }
              // 旅客駅に貨物列車が進入した場合: 荷扱い設備がないため客扱いせず通過
              else if (!isCargo && !isYard && isFreight) {
                arrival = { ...rawArrival, mode: 'pass', requiredStopMinutes: 0 };
              }
            }

            if (arrival.mode === 'pass') {
              // 通過ダイヤ、または有効長不足による安全通過: 停車せずそのまま通過
              // 【通過＋折り返し対応】通過設定かつ折り返しフラグが有効な場合、その場で進行方向を反転
              if (arrival.isReverse) {
                this.reverseTrainDirection(train);
              }
            } else {
              train.isStopped = true;
              train.progress = 0;

              // ② 貨物駅＋貨物列車の場合は、コンテナ積み降ろしを行う
              if (isCargo && isFreight && cargoHooks) {
                const isCommercial = cargoHooks.isCommercialStation
                  ? cargoHooks.isCommercialStation(train.currentTile.x, train.currentTile.z, train.currentTile.layer)
                  : false;

                // 【商業エリアの貨物駅】コンテナを積載していれば自動で全て荷降ろし＆販売
                if (isCommercial) {
                  if ((train.cargoLoad ?? 0) > 0) {
                    const toUnload = train.cargoLoad ?? 0;
                    const unloadResult = cargoHooks.tryUnload(train.currentTile.x, train.currentTile.z, toUnload, train.currentTile.layer);
                    const delivered = typeof unloadResult === 'number'
                      ? unloadResult
                      : (unloadResult ? toUnload : 0);

                    if (delivered > 0) {
                      // 【運賃錬金術（エクスプロイト）防止】
                      // マンハッタン距離×1.5＋4マスを上限キャップとし、駅手前での無限周回ループによる不正運賃増殖を完全に防止
                      const manhattanDist = train.cargoPickup
                        ? (Math.abs(train.currentTile.x - train.cargoPickup.x) + Math.abs(train.currentTile.z - train.cargoPickup.z))
                        : Math.min(train.cargoTraveledTiles ?? 1, 64);
                      const maxAllowedTiles = Math.max(1, Math.round(manhattanDist * 1.5) + 4);
                      const distanceTiles = Math.max(1, Math.min(train.cargoTraveledTiles ?? 1, maxAllowedTiles));
                      const revenue = Math.round(distanceTiles * delivered * CARGO_FARE_PER_CONTAINER_PER_TILE);
                      train.totalPassengers += delivered;
                      train.totalRevenue += revenue;
                      train.monthlyProfit = train.totalRevenue - train.totalCost;
                      if (revenue > 0) onPassengerFare(revenue);

                      train.cargoLoad = Math.max(0, (train.cargoLoad ?? 0) - delivered);
                      if (train.cargoLoad === 0) {
                        train.cargoPickup = null;
                        train.cargoTraveledTiles = 0;
                      }

                      curTileData.totalRevenue = (curTileData.totalRevenue ?? 0) + revenue;
                      curTileData.stationNetProfit = (curTileData.totalRevenue ?? 0) - (curTileData.stationMaintenance ?? 0);

                      // 【駅統計連携】貨物駅での運賃収入を StationManager に加算・同期
                      const platInfo = this.worldMap.stationManager.getPlatformByTile(
                        train.currentTile.x,
                        train.currentTile.z,
                        train.currentTile.layer
                      );
                      if (platInfo) {
                        this.worldMap.stationManager.addBoardingRecord(
                          platInfo.station.id,
                          platInfo.platform.id,
                          0,
                          revenue
                        );
                      }
                    }
                  }
                  // 荷降ろし後の残積載数に応じて貨車のコンテナ描写を同期更新
                  VehicleMeshBuilder.updateTrainCargoVisual(train.cars, train.cargoLoad ?? 0);
                } else {
                  // 【積み込み】商業エリア外の貨物駅（工業エリア等）でのみ、空き容量があり、駅にコンテナがあれば一括積載
                  const capacity = train.cargoCapacity ?? 0;
                  const freeSlots = capacity - (train.cargoLoad ?? 0);
                  if (freeSlots > 0) {
                    const loaded = cargoHooks.tryLoad(train.currentTile.x, train.currentTile.z, freeSlots, train.currentTile.layer);
                    if (loaded > 0) {
                      train.cargoLoad = (train.cargoLoad ?? 0) + loaded;
                      train.cargoPickup = { x: train.currentTile.x, z: train.currentTile.z };
                      train.cargoTraveledTiles = 0;
                      // 列車のコンテナ描写を積載数だけ増加
                      VehicleMeshBuilder.updateTrainCargoVisual(train.cars, train.cargoLoad);
                      // 駅のコンテナ描写を積載数だけ減少
                      cargoHooks.onStationCargoChanged?.(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
                    }
                  }
                }
              } else if (!isYard && !isCargo && !isFreight) {
                // 信号場・貨物駅以外の旅客駅かつ旅客列車の場合のみ、旅客処理を行う
                // ⑤ 要件⑤: 時間帯別・ゾーン方向別の乗客需要カーブ（朝夕ラッシュ多め、日中普通、深夜ほぼゼロ）
                const demandMult = getDemandMultiplier
                  ? getDemandMultiplier(train.currentTile.x, train.currentTile.z, currentHour)
                  : TrainManager.getHourlyDemandMultiplier(currentHour);
                const baseBoarding = (Math.floor(Math.random() * 60) + 70) * train.carCount;
                const boarding = Math.max(1, Math.round(baseBoarding * demandMult));
                const fare = Math.round(train.model.farePerRide * boarding);

                // 列車乗客数と収支の更新
                train.passengers = Math.min(train.capacity, Math.floor(boarding * 0.7) + Math.floor(train.passengers * 0.3));
                train.totalPassengers += boarding;
                train.totalRevenue += fare;
                train.monthlyProfit = train.totalRevenue - train.totalCost;

                // 駅乗客数と収支の更新
                curTileData.stationPassengers = boarding;
                curTileData.dailyPassengers = (curTileData.dailyPassengers ?? 0) + boarding;
                curTileData.totalPassengers = (curTileData.totalPassengers ?? 0) + boarding;
                curTileData.totalRevenue = (curTileData.totalRevenue ?? 0) + fare;
                curTileData.stationNetProfit = (curTileData.totalRevenue ?? 0) - (curTileData.stationMaintenance ?? 0);

                // 【駅の記憶喪失解消】駅グループ統計（StationManager）に乗降客数と運賃収入を加算・同期
                const platInfo = this.worldMap.stationManager.getPlatformByTile(
                  train.currentTile.x,
                  train.currentTile.z,
                  train.currentTile.layer
                );
                if (platInfo) {
                  this.worldMap.stationManager.addBoardingRecord(
                    platInfo.station.id,
                    platInfo.platform.id,
                    boarding,
                    fare
                  );
                }

                onPassengerFare(fare);
              }

              // Phase3 ②: 途中駅での分割（切り離し）判定
              const splitConfig = schedule?.splitConfig;
              const splitCheck = (!isYard && !isTooLong) ? validateSplitConfig(train.carCount, splitConfig) : { valid: false };

              if (splitCheck.valid && splitConfig) {
                const rearTrain = this.performSplit(train, splitConfig, curTileData);
                trainsPendingAdd.push(rearTrain);
              } else {
                // Phase3 ①: 併合（連結）判定。同一ホームに既に停車中の先行編成があれば合体する。
                const leader = !isYard
                  ? this.trains.find(other =>
                      other.id !== train.id &&
                      other.isStopped &&
                      this.worldMap.getTile(other.currentTile.x, other.currentTile.z, other.currentTile.layer)?.stationGroupId === stGroupId
                    )
                  : undefined;


                if (leader && checkCoupleEligibility(leader.carCount, train.carCount, effectiveLength).eligible) {
                  this.performCoupling(leader, train);
                  wasAbsorbedByCoupling = true;
                } else {
                  // 通常の単独停車
                  train.stopMode = arrival.mode;
                  train.stopElapsedMinutes = 0;
                  train.requiredStopMinutes = arrival.requiredStopMinutes;
                  train.isReversingAtStation = (arrival.mode === 'reverse') || !!arrival.isReverse;
                }
              }
            }
          }
        } else {
          // 駅以外のマスに出たら、駅グループIDを解除
          train.lastStationGroupId = null;
        }

        if (wasAbsorbedByCoupling) {
          // 吸収された幽霊列車が後続サブステップのATS・閉塞に干渉しないよう、即座にメッシュ解放＆在線クリアし除外
          this.disposeTrainMesh(train);
          train.occupiedTiles = [];
          train.speed = 0;
          train.isStopped = true;
          trainsPendingRemoval.push(train.id);
          this.trains = this.trains.filter(t => t.id !== train.id);
          continue;
        }

        // ①③ 分岐器・シーサスクロッシング通過時のダイヤ制御（タイムラインバー切替・交互切替・手動維持）
        if (curTileData && curTileData.type.startsWith('point_switch')) {
          const switchSched = curTileData.switchSchedule;
          if (switchSched) {
            if (switchSched.mode === 'alternate') {
              // 交互切替: 列車が通過するたびに直進⇄分岐を反転
              const nextState: SwitchState = curTileData.switchState === 'straight' ? 'diverge' : 'straight';
              this.worldMap.setSwitchState(train.currentTile.x, train.currentTile.z, nextState, train.currentTile.layer);
            } else if (switchSched.mode === 'timeline') {
              // タイムラインバー方式: 現在の指定開通方向に自動切り替え（デフォルト直進）
              const targetDir = getSwitchDirectionAtTime(switchSched, currentHour, currentMinute);
              this.worldMap.setSwitchState(train.currentTile.x, train.currentTile.z, targetDir as SwitchState, train.currentTile.layer);
            }
          }
        } else if (curTileData && curTileData.type.startsWith('scissors_crossing')) {
          // シーサスクロッシング通過時のダイヤ制御
          const origin = this.worldMap.resolveCrossingOrigin(train.currentTile.x, train.currentTile.z);
          const switchSched = origin?.switchSchedule;
          if (origin && switchSched && switchSched.mode === 'timeline') {
            const targetCrossing = getSwitchDirectionAtTime(switchSched, currentHour, currentMinute, true);
            this.worldMap.setCrossingState(origin.x, origin.z, targetCrossing as CrossingState);
          }
        }

        // Determine next tile
        // Phase3: 停車が確定した列車は、この時点ではまだ進路を決定しない（停車直後に折り返し処理が
        // 走ってしまい、分割・併合直後の編成の向きや位置が不正に乱れるのを防ぐため）。
        // 停車中の列車の進路は、実際に発車が確定した瞬間（下の isStopped ブロック内）に決定する。
        if (!train.isStopped) {
          this.resolveNextTileOrReverse(train);
        }
      }

      // 次サブステップのATS・閉塞判定のため、先頭車位置を更新
      this.updateTrainFrontPosition(train);
    }
  } // サブステップループ終了

    // 音声タイマー更新（フレーム単位で1回）
    this.soundTimer += dt;
    let closestTrain: TrainInstance | null = null;
    let closestDistFactor = 0;
    for (const train of this.trains) {
      if (train.speed > 0.05 && !train.isStopped) {
        const factor = this.getDistanceFactor({
          x: train.frontPosition.x,
          z: train.frontPosition.z
        });
        if (factor > closestDistFactor) {
          closestDistFactor = factor;
          closestTrain = train;
        }
      }
    }

    const effectiveSpeed = closestTrain ? (closestTrain.speed * speedMultiplier) : speedMultiplier;
    const intervalSec = 1.2 / Math.min(3.0, Math.max(0.6, effectiveSpeed));
    if (this.soundTimer >= intervalSec) {
      this.soundTimer = 0;
      if (closestTrain && closestDistFactor > 0.02) {
        const cTile = this.worldMap.getTile(closestTrain.currentTile.x, closestTrain.currentTile.z, closestTrain.currentTile.layer);
        const tTile = this.worldMap.getTile(closestTrain.targetTile.x, closestTrain.targetTile.z, closestTrain.targetTile.layer);

        // トンネル・地下判定
        const isTunnel = (closestTrain.currentTile.layer !== undefined && closestTrain.currentTile.layer < 0) ||
          this.worldMap.isTunnelSection(closestTrain.currentTile.x, closestTrain.currentTile.z, closestTrain.currentTile.layer);

        // 鉄橋判定（水上または地上2F以上の高架）
        const isWater = this.worldMap.gridManagerRef?.isWaterAtGroundLevel(closestTrain.currentTile.x, closestTrain.currentTile.z) ?? false;
        const isBridge = isWater || ((closestTrain.currentTile.layer ?? 1) >= 2);

        const env: 'normal' | 'bridge' | 'tunnel' = isTunnel ? 'tunnel' : (isBridge ? 'bridge' : 'normal');

        // 分岐器通過判定
        const isSwitch = (cTile?.type.includes('switch') || cTile?.type.includes('crossing') ||
                          tTile?.type.includes('switch') || tTile?.type.includes('crossing')) ?? false;

        this.audioManager.playJointSound(effectiveSpeed, env, isSwitch, closestDistFactor);
      }
    }

    // 車両姿勢・3D描画更新（全サブステップ完了後に1回のみ）
    for (const train of this.trains) {
      if (trainsPendingRemoval.includes(train.id)) continue;
      const fromTile = this.worldMap.getTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer);
      const toTile = this.worldMap.getTile(train.targetTile.x, train.targetTile.z, train.targetTile.layer);
      const fromH = this.getTileInterpolatedHeight(fromTile, train.currentTile.layer);
      const toH = this.getTileInterpolatedHeight(toTile, train.targetTile.layer);

      const yaw = train.direction.lengthSq() > 0.001
        ? Math.atan2(train.direction.x, train.direction.z)
        : (train.pathHistory[train.pathHistory.length - 1]?.yaw ?? 0);

      const heightDiff = toH - fromH;
      const pitch = Math.abs(heightDiff) > 0.05
        ? -Math.atan2(heightDiff, WorldMap.TILE_SIZE)
        : 0;

      const isCurving = fromTile?.type.includes('curve') || toTile?.type.includes('curve');
      const cant = isCurving ? 0.04 : 0;

      // 先頭車の現在位置に対応する階層を決定
      const currentHeadLayer: GridLayer = (train.progress < 0.5
        ? (train.currentTile.layer ?? 1)
        : (train.targetTile.layer ?? train.currentTile.layer ?? 1)) as GridLayer;

      this.recordPathSample(train, train.frontPosition, yaw, pitch, cant, currentHeadLayer);
      this.applyCarTransforms(train);
    }

    // Phase3 ①②: 併合で消滅した編成の除去、分割で生成された新編成の追加をループ終了後にまとめて反映
    if (trainsPendingRemoval.length > 0) {
      for (const remId of trainsPendingRemoval) {
        const remTrain = this.trains.find(t => t.id === remId);
        if (remTrain) {
          this.disposeTrainMesh(remTrain);
        }
        this.blockSignalManager.unregisterTrain(remId);
      }
      this.trains = this.trains.filter(t => !trainsPendingRemoval.includes(t.id));
    }
    if (trainsPendingAdd.length > 0) {
      this.trains.push(...trainsPendingAdd);
    }

    // 前フレームの時刻を記録（高倍速・フレームスキップ時の区間跨ぎ判定用）
    this.lastUpdateHour = currentHour;
    this.lastUpdateMinute = currentMinute;
  }

  /**
   * ⑤ 時間帯別の乗客需要係数を返す
   * 朝夕ラッシュ多め、日中普通、深夜ほぼゼロ
   */
  public static getHourlyDemandMultiplier(hour: number): number {
    const h = ((hour % 24) + 24) % 24;
    switch (h) {
      case 0: return 0.08;
      case 1:
      case 2:
      case 3: return 0.02; // 深夜はほぼゼロ
      case 4: return 0.06;
      case 5: return 0.25;
      case 6: return 0.7;
      case 7: return 2.6;  // 朝ラッシュ
      case 8: return 3.4;  // 朝ラッシュピーク
      case 9: return 2.0;
      case 10:
      case 11: return 0.9;
      case 12:
      case 13: return 1.2; // 昼休み
      case 14:
      case 15:
      case 16: return 0.85;
      case 17: return 2.3; // 夕ラッシュ
      case 18: return 3.0; // 夕ラッシュピーク
      case 19: return 2.5;
      case 20: return 1.6;
      case 21: return 0.9;
      case 22: return 0.45;
      case 23: return 0.18;
      default: return 1.0;
    }
  }

  /**
   * ④ 先頭車の現在状態を経路履歴に追記する（微小な移動は直前のサンプルを更新するだけに留め、
   * 配列が際限なく増えないよう、各編成に必要な最大遅延距離を超えた古いサンプルは間引く）
   */
  private recordPathSample(train: TrainInstance, pos: THREE.Vector3, yaw: number, pitch: number, cant: number, layer: GridLayer) {
    const hist = train.pathHistory;
    const last = hist[hist.length - 1];
    const segDist = last.pos.distanceTo(pos);

    if (segDist < 0.02 && hist.length > 1) {
      hist[hist.length - 1] = { pos: pos.clone(), yaw, pitch, cant, dist: last.dist, layer };
    } else {
      hist.push({ pos: pos.clone(), yaw, pitch, cant, dist: last.dist + segDist, layer });
    }

    const maxNeeded = (train.carCount - 1) * ModelFactory.CAR_SPACING + 4; // 安全マージン込み
    const newestDist = hist[hist.length - 1].dist;
    while (hist.length > 2 && (newestDist - hist[1].dist) > maxNeeded) {
      hist.shift();
    }
  }

  /**
   * ④ 履歴上で「先頭からの距離 lagDist だけ手前」に相当する状態を補間して取得する
   */
  private sampleHistoryAtLag(hist: PathSample[], lagDist: number): PathSample {
    const newest = hist[hist.length - 1];
    const targetDist = newest.dist - lagDist;

    if (targetDist <= hist[0].dist) return hist[0];

    for (let i = hist.length - 1; i > 0; i--) {
      const a = hist[i - 1];
      const b = hist[i];
      if (targetDist >= a.dist && targetDist <= b.dist) {
        const span = b.dist - a.dist;
        const t = span > 1e-6 ? (targetDist - a.dist) / span : 0;
        // ③ ヨー角の最短補間 (くるくる回転バグの防止)
        let diffYaw = b.yaw - a.yaw;
        while (diffYaw < -Math.PI) diffYaw += Math.PI * 2;
        while (diffYaw > Math.PI) diffYaw -= Math.PI * 2;

        return {
          pos: new THREE.Vector3().lerpVectors(a.pos, b.pos, t),
          yaw: a.yaw + diffYaw * t,
          pitch: THREE.MathUtils.lerp(a.pitch, b.pitch, t),
          cant: THREE.MathUtils.lerp(a.cant, b.cant, t),
          dist: targetDist,
          layer: t < 0.5 ? a.layer : b.layer
        };
      }
    }
    return newest;
  }

  /**
   * ④ 各車両を、車両間隔ぶんだけ先頭車の走行履歴を遅れて辿った位置・向きに配置する
   */
  private applyCarTransforms(train: TrainInstance) {
    for (let i = 0; i < train.cars.length; i++) {
      const lagDist = i * ModelFactory.CAR_SPACING;
      const sample = this.sampleHistoryAtLag(train.pathHistory, lagDist);
      const car = train.cars[i];
      car.position.copy(sample.pos);
      // ④ オイラー回転順序を 'YXZ'（Yaw→Pitch→Roll）に指定！
      // これにより進行方向Yaw回転後のローカルX軸で前上がりPitch、ローカルZ軸でCantが適用され、進行方向に対して横倒しになるのを防止。
      car.rotation.set(sample.pitch, sample.yaw, sample.cant, 'YXZ');
    }
  }

  /**
   * ① 最大10両編成の全車両（先頭車〜最後尾車）が存在する全タイル座標を算出
   * 各車両の物理位置から対応するタイルを特定し、重複を除いた配列として返却する
   */
  public calculateOccupiedTiles(train: TrainInstance): Array<{ x: number; z: number; layer: GridLayer }> {
    const tilesMap = new Map<string, { x: number; z: number; layer: GridLayer }>();

    for (let i = 0; i < train.carCount; i++) {
      const lagDist = i * ModelFactory.CAR_SPACING;
      const sample = this.sampleHistoryAtLag(train.pathHistory, lagDist);
      const tx = Math.round(sample.pos.x / WorldMap.TILE_SIZE);
      const tz = Math.round(sample.pos.z / WorldMap.TILE_SIZE);

      // 【階層跨ぎ閉塞・ATS誤爆防止】
      // 先頭車の階層に固定せず、各車両の走行履歴サンプルが持つ階層（sample.layer）を基準とする。
      let bestLayer: GridLayer = sample.layer ?? train.currentTile.layer;
      let minDiff = Infinity;

      // 該当座標に存在する軌道タイルを全階層から探索し、サンプルのワールド物理高さ(sample.pos.y)に最も適合する階層を特定
      // （※立体交差等で上下に線路が重なっている場合、sample.layer に近い階層を優先して吸い寄せ誤認を防止）
      const candidateLayers: GridLayer[] = [-1, 1, 2, 3, 4, 5];
      const baseLayer = sample.layer ?? train.currentTile.layer ?? 1;
      candidateLayers.sort((l1, l2) => Math.abs(l1 - baseLayer) - Math.abs(l2 - baseLayer));

      for (const lyr of candidateLayers) {
        const t = this.worldMap.getTile(tx, tz, lyr);
        if (t && this.isTrackTile(t)) {
          const h = this.getTileInterpolatedHeight(t, lyr);
          const diff = Math.abs(h - sample.pos.y);
          // 高架の階層間隔（3.0）の半分強（1.8m）以内で最も近いものを採用
          if (diff < minDiff && diff < 1.8) {
            minDiff = diff;
            bestLayer = lyr;
          }
        }
      }

      const key = `${tx},${bestLayer},${tz}`;
      if (!tilesMap.has(key)) {
        tilesMap.set(key, { x: tx, z: tz, layer: bestLayer });
      }
    }

    // 目標タイル（targetTile）も先行ロックとして含める
    const targetLayer = train.targetTile.layer;
    const targetKey = `${train.targetTile.x},${targetLayer},${train.targetTile.z}`;
    if (!tilesMap.has(targetKey)) {
      tilesMap.set(targetKey, { x: train.targetTile.x, z: train.targetTile.z, layer: targetLayer });
    }

    return Array.from(tilesMap.values());
  }

  /**
   * ⑤ 指定座標・階層が運行中列車のいずれかによって占有されているかを判定
   * （走行中・停車中列車の足元の線路・駅の破壊を防止する安全ガード）
   */
  public isTileOccupiedByTrain(x: number, z: number, layer: GridLayer): boolean {
    for (const train of this.trains) {
      if (train.occupiedTiles && train.occupiedTiles.some(t => t.x === x && t.z === z && t.layer === layer)) {
        return true;
      }
      if ((train.currentTile.x === x && train.currentTile.z === z && train.currentTile.layer === layer) ||
          (train.targetTile.x === x && train.targetTile.z === z && train.targetTile.layer === layer)) {
        return true;
      }
    }
    return false;
  }


  /**
   * ③ 列車の折り返し処理
   * 進行方向と反対側の先頭車両（旧最後尾）が新しい先頭車両となり、
   * 車両が瞬間移動することなくその場から逆向きに走り出すよう物理座標と履歴を反転・再構築する。
   */
  private reverseTrainDirection(train: TrainInstance): void {
    const carCount = train.carCount;

    // 1. 各車両の現在の完全な物理姿勢（位置・ヨー・ピッチ・カント）を高解像度でサンプリング
    // ※列車が今いる長さ（先頭〜最後尾）だけを0.5マス刻みで精密に切り出す（ワープ・すり抜け防止）
    const samples: PathSample[] = [];
    const lagMax = (carCount - 1) * ModelFactory.CAR_SPACING;
    const steps = Math.max(1, Math.ceil(lagMax / 0.5));

    for (let k = 0; k <= steps; k++) {
      const lagDist = lagMax * (k / steps);
      const sample = this.sampleHistoryAtLag(train.pathHistory, lagDist);
      samples.push(sample);
    }
    // samples[0] は旧先頭車、samples[steps] は旧最後尾車になる

    // 2. 進行方向を反転
    const newDir = train.direction.clone().negate();

    // 3. 新先頭車（旧最後尾車: samples[steps]）のタイル座標と位置を設定
    const oldRearSample = samples[steps];
    const newFrontPos = oldRearSample.pos.clone();
    train.frontPosition.copy(newFrontPos);
    const curX = Math.round(newFrontPos.x / WorldMap.TILE_SIZE);
    const curZ = Math.round(newFrontPos.z / WorldMap.TILE_SIZE);

    // 勾配（スロープ）上や階層跨ぎでの折り返し時に正しい階層（layer）を特定する
    // 旧先頭車の階層をそのまま引き継ぐのではなく、新先頭車の物理高さ(newFrontPos.y)に最も適合する軌道タイルの階層を探索
    let bestLayer: GridLayer = train.currentTile.layer;
    let minDiff = Infinity;
    const allLayers: GridLayer[] = [-1, 1, 2, 3, 4, 5];
    for (const lyr of allLayers) {
      const t = this.worldMap.getTile(curX, curZ, lyr);
      if (t && this.isTrackTile(t)) {
        const h = this.getTileInterpolatedHeight(t, lyr);
        const diff = Math.abs(h - newFrontPos.y);
        if (diff < minDiff) {
          minDiff = diff;
          bestLayer = lyr;
        }
      }
    }

    train.currentTile = { x: curX, z: curZ, layer: bestLayer };
    const stationTile = this.worldMap.getTile(curX, curZ, train.currentTile.layer);
    if (stationTile && WorldMap.isStationTileType(stationTile.type)) {
      train.lastStationGroupId = stationTile.stationGroupId || `st_${curX}_${curZ}`;
    }

    // 4. 新先頭車の目標タイルを探索 (新進行方向に向かう出口を優先)
    const next = this.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.currentTile.layer, newDir, true);
    if (next) {
      train.isTrapped = false;
      train.direction.copy(new THREE.Vector3(next.x - train.currentTile.x, 0, next.z - train.currentTile.z).normalize());
      train.targetTile = { x: next.x, z: next.z, layer: (next.layer ?? train.currentTile.layer) as GridLayer };
    } else {
      train.direction.copy(newDir);
      train.targetTile = { ...train.currentTile };
      train.isTrapped = true;
      train.speed = 0;
    }
    train.progress = 0;

    // 5. 新しい走行履歴 pathHistory を再構築
    // 旧先頭(samples[0])から旧最後尾(samples[steps])に向かって履歴を積み直す
    const newHistory: PathSample[] = [];
    let accumDist = 0;
    for (let i = 0; i <= steps; i++) {
      const s = samples[i]; // i=0: 新最後尾(旧先頭), i=steps: 新先頭(旧最後尾)
      const pos = s.pos.clone();
      if (newHistory.length > 0) {
        accumDist += pos.distanceTo(newHistory[newHistory.length - 1].pos);
      }
      
      // 逆走のためヨー角は180度反転し、境界を正規化。ピッチ・カントは反転
      let reversedYaw = s.yaw + Math.PI;
      while (reversedYaw < -Math.PI) reversedYaw += Math.PI * 2;
      while (reversedYaw > Math.PI) reversedYaw -= Math.PI * 2;

      newHistory.push({
        pos,
        yaw: reversedYaw,
        pitch: -s.pitch,
        cant: -s.cant,
        dist: accumDist,
        layer: s.layer ?? bestLayer
      });
    }
    train.pathHistory = newHistory;

    // 7. 編成の車両メッシュ群を再生成し、新先頭車と新最後尾を正しくセット
    for (const car of train.cars) {
      train.mesh.remove(car);
    }
    const formation = ModelFactory.createTrainFormation(train.model, train.carCount);
    train.cars = formation.cars;
    for (const car of train.cars) {
      train.mesh.add(car);
    }
    train.isReversed = !train.isReversed;
    if (train.model.category === 'freight' && train.cargoLoad !== undefined) {
      VehicleMeshBuilder.updateTrainCargoVisual(train.cars, train.cargoLoad);
    }

    // 8. 車両の位置と向きを即時反映
    this.applyCarTransforms(train);
  }

  /**
   * Phase3 ①: 併合（連結）処理
   * 後続編成(follower)を先行編成(leader)の最後尾に合体させ、「1本の統合編成（親編成の名称・ダイヤを継承）」とする。
   * follower は完全に消去され、leader は連結作業時間（規定停車時間）を経て発車する。
   */
  private performCoupling(leader: TrainInstance, follower: TrainInstance): void {
    const combinedCars = leader.carCount + follower.carCount;
    this.scene.remove(follower.mesh);
    disposeHierarchy(follower.mesh);

    // 【バグ修正】両編成の走行履歴（pathHistory）を結合し、追加車両が一点に収縮するのを防ぐ
    if (leader.pathHistory.length > 0 && follower.pathHistory.length > 0) {
      // followerの距離座標をleaderの最後尾(最古の履歴)に接続するようにオフセット調整
      const distOffset = leader.pathHistory[0].dist - follower.pathHistory[follower.pathHistory.length - 1].dist;
      const adjustedFollowerHist = follower.pathHistory.map(s => ({
        pos: s.pos.clone(),
        yaw: s.yaw,
        pitch: s.pitch,
        cant: s.cant,
        dist: s.dist + distOffset,
        layer: s.layer
      }));
      // leaderの履歴の「過去」としてfollowerの履歴を先頭に挿入
      leader.pathHistory = [...adjustedFollowerHist, ...leader.pathHistory];
    }

    this.updateTrainCarCount(leader.id, combinedCars);

    // アクションSE: 車両連結音（重厚な金属打撃音）
    const distFactor = this.getDistanceFactor({ x: leader.frontPosition.x, z: leader.frontPosition.z });
    this.audioManager.playCouplingSound(distFactor);

    // ④ 併合時の乗客・積荷データの完全引き継ぎ（消滅防止）
    leader.passengers = Math.min(leader.capacity, leader.passengers + follower.passengers);
    if (leader.model.category === 'freight' || follower.model.category === 'freight') {
      leader.cargoCapacity = Math.max(0, (combinedCars - 1) * 3);
      leader.cargoLoad = Math.min(leader.cargoCapacity, (leader.cargoLoad ?? 0) + (follower.cargoLoad ?? 0));
    }
    leader.totalPassengers += follower.totalPassengers;
    leader.totalRevenue += follower.totalRevenue;
    leader.totalCost += follower.totalCost;

    // 連結作業時間: 規定の停車時間（2分）を経てから、統合編成として発車する
    leader.isStopped = true;
    leader.stopMode = 'wait';
    leader.stopElapsedMinutes = 0;
    leader.requiredStopMinutes = 2;

    if (this.onTrainCoupled) {
      this.onTrainCoupled(leader, follower);
    }
  }

  /**
   * Phase3 ②: 分割（切り離し）処理
   * 到着した編成(train)を「前○両／後○両」に分離する。train自体は前○両の編成として縮小・継続し、
   * 後○両は新規の独立編成（"(親編成名)-付属"）として切り出す。それぞれに個別の発車ルールを付与する。
   */
  private performSplit(train: TrainInstance, config: SplitConfig, tile: TileData): TrainInstance {
    const requiredStopMinutes = 2;

    // ⑤ 分割直後の「ブラックホール」バグ解消:
    // 親編成の走行履歴から、後続編成の全車両（frontCars 〜 frontCars + rearCars - 1 両目）の各物理姿勢をサンプリング
    // 荒いサンプリングではなく、0.5マス単位などの細かいステップでサンプリングし、カーブ等での軌跡ジャンプを防ぐ
    const rearSamples: PathSample[] = [];
    const startLag = config.frontCars * ModelFactory.CAR_SPACING;
    const endLag = (config.frontCars + config.rearCars - 1) * ModelFactory.CAR_SPACING;
    const steps = Math.max(1, Math.ceil((endLag - startLag) / 0.5));
    for (let k = 0; k <= steps; k++) {
      const lagDist = startLag + (endLag - startLag) * (k / steps);
      const s = this.sampleHistoryAtLag(train.pathHistory, lagDist);
      rearSamples.push(s);
    }

    // 【乗客・貨物の保存則厳守】
    // 親編成の車両数を縮小（updateTrainCarCount）する前に、全乗客数・積載貨物を前方編成と後方編成に正しく配分する。
    // 先に縮小を行うと定員縮小によって乗客が切り捨て消失し、かつ親編成からの減算漏れで増殖するバグを解消。
    const originalPassengers = train.passengers;
    const totalCars = config.frontCars + config.rearCars;
    const rearPassengerRatio = config.rearCars / totalCars;
    const rearPassengers = Math.floor(originalPassengers * rearPassengerRatio);
    const frontPassengers = originalPassengers - rearPassengers;

    // 親編成の乗客数を前方編成の割り当て分に即時更新
    train.passengers = frontPassengers;

    // 貨物列車の場合の貨物積載数・容量・発駅情報を前方・後方に正確に配分・継承（積荷完全消失バグ解消）
    let rearCargoLoad = 0;
    if (train.model.category === 'freight') {
      const frontCap = Math.max(0, (config.frontCars - 1) * 3);
      const rearCap = Math.max(0, (config.rearCars - 1) * 3);
      const originalCargo = train.cargoLoad ?? 0;

      if (frontCap + rearCap > 0 && originalCargo > 0) {
        // 後方編成の容量比率に応じて按分配分
        rearCargoLoad = Math.min(rearCap, Math.round(originalCargo * (rearCap / (frontCap + rearCap))));
        let frontCargoLoad = Math.min(frontCap, originalCargo - rearCargoLoad);

        // 端数や空き枠があれば可能な側へ再配分
        let remaining = originalCargo - (frontCargoLoad + rearCargoLoad);
        if (remaining > 0) {
          const rearAdd = Math.min(remaining, rearCap - rearCargoLoad);
          rearCargoLoad += rearAdd;
          remaining -= rearAdd;
        }
        if (remaining > 0) {
          const frontAdd = Math.min(remaining, frontCap - frontCargoLoad);
          frontCargoLoad += frontAdd;
          remaining -= frontAdd;
        }

        // 両編成の総積載容量を超過する余剰コンテナは、現在駅のヤードへ安全に返却（完全消滅防止）
        if (remaining > 0 && tile) {
          this.worldMap.addStationCargoContainers(tile.x, tile.z, remaining, tile.layer);
        }

        train.cargoLoad = frontCargoLoad;
      } else {
        train.cargoLoad = 0;
        rearCargoLoad = 0;
      }
      train.cargoCapacity = frontCap;
    }

    // 元編成を前方○両に縮小（名称・ダイヤはそのまま継承）
    this.updateTrainCarCount(train.id, config.frontCars);
    train.isStopped = true;
    train.stopMode = 'wait';
    train.stopElapsedMinutes = 0;
    train.requiredStopMinutes = requiredStopMinutes;
    train.overrideDepartureRule = config.frontDeparture;
    train.isReversingAtStation = false;
    if (train.model.category === 'freight') {
      train.cargoCapacity = Math.max(0, (config.frontCars - 1) * 3);
      VehicleMeshBuilder.updateTrainCargoVisual(train.cars, train.cargoLoad ?? 0);
    }
    this.applyCarTransforms(train);

    // アクションSE: 切り離し音（ブレーキ管空気緩解 プシュー音）
    const distFactor = this.getDistanceFactor({ x: train.frontPosition.x, z: train.frontPosition.z });
    this.audioManager.playDecouplingSound(distFactor);

    // 後方○両を新規の独立編成として生成
    const rearId = this.nextTrainId++;
    const { group: rearGroup, cars: rearCars } = ModelFactory.createTrainFormation(train.model, config.rearCars);
    this.scene.add(rearGroup);

    const rearLayer = train.currentTile.layer;
    let rearFrontPos: THREE.Vector3;
    let rearDir: THREE.Vector3;
    let rearTileX: number;
    let rearTileZ: number;
    let rearTargetTile: { x: number; z: number; layer: GridLayer };
    const rearHistory: PathSample[] = [];

    if (config.rearReverses) {
      // 後続編成が折り返し逆走発車する場合:
      // 新先頭車は旧最後尾車 (rearSamples[rearSamples.length - 1])
      const newFrontSample = rearSamples[rearSamples.length - 1];
      rearFrontPos = newFrontSample.pos.clone();
      rearDir = train.direction.clone().negate();
      rearTileX = Math.round(rearFrontPos.x / WorldMap.TILE_SIZE);
      rearTileZ = Math.round(rearFrontPos.z / WorldMap.TILE_SIZE);

      const next = this.findNextTrackTile(rearTileX, rearTileZ, rearLayer, rearDir, true);
      if (next) {
        rearDir.copy(new THREE.Vector3(next.x - rearTileX, 0, next.z - rearTileZ).normalize());
        rearTargetTile = { x: next.x, z: next.z, layer: (next.layer ?? rearLayer) as GridLayer };
      } else {
        rearTargetTile = { x: rearTileX, z: rearTileZ, layer: rearLayer };
      }

      // 新編成の最古（新最後尾＝旧先頭 rearSamples[0]）から最新（新先頭＝旧最後尾 rearSamples[rearSamples.length - 1]）へ
      let accumDist = 0;
      for (let k = 0; k < rearSamples.length; k++) {
        const s = rearSamples[k];
        if (rearHistory.length > 0) {
          accumDist += s.pos.distanceTo(rearHistory[rearHistory.length - 1].pos);
        }
        let reversedYaw = s.yaw + Math.PI;
        while (reversedYaw < -Math.PI) reversedYaw += Math.PI * 2;
        while (reversedYaw > Math.PI) reversedYaw -= Math.PI * 2;
        rearHistory.push({
          pos: s.pos.clone(),
          yaw: reversedYaw,
          pitch: -s.pitch,
          cant: -s.cant,
          dist: accumDist,
          layer: s.layer ?? rearLayer
        });
      }
    } else {
      // 後続編成がそのまま同方向に通常進行する場合:
      // 先頭車は分割点 (rearSamples[0])
      const frontSample = rearSamples[0];
      rearFrontPos = frontSample.pos.clone();
      rearDir = train.direction.clone();
      rearTileX = Math.round(rearFrontPos.x / WorldMap.TILE_SIZE);
      rearTileZ = Math.round(rearFrontPos.z / WorldMap.TILE_SIZE);
      rearTargetTile = { ...train.targetTile };

      // 履歴は最古（最後尾 k = rearSamples.length - 1）から最新（先頭 k = 0）へ
      let accumDist = 0;
      for (let k = rearSamples.length - 1; k >= 0; k--) {
        const s = rearSamples[k];
        if (rearHistory.length > 0) {
          accumDist += s.pos.distanceTo(rearHistory[rearHistory.length - 1].pos);
        }
        rearHistory.push({
          pos: s.pos.clone(),
          yaw: s.yaw,
          pitch: s.pitch,
          cant: s.cant,
          dist: accumDist,
          layer: s.layer ?? rearLayer
        });
      }
    }

    const rearTrain: TrainInstance = {
      id: rearId,
      name: `${train.name}-付属`,
      model: train.model,
      carCount: config.rearCars,
      mesh: rearGroup,
      frontPosition: rearFrontPos,
      currentTile: { x: rearTileX, z: rearTileZ, layer: rearLayer },
      targetTile: rearTargetTile,
      direction: rearDir,
      progress: 0,
      speed: train.speed,
      isStopped: true,
      isAtsBraked: false,
      isSignalStopped: false,
      occupiedTiles: [],
      stopTimer: 0,
      passengers: rearPassengers,
      capacity: train.model.baseCapacity * config.rearCars,
      isReversed: config.rearReverses ? !train.isReversed : train.isReversed,
      cars: rearCars,
      heightY: train.heightY,
      pathHistory: rearHistory,
      totalPassengers: 0,
      totalRevenue: 0,
      totalCost: 0,
      monthlyProfit: 0,
      fleetId: train.fleetId ? `${train.fleetId}-split` : undefined,
      lastStationGroupId: tile.stationGroupId ?? null,
      isReversingAtStation: config.rearReverses,
      cargoLoad: rearCargoLoad,
      cargoCapacity: train.model.category === 'freight' ? Math.max(0, (config.rearCars - 1) * 3) : 0,
      cargoPickup: train.cargoPickup ? { ...train.cargoPickup } : null,
      cargoTraveledTiles: train.cargoTraveledTiles ?? 0,
      stopMode: 'wait',
      stopElapsedMinutes: 0,
      requiredStopMinutes,
      overrideDepartureRule: config.rearDeparture
    };

    if (train.model.category === 'freight') {
      VehicleMeshBuilder.updateTrainCargoVisual(rearCars, rearCargoLoad);
    }

    // ⑤ 後続編成の全車両を走行履歴に基づいて正しい位置・向きに即座に配置
    this.applyCarTransforms(rearTrain);

    if (this.onTrainSplit) {
      this.onTrainSplit(train, rearTrain);
    }

    return rearTrain;
  }

  public getFollowTarget(trainIndex: number = 0): FollowTarget | null {
    if (this.trains.length <= trainIndex) return null;
    const train = this.trains[trainIndex];
    return {
      position: train.frontPosition,
      direction: train.direction,
      speed: train.isStopped || train.isAtsBraked ? 0 : train.model.maxSpeed
    };
  }

  /**
   * 【廃車の不法投棄解消】列車編成メッシュおよび全車両パーツの完全VRAM解放
   * ルートメッシュだけでなく、cars 配列の各車両メッシュ・ジオメトリ・マテリアル・テクスチャを再帰的に破棄
   */
  private disposeTrainMesh(train: TrainInstance): void {
    if (!train) return;
    if (train.mesh) {
      this.scene.remove(train.mesh);
      disposeHierarchy(train.mesh);
    }
    if (train.cars && Array.isArray(train.cars)) {
      for (const car of train.cars) {
        if (car && car !== train.mesh) {
          this.scene.remove(car);
          disposeHierarchy(car);
        }
      }
    }
  }

  public removeAllTrains() {
    for (const t of this.trains) {
      this.disposeTrainMesh(t);
      this.blockSignalManager.unregisterTrain(t.id);
    }
    this.trains = [];
  }

  /**
   * ① 指定した列車編成を1つだけ撤去する
   */
  public removeTrain(id: number): boolean {
    const idx = this.trains.findIndex(t => t.id === id);
    if (idx === -1) return false;
    const train = this.trains[idx];
    this.disposeTrainMesh(train);
    this.trains.splice(idx, 1);
    this.blockSignalManager.unregisterTrain(id);
    return true;
  }

  /**
   * 運行中列車の編成両数を動的に変更（増車・減車）する
   */
  public updateTrainCarCount(trainId: number, newCarCount: number): boolean {
    const train = this.trains.find(t => t.id === trainId);
    if (!train) return false;

    // 古いメッシュをシーンから除去し GPU メモリ解放
    this.disposeTrainMesh(train);

    // 新しい編成メッシュを生成してシーンに追加
    const { group: trainGroup, cars } = ModelFactory.createTrainFormation(train.model, newCarCount);
    this.scene.add(trainGroup);

    train.carCount = newCarCount;
    train.mesh = trainGroup;
    train.cars = cars;
    train.capacity = train.model.baseCapacity * newCarCount;
    if (train.model.category === 'freight') {
      train.cargoCapacity = Math.max(0, (newCarCount - 1) * 3);
      if ((train.cargoLoad ?? 0) > train.cargoCapacity) {
        train.cargoLoad = train.cargoCapacity;
      }
      VehicleMeshBuilder.updateTrainCargoVisual(train.cars, train.cargoLoad ?? 0);
    }
    if (train.passengers > train.capacity) {
      train.passengers = train.capacity;
    }

    // 各車両の位置・向きを走行履歴（pathHistory）からサンプリングして配置（カーブ・勾配・カントに沿って美しく追従）
    if (train.pathHistory && train.pathHistory.length > 0) {
      // ③ 増車時の「ブラックホール収縮」バグ防止:
      // 増車によって必要な過去の履歴距離が現在の保持距離を超える場合、最後尾サンプルの向きに基づいて
      // 過去方向へ履歴を外挿補完し、追加された車両が hist[0] の1点に重なるのを完全に防止する
      const requiredDist = (newCarCount - 1) * ModelFactory.CAR_SPACING + 4;
      const hist = train.pathHistory;
      const newest = hist[hist.length - 1];
      const oldest = hist[0];
      const currentDistSpan = newest.dist - oldest.dist;

      if (currentDistSpan < requiredDist) {
        const shortfall = requiredDist - currentDistSpan;
        // 最後尾付近の方向ベクトルを取得（過去に向かって延長するため進行方向と逆向きに伸ばす）
        let forwardDir: THREE.Vector3;
        if (hist.length >= 2) {
          forwardDir = hist[1].pos.clone().sub(oldest.pos);
          if (forwardDir.lengthSq() > 1e-4) {
            forwardDir.normalize();
          } else {
            forwardDir = new THREE.Vector3(Math.sin(oldest.yaw), 0, Math.cos(oldest.yaw)).normalize();
          }
        } else {
          forwardDir = new THREE.Vector3(Math.sin(oldest.yaw), 0, Math.cos(oldest.yaw)).normalize();
        }

        const steps = Math.max(1, Math.ceil(shortfall / 0.5));
        const stepDist = shortfall / steps;

        const oldestPos = oldest.pos.clone();
        const oldestDist = oldest.dist;
        const oldestYaw = oldest.yaw;
        const oldestPitch = oldest.pitch;
        const oldestCant = oldest.cant;

        // 不足している過去分のサンプルを最後尾から後方へ生成（oldestDist から手前へ完全連続）
        const extensionSamples: PathSample[] = [];
        for (let k = steps; k >= 1; k--) {
          const d = k * stepDist;
          const pos = oldestPos.clone().addScaledVector(forwardDir, -d);
          extensionSamples.push({
            pos,
            yaw: oldestYaw,
            pitch: oldestPitch,
            cant: oldestCant,
            dist: oldestDist - d,
            layer: oldest.layer ?? train.currentTile.layer
          });
        }
        train.pathHistory = [...extensionSamples, ...hist];
      }

      this.applyCarTransforms(train);
    } else {
      const frontPos = train.frontPosition;
      const dir = train.direction;
      cars.forEach((car, i) => {
        car.rotation.order = 'YXZ';
        car.position.copy(frontPos).addScaledVector(dir, -i * ModelFactory.CAR_SPACING);
        car.rotation.set(0, 0, 0);
      });
    }

    return true;
  }

  /**
   * ⑤ 月次/日次の列車運行維持費を計上する（1両あたり月¥80,000）
   */
  public deductPeriodicOperatingCosts() {
    for (const train of this.trains) {
      const cost = train.carCount * 80000;
      train.totalCost += cost;
      train.monthlyProfit = train.totalRevenue - train.totalCost;
    }
  }

  /**
   * ① 運行中列車の全データ（状態・履歴・収支・ダイヤ）を JSON 文字列としてシリアライズ
   */
  public serialize(): string {
    const data = {
      nextTrainId: this.nextTrainId,
      trains: this.trains.map(t => ({
        id: t.id,
        name: t.name,
        modelId: t.model.id,
        carCount: t.carCount,
        frontPosition: { x: t.frontPosition.x, y: t.frontPosition.y, z: t.frontPosition.z },
        currentTile: { ...t.currentTile },
        targetTile: { ...t.targetTile },
        direction: { x: t.direction.x, y: t.direction.y, z: t.direction.z },
        progress: t.progress,
        speed: t.speed,
        isStopped: t.isStopped,
        isAtsBraked: t.isAtsBraked,
        isSignalStopped: t.isSignalStopped,
        occupiedTiles: t.occupiedTiles,
        stopTimer: t.stopTimer,
        passengers: t.passengers,
        capacity: t.capacity,
        isReversed: t.isReversed,
        heightY: t.heightY,
        pathHistory: t.pathHistory.map(h => ({
          pos: { x: h.pos.x, y: h.pos.y, z: h.pos.z },
          yaw: h.yaw,
          pitch: h.pitch,
          cant: h.cant,
          dist: h.dist
        })),
        totalPassengers: t.totalPassengers,
        totalRevenue: t.totalRevenue,
        totalCost: t.totalCost,
        monthlyProfit: t.monthlyProfit,
        fleetId: t.fleetId,
        lastStationGroupId: t.lastStationGroupId,
        isReversingAtStation: t.isReversingAtStation,
        scheduledDepartureMinute: t.scheduledDepartureMinute,
        cargoLoad: t.cargoLoad,
        cargoCapacity: t.cargoCapacity,
        cargoPickup: t.cargoPickup,
        cargoTraveledTiles: t.cargoTraveledTiles,
        stopMode: t.stopMode,
        stopElapsedMinutes: t.stopElapsedMinutes,
        requiredStopMinutes: t.requiredStopMinutes,
        overrideDepartureRule: t.overrideDepartureRule
      }))
    };
    return JSON.stringify(data);
  }

  /**
   * ① セーブデータから運行中の全列車を完全復元（メッシュ再生成・姿勢復元）
   */
  public deserialize(jsonString: string): boolean {
    try {
      const data = JSON.parse(jsonString);
      if (!data || !Array.isArray(data.trains)) return false;

      // 既存列車メッシュをシーンから全て除去
      this.removeAllTrains();

      this.nextTrainId = data.nextTrainId || 1;

      for (const tData of data.trains) {
        const model = getVehicleById(tData.modelId);
        if (!model) continue;

        const { group, cars } = ModelFactory.createTrainFormation(model, tData.carCount);
        this.scene.add(group);

        const frontPos = new THREE.Vector3(tData.frontPosition.x, tData.frontPosition.y, tData.frontPosition.z);
        const dir = new THREE.Vector3(tData.direction.x, tData.direction.y, tData.direction.z);

        const pathHistory: PathSample[] = (tData.pathHistory || []).map((h: any) => ({
          pos: new THREE.Vector3(h.pos.x, h.pos.y, h.pos.z),
          yaw: h.yaw,
          pitch: h.pitch,
          cant: h.cant,
          dist: h.dist,
          layer: (h.layer ?? tData.currentTile?.layer ?? 1) as GridLayer
        }));

        const train: TrainInstance = {
          id: tData.id,
          name: tData.name,
          model,
          carCount: tData.carCount,
          mesh: group,
          frontPosition: frontPos,
          currentTile: { ...tData.currentTile },
          targetTile: { ...tData.targetTile },
          direction: dir,
          progress: tData.progress ?? 0,
          speed: tData.speed ?? model.speedTilesPerMinute ?? 1.5,
          isStopped: !!tData.isStopped,
          isAtsBraked: !!tData.isAtsBraked,
          isSignalStopped: !!tData.isSignalStopped,
          occupiedTiles: tData.occupiedTiles ?? [],
          stopTimer: tData.stopTimer ?? 0,
          passengers: model.category === 'freight' ? 0 : (tData.passengers ?? 0),
          capacity: model.category === 'freight' ? 0 : (tData.capacity ?? model.baseCapacity * tData.carCount),
          isReversed: !!tData.isReversed,
          cars,
          heightY: tData.heightY ?? 0,
          pathHistory,
          totalPassengers: tData.totalPassengers ?? 0,
          totalRevenue: tData.totalRevenue ?? 0,
          totalCost: tData.totalCost ?? 0,
          monthlyProfit: tData.monthlyProfit ?? 0,
          fleetId: tData.fleetId,
          lastStationGroupId: tData.lastStationGroupId ?? null,
          isReversingAtStation: !!tData.isReversingAtStation,
          scheduledDepartureMinute: tData.scheduledDepartureMinute ?? null,
          cargoLoad: tData.cargoLoad ?? 0,
          cargoCapacity: tData.cargoCapacity ?? (model.category === 'freight' ? Math.max(0, (tData.carCount - 1) * 3) : 0),
          cargoPickup: tData.cargoPickup ?? null,
          cargoTraveledTiles: tData.cargoTraveledTiles ?? 0,
          stopMode: tData.stopMode ?? null,
          stopElapsedMinutes: tData.stopElapsedMinutes ?? 0,
          requiredStopMinutes: tData.requiredStopMinutes ?? 0,
          overrideDepartureRule: tData.overrideDepartureRule ?? null
        };

        // 車両の3D姿勢を復元
        if (train.pathHistory.length > 0) {
          this.applyCarTransforms(train);
        }
        train.occupiedTiles = this.calculateOccupiedTiles(train);

        if (model.category === 'freight') {
          VehicleMeshBuilder.updateTrainCargoVisual(train.cars, train.cargoLoad ?? 0);
        }

        this.trains.push(train);
      }
      return true;
    } catch (e) {
      console.error('Failed to deserialize TrainManager data:', e);
      return false;
    }
  }
}
