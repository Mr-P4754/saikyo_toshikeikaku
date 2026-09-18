import { WorldMap, TileData } from './WorldMap';

export class CityGrowth {
  private worldMap: WorldMap;
  private growthTimer: number = 0;
  private growthInterval: number = 7.0; // 7秒ごとに評価（じっくり時間をかけて発展するペース）

  constructor(worldMap: WorldMap) {
    this.worldMap = worldMap;
  }

  /**
   * Update city development based on station proximity & roads
   */
  public update(deltaTime: number, speedMultiplier: number, onNewBuildings: (popIncrease: number) => void) {
    if (speedMultiplier <= 0) return;

    this.growthTimer += deltaTime * speedMultiplier;
    if (this.growthTimer < this.growthInterval) return;
    this.growthTimer = 0;

    // 1. 重複を排除して駅グループ単位で代表タイル（始点タイル）を抽出
    const stationGroups = new Map<string, TileData>();
    const allTiles = this.worldMap.getAllTiles();
    for (const t of allTiles) {
      if (t.type.startsWith('station')) {
        const start = this.worldMap.getStationStartTile(t.x, t.z) || t;
        const key = `${start.x}_${start.z}`;
        if (!stationGroups.has(key)) {
          stationGroups.set(key, start);
        }
      }
    }

    if (stationGroups.size === 0) return;

    let totalNewPop = 0;

    // ③ 駅乗降客数に応じたゆったりとした発展の適用
    for (const st of stationGroups.values()) {
      const agg = this.worldMap.getStationAggregateData(st.x, st.z);
      const passengers = agg ? agg.totalPassengers : (st.totalPassengers ?? 0);

      // ④ 乗降客がゼロの駅は一切発展しない（列車が乗客を輸送して初めて発展がスタートする）
      if (passengers <= 0) continue;

      // 乗降客数に応じた発展係数（緩やかなカーブ）
      // 1-99人: 0.6, 100-499人: 1.0 (標準), 500-1499人: 1.4, 1500人以上: 1.8
      let passengerMultiplier = 0.6;
      if (passengers >= 1500) {
        passengerMultiplier = 1.8;
      } else if (passengers >= 500) {
        passengerMultiplier = 1.4;
      } else if (passengers >= 100) {
        passengerMultiplier = 1.0;
      }

      // 影響半径 (4マス〜5マス)
      const radius = passengers >= 500 ? 5 : 4;

      // 1回の発展サイクルで建設される建物の数を「駅あたり最大1〜2軒」に厳格に制限
      const maxNewHouses = passengers >= 500 ? 2 : 1;
      let newHousesCount = 0;
      let newCommercialCount = 0;

      // 周囲タイルの座標リストを作成してシャッフル（毎サイクル異なる場所が抽選されるようにする）
      const candidateOffsets: { dx: number; dz: number; dist: number }[] = [];
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const dist = Math.hypot(dx, dz);
          if (dist > radius || (dx === 0 && dz === 0)) continue;
          candidateOffsets.push({ dx, dz, dist });
        }
      }
      // ランダムソート
      for (let i = candidateOffsets.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidateOffsets[i], candidateOffsets[j]] = [candidateOffsets[j], candidateOffsets[i]];
      }

      for (const { dx, dz, dist } of candidateOffsets) {
        const tx = st.x + dx;
        const tz = st.z + dz;
        const tile = this.worldMap.getTile(tx, tz);
        if (!tile) continue;

        const hasRoadAdjacent = this.hasNeighborOfType(tx, tz, 'road');

        // 1. 更地タイル：低確率で住宅を建設（1サイクルあたり最大1〜2軒まで）
        if (tile.type === 'empty' && newHousesCount < maxNewHouses) {
          // 道路に隣接している場所を優先、離れた場所はさらに低確率
          const baseChance = ((radius - dist + 1) / (radius + 1)) * (hasRoadAdjacent ? 0.12 : 0.04);
          const spawnChance = baseChance * passengerMultiplier;

          if (Math.random() < spawnChance) {
            this.worldMap.setTile(tx, tz, 'residence', 0, 1);
            newHousesCount++;
            totalNewPop += Math.floor(Math.random() * 15 + 10);
          }
        }
        // 2. 駅至近の住宅：一定の利用客があり、かつ低確率で商業ビルへアップグレード（1サイクルあたり最大1軒まで）
        else if (tile.type === 'residence' && dist <= 2.2 && passengers >= 100 && newCommercialCount < 1) {
          const commercialChance = (passengers >= 500 ? 0.08 : 0.04);
          if (Math.random() < commercialChance) {
            const newLvl = Math.min(4, tile.level + 1);
            this.worldMap.setTile(tx, tz, 'commercial', 0, newLvl);
            newCommercialCount++;
            totalNewPop += Math.floor(Math.random() * 35 + 25);
          }
        }

        // 上限に達したらこの駅の探索を終了
        if (newHousesCount >= maxNewHouses && newCommercialCount >= 1) {
          break;
        }
      }
    }

    if (totalNewPop > 0) {
      onNewBuildings(totalNewPop);
    }
  }

  private hasNeighborOfType(x: number, z: number, typePrefix: string): boolean {
    const neighbors = [
      this.worldMap.getTile(x, z - 1),
      this.worldMap.getTile(x, z + 1),
      this.worldMap.getTile(x - 1, z),
      this.worldMap.getTile(x + 1, z)
    ];
    return neighbors.some(n => n && n.type.startsWith(typePrefix));
  }
}
