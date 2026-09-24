import { GridLayer } from './types';
import { GRID_LAYERS } from './constants';

export interface LayerMetadata {
  layer: GridLayer;
  name: string;
  shortName: string;
  height: number; // ワールド座標系の基準Y高さ (1階層 = 3.0m)
  isUnderground: boolean;
  isElevated: boolean;
  isGround: boolean;
}

export const LAYER_METADATA: Record<GridLayer, LayerMetadata> = {
  5: {
    layer: 5,
    name: '地上5F (展望高架)',
    shortName: '5F',
    height: 12.0,
    isUnderground: false,
    isElevated: true,
    isGround: false
  },
  4: {
    layer: 4,
    name: '地上4F (4段目高架)',
    shortName: '4F',
    height: 9.0,
    isUnderground: false,
    isElevated: true,
    isGround: false
  },
  3: {
    layer: 3,
    name: '地上3F (3段目高架)',
    shortName: '3F',
    height: 6.0,
    isUnderground: false,
    isElevated: true,
    isGround: false
  },
  2: {
    layer: 2,
    name: '地上2F (標準高架・鉄橋)',
    shortName: '2F',
    height: 3.0,
    isUnderground: false,
    isElevated: true,
    isGround: false
  },
  1: {
    layer: 1,
    name: '地上1F (地表)',
    shortName: '1F',
    height: 0.0,
    isUnderground: false,
    isElevated: false,
    isGround: true
  },
  [-1]: {
    layer: -1,
    name: '地下B1F (地下鉄)',
    shortName: 'B1',
    height: -3.0,
    isUnderground: true,
    isElevated: false,
    isGround: false
  },
  [-2]: {
    layer: -2,
    name: '地下B2F (深層地下鉄)',
    shortName: 'B2',
    height: -6.0,
    isUnderground: true,
    isElevated: false,
    isGround: false
  }
};

/**
 * 全7階層のレイヤー順序リスト（上から下へ: 5F, 4F, 3F, 2F, 1F, B1, B2）
 */
export const ORDERED_LAYERS: GridLayer[] = [5, 4, 3, 2, 1, -1, -2];

/**
 * 階層レイヤーからワールド座標のY高さを取得する
 * @param layer 階層 (-2..5)
 * @param elevationOffset 地形標高オフセット (elevation - 1) * 3.0 (地上1Fのみ加算)
 */
export function layerToHeight(layer: GridLayer, elevationOffset: number = 0): number {
  const meta = LAYER_METADATA[layer];
  const baseH = meta ? meta.height : 0;
  // 地上1Fの場合は山岳などの標高オフセットを加算
  return layer === 1 ? baseH + elevationOffset : baseH;
}

/**
 * ワールドY座標に最も近い階層レイヤーを判定する
 */
export function heightToLayer(worldY: number): GridLayer {
  let closestLayer: GridLayer = 1;
  let minDiff = Infinity;
  for (const layer of GRID_LAYERS) {
    const meta = LAYER_METADATA[layer];
    const diff = Math.abs(worldY - meta.height);
    if (diff < minDiff) {
      minDiff = diff;
      closestLayer = layer;
    }
  }
  return closestLayer;
}

/**
 * 3次元グリッドキーの生成
 */
export function getGrid3DKey(x: number, layer: GridLayer, z: number): string {
  return `${x},${layer},${z}`;
}

/**
 * 3次元全7階層グリッドコンテナ
 */
export class Grid3D<T> {
  private data: Map<string, T> = new Map();

  public get(x: number, layer: GridLayer, z: number): T | undefined {
    return this.data.get(getGrid3DKey(x, layer, z));
  }

  public set(x: number, layer: GridLayer, z: number, value: T): void {
    this.data.set(getGrid3DKey(x, layer, z), value);
  }

  public delete(x: number, layer: GridLayer, z: number): boolean {
    return this.data.delete(getGrid3DKey(x, layer, z));
  }

  public has(x: number, layer: GridLayer, z: number): boolean {
    return this.data.has(getGrid3DKey(x, layer, z));
  }

  public clear(): void {
    this.data.clear();
  }

  public entries(): IterableIterator<[string, T]> {
    return this.data.entries();
  }

  public values(): IterableIterator<T> {
    return this.data.values();
  }

  /**
   * 指定した (x, z) 柱状空間に存在するすべての階層の要素を取得
   */
  public getColumn(x: number, z: number): Array<{ layer: GridLayer; value: T }> {
    const col: Array<{ layer: GridLayer; value: T }> = [];
    for (const layer of ORDERED_LAYERS) {
      const val = this.get(x, layer, z);
      if (val !== undefined) {
        col.push({ layer, value: val });
      }
    }
    return col;
  }
}
