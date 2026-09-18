import * as THREE from 'three';
import { WorldMap, TileData, SwitchState, StationActionMode, getStationSlotMode, getSwitchSlotDirection } from './WorldMap';
import { ModelFactory } from '../models/ModelFactory';
import { AudioManager } from '../engine/AudioManager';
import { FollowTarget } from '../engine/CameraController';
import { VehicleModelInfo, getVehicleById } from './VehicleCatalog';

// ④ 先頭車の走行履歴サンプル（各車両がこの履歴を「車両間隔ぶん遅れて」辿ることで、
// カーブや勾配・進路変更を編成全体が一斉にではなく1両ずつ順番に通過するようにする）
interface PathSample {
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  cant: number;
  dist: number; // 経路の始点からの累積距離（ワールド単位）
}

export interface TrainInstance {
  id: number;
  name: string;
  model: VehicleModelInfo;
  carCount: 1 | 2 | 3 | 4;
  mesh: THREE.Group; // ④ 常に position/rotation ともに単位変換（子の各車両をワールド座標で個別配置する）
  frontPosition: THREE.Vector3; // ④ 先頭車の現在位置（カメラ追従・ATS判定に使用）
  currentTile: { x: number; z: number }; // ④ 先頭車が今いるタイル
  targetTile: { x: number; z: number }; // ④ 先頭車が次に向かうタイル（折り返し判定はこの先頭位置基準で行う）
  direction: THREE.Vector3;
  progress: number;
  speed: number; // tiles per second
  isStopped: boolean;
  isAtsBraked: boolean; // ⑥ ATSによる先行列車接近停止
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
}

export class TrainManager {
  private trains: TrainInstance[] = [];
  private scene: THREE.Scene;
  private worldMap: WorldMap;
  private audioManager: AudioManager;
  private nextTrainId: number = 1;
  private soundTimer: number = 0;

  constructor(scene: THREE.Scene, worldMap: WorldMap, audioManager: AudioManager) {
    this.scene = scene;
    this.worldMap = worldMap;
    this.audioManager = audioManager;
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
    carCount: 1 | 2 | 3 | 4 = 3,
    initialDirIdx?: number,
    fleetId?: string
  ): TrainInstance | null {
    const tile = this.worldMap.getTile(x, z);
    if (!tile || !this.isTrackTile(tile)) {
      return null;
    }

    const isElevated = tile.type.includes('elevated');
    const baseHeight = isElevated ? 3.0 : 0;

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
    const nextTile = this.findNextTrackTile(x, z, dir, true);

    const speedTilesPerSec = (modelInfo.maxSpeed / 120) * 1.6;
    const initialYaw = Math.atan2(dir.x, dir.z);

    cars.forEach((car, i) => {
      car.rotation.order = 'YXZ';
      car.position.copy(spawnPos).addScaledVector(dir, -i * ModelFactory.CAR_SPACING);
      car.rotation.set(0, initialYaw, 0);
    });

    const trainId = this.nextTrainId++;
    const train: TrainInstance = {
      id: trainId,
      name: `${modelInfo.name} ${trainId}号`,
      model: modelInfo,
      carCount,
      mesh: trainGroup,
      frontPosition: spawnPos.clone(),
      currentTile: { x, z },
      targetTile: nextTile ? { x: nextTile.x, z: nextTile.z } : { x, z },
      direction: dir,
      progress: 0,
      speed: speedTilesPerSec,
      isStopped: false,
      isAtsBraked: false,
      stopTimer: 0,
      passengers: Math.floor(modelInfo.baseCapacity * carCount * 0.4),
      capacity: modelInfo.baseCapacity * carCount,
      isReversed: false,
      cars,
      heightY: baseHeight,
      pathHistory: [{ pos: spawnPos.clone(), yaw: initialYaw, pitch: 0, cant: 0, dist: 0 }],
      totalPassengers: 0,
      totalRevenue: 0,
      totalCost: 0,
      monthlyProfit: 0,
      fleetId,
      lastStationGroupId: null
    };

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
      if (dot > bestDot) {
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
  private findNextTrackTile(currX: number, currZ: number, currentDir: THREE.Vector3, isSpawn: boolean = false): TileData | null {
    const curTile = this.worldMap.getTile(currX, currZ);
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

      const neighbor = this.worldMap.getTile(nx, nz);
      if (!neighbor || !this.isTrackTile(neighbor)) continue;

      const nExits = WorldMap.getTileExits(neighbor);
      const backIdx = WorldMap.opposite(idx);
      const nExit = nExits.find(e => e.idx === backIdx);
      if (!nExit) continue; // 隣接タイル側がこちらを向いて接続していない（向き違い・分岐未開通など）
      if (nExit.level !== exit.level) continue; // ① 地上⇔高架のレベル不一致（勾配レールを挟んでいない）

      return neighbor;
    }

    return null; // 有効な接続なし = 列車は折り返す
  }

  private isTrackTile(t: TileData): boolean {
    return (
      t.type.includes('rail') ||
      t.type.includes('station') ||
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
      let mustStop = false;

      for (let j = 0; j < this.trains.length; j++) {
        if (i === j) continue;
        const trainB = this.trains[j];

        // Distance in world coordinates (④ 先頭車どうしの距離で判定)
        const dist = trainA.frontPosition.distanceTo(trainB.frontPosition);

        // Vector from A to B
        const toB = new THREE.Vector3().subVectors(trainB.frontPosition, trainA.frontPosition);
        const dot = toB.dot(trainA.direction);

        // If B is in front of A and within 2.8 units (less than 1.5 tiles), apply ATS brake!
        if (dot > 0 && dist < 4.2) {
          mustStop = true;
          break;
        }

        // Extreme proximity (potential head-on collision)
        if (dist < 2.0) {
          mustStop = true;
          break;
        }
      }

      trainA.isAtsBraked = mustStop;
    }
  }

  /**
   * メイン更新ループ
   */
  public update(
    deltaTime: number,
    speedMultiplier: number,
    onPassengerFare: (amount: number) => void,
    currentHour: number = 0,
    currentMinute: number = 0
  ) {
    if (this.trains.length === 0 || speedMultiplier <= 0) return;

    const dt = deltaTime * speedMultiplier;

    // ⑥ ATS 衝突防止チェック
    this.checkAtsCollisionAvoidance();

    // Sound timer
    this.soundTimer += dt;
    if (this.soundTimer >= 1.4 / Math.max(0.5, speedMultiplier)) {
      this.soundTimer = 0;
      this.audioManager.playJointSound(speedMultiplier);
    }

    for (const train of this.trains) {
      // Station stop & Timed departure
      if (train.isStopped) {
        train.stopTimer -= dt;

        let canDepart = train.stopTimer <= 0;
        // 定時発車ダイヤが設定されている場合
        if (canDepart && train.scheduledDepartureMinute !== null && train.scheduledDepartureMinute !== undefined) {
          if (currentMinute !== train.scheduledDepartureMinute) {
            canDepart = false; // 指定分になるまでホームで待機
          }
        }

        if (canDepart) {
          train.isStopped = false;
          train.scheduledDepartureMinute = null;
          this.audioManager.playStationBell();

          // 駅折り返しダイヤの場合: 進行方向と反対側の先頭車両が新先頭になり逆走開始
          if (train.isReversingAtStation) {
            train.isReversingAtStation = false;
            this.reverseTrainDirection(train);
          }
        }
        continue;
      }

      // ⑥ ATS brake engaged
      if (train.isAtsBraked) {
        continue;
      }

      // Advance train
      train.progress += (train.speed * dt);

      if (train.progress >= 1.0) {
        train.progress = 0;
        train.currentTile = { ...train.targetTile };

        const curTileData = this.worldMap.getTile(train.currentTile.x, train.currentTile.z);

        // ⑤ 駅ホーム到着・停車判定（複数マス駅の奥側停車 ＆ 10分単位ダイヤ判定）
        if (curTileData && curTileData.type.startsWith('station')) {
          const stGroupId = curTileData.stationGroupId || (() => {
            const st = this.worldMap.getStationStartTile(train.currentTile.x, train.currentTile.z);
            return st ? `st_${st.x}_${st.z}` : `st_${train.currentTile.x}_${train.currentTile.z}`;
          })();

          // ⑥ 次のマスを先読みし、次もまだ同じ駅グループのマスかを確認
          const peekNext = this.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.direction);
          const nextIsSameStation = !!(peekNext && peekNext.type.startsWith('station') && (
            peekNext.stationGroupId === stGroupId || (!peekNext.stationGroupId && !curTileData.stationGroupId)
          ));

          // ⑥ 複数マス駅の場合、手前側1マス目ではなくホームの最奥部（先端）に達した時に停車させる
          // （次タイルも同一駅なら、まだホーム途中なので停車せず前進する）
          if (!nextIsSameStation && train.lastStationGroupId !== stGroupId) {
            train.lastStationGroupId = stGroupId;

            // ① 要件①: 10分単位のダイヤ判定（00, 10, 20, 30, 40, 50分）
            const schedule = curTileData.stationSchedule;
            const currentMode: StationActionMode = getStationSlotMode(schedule, currentHour, currentMinute);

            if (currentMode === 'pass') {
              // 通過ダイヤ: 停車せずそのまま通過
            } else {
              train.isStopped = true;
              // 停車時間設定: 通常=4.0秒(約10分), 待避=設定分または12.0秒(約30分), 折り返し=6.0秒(約15分)
              const waitSec = schedule?.waitMinutes ? (schedule.waitMinutes * 0.4) : 12.0;
              train.stopTimer = currentMode === 'wait' ? waitSec : (currentMode === 'reverse' ? 6.0 : 4.0);

              // 折り返し設定
              train.isReversingAtStation = (currentMode === 'reverse');

              // 定時発車設定
              train.scheduledDepartureMinute = schedule?.departureMinute ?? null;

              // ⑤ 要件⑤: 時間帯別乗客需要カーブ（朝夕ラッシュ多め、日中普通、深夜ほぼゼロ）
              const demandMult = TrainManager.getHourlyDemandMultiplier(currentHour);
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

              onPassengerFare(fare);
            }
          }
        } else {
          // 駅以外のマスに出たら、駅グループIDを解除
          train.lastStationGroupId = null;
        }

        // ①③ 分岐器通過時のダイヤ制御（10分タイムラインバー切替・交互切替・手動維持）
        if (curTileData && curTileData.type.startsWith('point_switch')) {
          const switchSched = curTileData.switchSchedule;
          if (switchSched) {
            if (switchSched.mode === 'alternate') {
              // 交互切替: 列車が通過するたびに直進⇄分岐を反転
              const nextState: SwitchState = curTileData.switchState === 'straight' ? 'diverge' : 'straight';
              this.worldMap.setSwitchState(train.currentTile.x, train.currentTile.z, nextState);
            } else if (switchSched.mode === 'timeline') {
              // ① タイムラインバー方式: 現在の10分スロット指定開通方向に切り替え
              const targetDir = getSwitchSlotDirection(switchSched, currentHour, currentMinute);
              this.worldMap.setSwitchState(train.currentTile.x, train.currentTile.z, targetDir);
            }
            // ※ mode === 'manual' の場合は、手動でセットされた開通方向をそのまま維持する（直進に強制上書きしない！）
          }
        }

        // Determine next tile
        const next = this.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.direction);
        if (next) {
          const newDir = new THREE.Vector3(next.x - train.currentTile.x, 0, next.z - train.currentTile.z).normalize();
          train.direction.copy(newDir);
          train.targetTile = { x: next.x, z: next.z };
        } else {
          // ④ 折り返し（デッドエンド）: 進行方向と反対側の先頭車両を新先頭にして反転
          this.reverseTrainDirection(train);
        }
      }

      // 3D Position & Elevation Interpolation（先頭車の位置・向きを算出）
      const fromTile = this.worldMap.getTile(train.currentTile.x, train.currentTile.z);
      const toTile = this.worldMap.getTile(train.targetTile.x, train.targetTile.z);

      // ③ スロープ区間はパートごとに地上〜高架の1/4ずつ高さが変わるため、
      // 各タイルの中心高さを使って区間ごとに滑らかに昇降させる
      const heightOfTile = (t?: TileData) => {
        if (!t) return 0;
        if (t.type === 'rail_slope') {
          const part = t.slopePart ?? 0;
          return (part + 0.5) * 0.75;
        }
        return t.type.includes('elevated') ? 3.0 : 0;
      };
      const fromH = heightOfTile(fromTile);
      const toH = heightOfTile(toTile);

      const currentH = THREE.MathUtils.lerp(fromH, toH, train.progress);
      train.heightY = currentH;

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

      const currentPos = new THREE.Vector3().lerpVectors(fromPos, toPos, train.progress);
      train.frontPosition.copy(currentPos);

      // Heading rotation (Yaw)
      const yaw = train.direction.lengthSq() > 0.001
        ? Math.atan2(train.direction.x, train.direction.z)
        : train.pathHistory[train.pathHistory.length - 1].yaw;

      // ④ 勾配ピッチ角（車体の前上がり・前下がり）。
      // メッシュのローカル+Zが進行方向(前)、+Yが真上、+Xが進行方向右側。
      // Three.js の右手系オイラー角 'YXZ' では、ローカルX軸の負回転が前上がり(ノーズアップ)、正回転が前下がり(ノーズダウン)。
      // 上り坂（heightDiff > 0）で前上がりにし、下り坂（heightDiff < 0）で前下がりにするため符号を反転する。
      const heightDiff = toH - fromH;
      const pitch = Math.abs(heightDiff) > 0.05
        ? -Math.atan2(heightDiff, WorldMap.TILE_SIZE)
        : 0;

      // ① 曲線走行時のカント（わずかな傾き）
      const isCurving = fromTile?.type.includes('curve') || toTile?.type.includes('curve');
      const cant = isCurving ? 0.04 : 0;

      // ④ 先頭車の走行履歴に今フレームの状態を記録し、各車両はそれぞれの車両間隔ぶん
      // 「遅れた」履歴上の位置・向きを辿ることで、カーブや進路変更を1両ずつ順番に通過するようにする
      this.recordPathSample(train, currentPos, yaw, pitch, cant);
      this.applyCarTransforms(train);
    }
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
  private recordPathSample(train: TrainInstance, pos: THREE.Vector3, yaw: number, pitch: number, cant: number) {
    const hist = train.pathHistory;
    const last = hist[hist.length - 1];
    const segDist = last.pos.distanceTo(pos);

    if (segDist < 0.02 && hist.length > 1) {
      hist[hist.length - 1] = { pos: pos.clone(), yaw, pitch, cant, dist: last.dist };
    } else {
      hist.push({ pos: pos.clone(), yaw, pitch, cant, dist: last.dist + segDist });
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
        return {
          pos: new THREE.Vector3().lerpVectors(a.pos, b.pos, t),
          yaw: THREE.MathUtils.lerp(a.yaw, b.yaw, t),
          pitch: THREE.MathUtils.lerp(a.pitch, b.pitch, t),
          cant: THREE.MathUtils.lerp(a.cant, b.cant, t),
          dist: targetDist
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
   * ③ 列車の折り返し処理
   * 進行方向と反対側の先頭車両（旧最後尾）が新しい先頭車両となり、
   * 車両が瞬間移動することなくその場から逆向きに走り出すよう物理座標と履歴を反転・再構築する。
   */
  private reverseTrainDirection(train: TrainInstance): void {
    const carCount = train.carCount;

    // 1. 各車両の現在の物理位置をサンプリング
    const positions: THREE.Vector3[] = [];
    for (let i = 0; i < carCount; i++) {
      const lagDist = i * ModelFactory.CAR_SPACING;
      const sample = this.sampleHistoryAtLag(train.pathHistory, lagDist);
      positions.push(sample.pos.clone());
    }

    // 2. 進行方向を反転
    const newDir = train.direction.clone().negate();

    // 3. 新先頭車（旧最後尾車: positions[carCount - 1]）のタイル座標と位置を設定
    const newFrontPos = positions[carCount - 1];
    train.frontPosition.copy(newFrontPos);
    const curX = Math.round(newFrontPos.x / WorldMap.TILE_SIZE);
    const curZ = Math.round(newFrontPos.z / WorldMap.TILE_SIZE);
    train.currentTile = { x: curX, z: curZ };

    // 4. 新先頭車の目標タイルを探索 (新進行方向に向かう出口を優先)
    const next = this.findNextTrackTile(train.currentTile.x, train.currentTile.z, newDir, true);
    if (next) {
      train.direction.copy(new THREE.Vector3(next.x - train.currentTile.x, 0, next.z - train.currentTile.z).normalize());
      train.targetTile = { x: next.x, z: next.z };
    } else {
      train.direction.copy(newDir);
      train.targetTile = { ...train.currentTile };
    }
    train.progress = 0;

    // 5. 新進行方向のYaw角
    const yaw = Math.atan2(train.direction.x, train.direction.z);

    // 6. 新しい走行履歴 pathHistory を再構築
    // 新編成の最古（新最後尾＝旧先頭 positions[0]）から最新（新先頭＝旧最後尾 positions[carCount - 1]）へ
    const newHistory: PathSample[] = [];
    let accumDist = 0;
    for (let i = 0; i < carCount; i++) {
      const pos = positions[i].clone(); // i=0: 新最後尾, ..., i=carCount-1: 新先頭
      if (newHistory.length > 0) {
        accumDist += pos.distanceTo(newHistory[newHistory.length - 1].pos);
      }
      newHistory.push({
        pos,
        yaw,
        pitch: 0,
        cant: 0,
        dist: accumDist
      });
    }
    train.pathHistory = newHistory;

    // 7. 編成の車両メッシュ群を再生成し、新先頭車（前向き・ヘッドライト）と新最後尾（後ろ向き・テールライト）を正しくセット
    for (const car of train.cars) {
      train.mesh.remove(car);
    }
    const formation = ModelFactory.createTrainFormation(train.model, train.carCount);
    train.cars = formation.cars;
    for (const car of train.cars) {
      train.mesh.add(car);
    }
    train.isReversed = !train.isReversed;

    // 8. 車両の位置と向きを即時反映
    this.applyCarTransforms(train);
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

  public removeAllTrains() {
    for (const t of this.trains) {
      this.scene.remove(t.mesh);
    }
    this.trains = [];
  }

  /**
   * ① 指定した列車編成を1つだけ撤去する
   */
  public removeTrain(id: number): boolean {
    const idx = this.trains.findIndex(t => t.id === id);
    if (idx === -1) return false;
    this.scene.remove(this.trains[idx].mesh);
    this.trains.splice(idx, 1);
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
}
