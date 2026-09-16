import * as THREE from 'three';
import { WorldMap, TileData } from './WorldMap';
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

  /**
   * ⑤ & ⑦ スポーン（車種・両数指定）
   */
  public spawnTrain(
    x: number,
    z: number,
    modelInfo: VehicleModelInfo = getVehicleById('metro-2310'),
    carCount: 1 | 2 | 3 | 4 = 3
  ): TrainInstance | null {
    const tile = this.worldMap.getTile(x, z);
    if (!tile || (!tile.type.includes('rail') && !tile.type.includes('station') && !tile.type.includes('switch'))) {
      return null;
    }

    const isElevated = tile.type.includes('elevated');
    const baseHeight = isElevated ? 3.0 : 0;

    // Build 3D formation using ModelFactory
    // ④ グループ自体は常に単位変換のまま（子の各車両をワールド座標で個別に配置・回転させるため）
    const { group: trainGroup, cars } = ModelFactory.createTrainFormation(modelInfo, carCount);
    this.scene.add(trainGroup);

    const dir = tile.rotation === 1 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const spawnPos = new THREE.Vector3(x * WorldMap.TILE_SIZE, baseHeight, z * WorldMap.TILE_SIZE);
    const initialYaw = Math.atan2(dir.x, dir.z);

    // 初期表示（まだ経路履歴がないため、先頭車を起点に一列に並べておく）
    cars.forEach((car, i) => {
      car.position.copy(spawnPos).addScaledVector(dir, -i * ModelFactory.CAR_SPACING);
      car.rotation.set(0, initialYaw, 0);
    });

    const nextTile = this.findNextTrackTile(x, z, dir, true);

    const speedTilesPerSec = (modelInfo.maxSpeed / 120) * 1.6;

    const train: TrainInstance = {
      id: this.nextTrainId++,
      name: `${modelInfo.name} (${modelInfo.nickname})`,
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
      pathHistory: [{ pos: spawnPos.clone(), yaw: initialYaw, pitch: 0, cant: 0, dist: 0 }]
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
    } else {
      // currentDir は「このタイルに進入してきた時の向き」＝back方向はその反対
      const backIdx = WorldMap.opposite(headingIdx);
      const forward = curExits.filter(e => e.idx !== backIdx).map(e => e.idx);
      candidateIdxs = forward.length > 0 ? forward : curExits.map(e => e.idx);
    }

    for (const idx of candidateIdxs) {
      const exit = curExits.find(e => e.idx === idx);
      if (!exit) continue;

      const d = WorldMap.DIRS[idx];
      const nx = currX + d.x;
      const nz = currZ + d.z;
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
  public update(deltaTime: number, speedMultiplier: number, onPassengerFare: (amount: number) => void) {
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
      // Station stop
      if (train.isStopped) {
        train.stopTimer -= dt;
        if (train.stopTimer <= 0) {
          train.isStopped = false;
          this.audioManager.playStationBell();
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

        // ⑧⑨ 駅ホーム到着・停車判定（有効長が編成両数に満たない場合は通過扱い）
        const curTileData = this.worldMap.getTile(train.currentTile.x, train.currentTile.z);
        if (curTileData && curTileData.type.startsWith('station')) {
          const platformLength = this.worldMap.getStationRunLength(train.currentTile.x, train.currentTile.z);
          if (train.carCount <= platformLength) {
            train.isStopped = true;
            train.stopTimer = 4.0; // 4 seconds station stop
            const boarding = Math.floor(Math.random() * 200 + 100) * train.carCount;
            // ⑩ 運賃は車種ごとの単価（farePerRide）× 乗車人数で決まる
            const fare = Math.round(train.model.farePerRide * boarding);
            curTileData.stationPassengers = boarding;
            onPassengerFare(fare);
          }
          // else: 有効長不足のため通過（停車もフェアも発生しない）
        }

        // Determine next tile
        const next = this.findNextTrackTile(train.currentTile.x, train.currentTile.z, train.direction);
        if (next) {
          const newDir = new THREE.Vector3(next.x - train.currentTile.x, 0, next.z - train.currentTile.z).normalize();
          train.direction.copy(newDir);
          train.targetTile = { x: next.x, z: next.z };
        } else {
          // ④ 折り返し（デッドエンド）: 進行方向を反転し、今まで最後尾だった車両が新しい先頭になるように
          // 車両の並び順（経路履歴のラグ割り当て）を反転させる。
          train.direction.negate();
          train.targetTile = { ...train.currentTile };
          train.isReversed = !train.isReversed;
          train.cars.reverse();
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

      // ③ 勾配ピッチ角（車体の前上がり・前下がり）
      const heightDiff = toH - fromH;
      const pitch = Math.abs(heightDiff) > 0.05
        ? Math.atan2(heightDiff, WorldMap.TILE_SIZE) * (train.direction.z >= 0 ? 1 : -1)
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
      car.rotation.set(sample.pitch, sample.yaw, sample.cant);
    }
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
}
