import { WorldMap, TileData } from './WorldMap';

export class CityGrowth {
  private worldMap: WorldMap;
  private growthTimer: number = 0;
  private growthInterval: number = 5.0; // Evaluate growth every 5 seconds

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

    // 1. Find all stations
    const stations: TileData[] = [];
    const allTiles = this.worldMap.getAllTiles();
    for (const t of allTiles) {
      if (t.type.startsWith('station')) {
        stations.push(t);
      }
    }

    if (stations.length === 0) return;

    let totalNewPop = 0;

    // 2. Evaluate empty tiles or upgradeable buildings near stations
    for (const st of stations) {
      const radius = 5; // Station influence radius
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const dist = Math.hypot(dx, dz);
          if (dist > radius || (dx === 0 && dz === 0)) continue;

          const tx = st.x + dx;
          const tz = st.z + dz;
          const tile = this.worldMap.getTile(tx, tz);
          if (!tile) continue;

          // Check if adjacent to road or track
          const hasRoadAdjacent = this.hasNeighborOfType(tx, tz, 'road');

          // Empty tile: Chance to build Residence
          if (tile.type === 'empty') {
            const spawnChance = (radius - dist) / radius * (hasRoadAdjacent ? 0.45 : 0.2);
            if (Math.random() < spawnChance) {
              this.worldMap.setTile(tx, tz, 'residence', 0, 1);
              totalNewPop += Math.floor(Math.random() * 25 + 15);
            }
          }
          // Residence close to station (< 2.5 tiles): Chance to upgrade to Commercial High-rise!
          else if (tile.type === 'residence' && dist <= 2.8) {
            if (Math.random() < 0.25) {
              const newLvl = Math.min(4, tile.level + 1);
              this.worldMap.setTile(tx, tz, 'commercial', 0, newLvl);
              totalNewPop += Math.floor(Math.random() * 80 + 50);
            }
          }
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
