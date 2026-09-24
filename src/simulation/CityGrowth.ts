import { WorldMap, TileData } from './WorldMap';
import { GridManager } from '../core/GridManager';
import { ZoneManager } from '../core/ZoneManager';
import { GridLayer } from '../core/types';

export class CityGrowth {
  private worldMap: WorldMap;
  private gridManager: GridManager | null = null;
  private zoneManager: ZoneManager | null = null;
  private lastEvaluatedDay: number = -1; // 発展を実行した最後の日

  constructor(worldMap: WorldMap, gridManager?: GridManager) {
    this.worldMap = worldMap;
    if (gridManager) {
      this.gridManager = gridManager;
    }
  }

  public setGridManager(gridManager: GridManager) {
    this.gridManager = gridManager;
  }

  public setZoneManager(zoneManager: ZoneManager) {
    this.zoneManager = zoneManager;
  }

  /**
   * 1日1回、正午（12:00）にまとめて都市を発展させる
   */
  public update(hour: number, minute: number, day: number, onNewBuildings: (popIncrease: number) => void) {
    if (hour === 12 && minute === 0 && this.lastEvaluatedDay !== day) {
      this.lastEvaluatedDay = day;
      this.evaluateGrowth(onNewBuildings);
    }
  }

  public evaluateGrowth(onNewBuildings: (popIncrease: number) => void) {
    const stationGroups = new Map<string, TileData>();
    const allTiles = this.worldMap.getAllTiles();
    for (const t of allTiles) {
      if (t.type.startsWith('station')) {
        const tLayer = (t.layer ?? 1) as GridLayer;
        const start = this.worldMap.getStationStartTile(t.x, t.z, tLayer) || t;
        const key = `${start.x}_${start.z}`;
        if (!stationGroups.has(key)) {
          stationGroups.set(key, start);
        }
      }
    }

    let totalNewPop = 0;
    const GROUND_LAYER: GridLayer = 1;

    if (stationGroups.size > 0) {
      for (const st of stationGroups.values()) {
      const agg = this.worldMap.getStationAggregateData(st.x, st.z);
      const passengers = agg ? agg.totalPassengers : (st.totalPassengers ?? 0);
      if (passengers <= 0) continue;

      let passengerMultiplier = 0.6;
      if (passengers >= 1500) passengerMultiplier = 1.8;
      else if (passengers >= 500) passengerMultiplier = 1.4;
      else if (passengers >= 100) passengerMultiplier = 1.0;

      const radius = passengers >= 500 ? 5 : 4;
      const maxNewHouses = passengers >= 500 ? 3 : 2; // 少し建築数を増やす
      let newHousesCount = 0;
      let newCommercialCount = 0;

      const candidateOffsets: { dx: number; dz: number; dist: number }[] = [];
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const dist = Math.hypot(dx, dz);
          if (dist > radius || (dx === 0 && dz === 0)) continue;
          candidateOffsets.push({ dx, dz, dist });
        }
      }
      for (let i = candidateOffsets.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidateOffsets[i], candidateOffsets[j]] = [candidateOffsets[j], candidateOffsets[i]];
      }

      for (const { dx, dz, dist } of candidateOffsets) {
        const tx = st.x + dx;
        const tz = st.z + dz;
        const tile = this.worldMap.getTile(tx, tz, GROUND_LAYER);
        if (!tile) continue;

        if (this.gridManager && this.gridManager.isWaterAtGroundLevel(tx, tz)) continue;
        if (this.gridManager) {
          const cell = this.gridManager.getCell(tx, 1, tz);
          if (cell && cell.elevation > 1) continue;
        }

        const hasRoadAdjacent = this.hasNeighborOfType(tx, tz, 'road', GROUND_LAYER);
        const residentialZoned = this.zoneManager && this.zoneManager.hasAnyZoneOfType('residential');
        const commercialZoned = this.zoneManager && this.zoneManager.hasAnyZoneOfType('commercial');
        const zoneHere = this.zoneManager ? this.zoneManager.getZone(tx, tz) : undefined;

        // 【修正】更地タイルの建築ロジック。商業ゾーンならいきなり商業ビルが建つように緩和。
        if (tile.type === 'empty') {
          const isComZone = zoneHere?.type === 'commercial';
          const isResZone = zoneHere?.type === 'residential' || (!residentialZoned && !commercialZoned);

          // 建築確率を少し引き上げ
          const baseChance = ((radius - dist + 1) / (radius + 1)) * (hasRoadAdjacent ? 0.3 : 0.1);
          const spawnChance = baseChance * passengerMultiplier;

          if (Math.random() < spawnChance) {
            if (isComZone && newCommercialCount < 2) {
              this.worldMap.setTile(tx, tz, 'commercial', 0, 1, 'right', GROUND_LAYER);
              newCommercialCount++;
              totalNewPop += Math.floor(Math.random() * 35 + 25);
            } else if (zoneHere?.type === 'industrial') {
              // 工業ゾーンも更地から直接工場を建設
              this.worldMap.setTile(tx, tz, 'industrial', 0, 1, 'right', GROUND_LAYER);
              totalNewPop += Math.floor(Math.random() * 20 + 15);
            } else if (isResZone && newHousesCount < maxNewHouses) {
              this.worldMap.setTile(tx, tz, 'residence', 0, 1, 'right', GROUND_LAYER);
              newHousesCount++;
              totalNewPop += Math.floor(Math.random() * 15 + 10);
            }
          }
        }
        else if (tile.type === 'residence' && dist <= 2.2 && passengers >= 50 && newCommercialCount < 1) {
          // 【緩和】既存住宅からの商業アップグレード条件の乗客数を 100人 → 50人 に緩和
          const allowedByZone = !commercialZoned || zoneHere?.type === 'commercial';
          if (allowedByZone) {
            const commercialChance = (passengers >= 500 ? 0.15 : 0.08);
            if (Math.random() < commercialChance) {
              const newLvl = Math.min(4, tile.level + 1);
              this.worldMap.setTile(tx, tz, 'commercial', 0, newLvl, 'right', GROUND_LAYER);
              newCommercialCount++;
              totalNewPop += Math.floor(Math.random() * 35 + 25);
            }
          }
        }

        if (newHousesCount >= maxNewHouses && newCommercialCount >= 2) break;
      }
    }
  }

    if (this.zoneManager) {
      for (const t of allTiles) {
        if ((t.layer ?? 1) !== 1) continue;
        const zone = this.zoneManager.getZone(t.x, t.z);

        // 商業ビルの発展
        if (t.type === 'commercial' && zone?.type === 'commercial') {
          const targetLevel = zone.commercialAttractiveness >= 70 ? 4 : zone.commercialAttractiveness >= 35 ? 3 : zone.commercialAttractiveness >= 10 ? 2 : 1;
          if (targetLevel > t.level && Math.random() < 0.5) { // アップグレード確率向上
            this.worldMap.setTile(t.x, t.z, 'commercial', t.rotation, targetLevel, 'right', GROUND_LAYER);
            totalNewPop += Math.floor(Math.random() * 20 + 10);
          }
        }

        // 工業施設の発展
        if (t.type === 'industrial' && zone?.type === 'industrial') {
          // 日々の生産・稼働活動による工業ストック（industrialStock）の蓄積
          this.zoneManager.addIndustrialStock(zone, 1);
          const targetLevel = zone.industrialStock >= 35 ? 3 : zone.industrialStock >= 15 ? 2 : 1;
          if (targetLevel > t.level && Math.random() < 0.35) {
            this.worldMap.setTile(t.x, t.z, 'industrial', t.rotation, targetLevel, 'right', GROUND_LAYER);
            totalNewPop += Math.floor(Math.random() * 25 + 15);
          }
        }
      }

      // 駅遠方でも道路または線路インフラにアクセス可能な工業ゾーンの自動建設
      for (const zone of this.zoneManager.getAllZones()) {
        if (zone.type !== 'industrial') continue;
        const tile = this.worldMap.getTile(zone.x, zone.z, GROUND_LAYER);
        if (!tile || tile.type !== 'empty') continue;

        if (this.gridManager) {
          if (this.gridManager.isWaterAtGroundLevel(zone.x, zone.z)) continue;
          const cell = this.gridManager.getCell(zone.x, 1, zone.z);
          if (cell && cell.elevation > 1) continue;
        }

        const hasRoadOrTrack =
          this.hasNeighborOfType(zone.x, zone.z, 'road', GROUND_LAYER) ||
          this.hasNeighborOfType(zone.x, zone.z, 'rail', GROUND_LAYER) ||
          this.hasNeighborOfType(zone.x, zone.z, 'cargo_station', GROUND_LAYER) ||
          this.hasNeighborOfType(zone.x, zone.z, 'station', GROUND_LAYER);

        if (hasRoadOrTrack && Math.random() < 0.15) {
          this.worldMap.setTile(zone.x, zone.z, 'industrial', 0, 1, 'right', GROUND_LAYER);
          totalNewPop += Math.floor(Math.random() * 20 + 10);
        }
      }
    }

    if (totalNewPop > 0) {
      onNewBuildings(totalNewPop);
    }
  }

  private hasNeighborOfType(x: number, z: number, typePrefix: string, layer: GridLayer = 1): boolean {
    const neighbors = [
      this.worldMap.getTile(x, z - 1, layer),
      this.worldMap.getTile(x, z + 1, layer),
      this.worldMap.getTile(x - 1, z, layer),
      this.worldMap.getTile(x + 1, z, layer)
    ];
    return neighbors.some(n => n && n.type.startsWith(typePrefix));
  }
}
