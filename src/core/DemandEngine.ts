// 時間帯需要マトリクス（長距離プール方式）
// 駅周辺のゾーン構成（住宅／商業／工業）と現在時刻から、方向性を持った乗客需要係数を算出する。
// 朝ラッシュ: 住宅駅で乗車需要が激増 / 夕ラッシュ: 商業・工業駅で乗車需要が激増 / 昼・深夜: 全体的に閑散。

import { ZoneManager, ZoneType } from './ZoneManager';

export type StationRole = ZoneType | 'mixed';

export type DemandPhase = 'morning_rush' | 'midday' | 'evening_rush' | 'night';

interface DemandCacheEntry {
  role: StationRole;
  attractiveness: number;
  hour: number;
  multiplier: number;
}

export class DemandEngine {
  // 【需要計算の重圧解消】駅座標ごとの役割・需要キャッシュ
  private demandCache: Map<string, DemandCacheEntry> = new Map();

  constructor(private zoneManager: ZoneManager) {}

  public clearCache(): void {
    this.demandCache.clear();
  }

  public getPhase(hour: number): DemandPhase {
    const h = ((hour % 24) + 24) % 24;
    if (h >= 7 && h < 9) return 'morning_rush';
    if (h >= 11 && h < 15) return 'midday';
    if (h >= 17 && h < 20) return 'evening_rush';
    if (h >= 23 || h < 5) return 'night';
    return 'midday';
  }

  /** 駅の役割をゾーン構成から判定（半径10マス圏内で優勢な用途） */
  public getStationRole(x: number, z: number): StationRole {
    return this.zoneManager.getDominantZoneType(x, z, 10) ?? 'mixed';
  }

  /**
   * 時間帯・駅役割に応じた乗客需要係数を返す。
   * 基準値(1.0)は「昼閑散期の駅」相当。ベースの時間帯カーブに、駅役割ごとの方向性ボーナスを掛け合わせる。
   * 【都市発展の無効化バグ解消】
   * 古いキャッシュの用途（更地評価）を永久に引き継ぐ不具合を解消し、時間帯更新時やキャッシュ無効化時に
   * 周辺の最新ゾーン構成・商業魅力度をリアルタイムに再評価して都市の発展を需要に反映する。
   */
  public getDemandMultiplier(hour: number, x: number, z: number): number {
    const h = ((hour % 24) + 24) % 24;
    const key = `${x},${z}`;
    const cached = this.demandCache.get(key);

    if (cached && cached.hour === h) {
      return cached.multiplier;
    }

    // 周辺ゾーンの最新状態を再取得（更地評価の永続固定を完全防止）
    const role = this.zoneManager.getDominantZoneType(x, z, 10) ?? 'mixed';
    const baseCurve = DemandEngine.baseHourCurve(h);

    let directional = 1.0;
    if (h >= 7 && h < 9) {
      // 朝ラッシュ: 住宅駅からの送り出しが最大化
      if (role === 'residential') directional = 3.2;
      else if (role === 'commercial' || role === 'industrial') directional = 2.4;
      else directional = 1.4;
    } else if (h >= 17 && h < 20) {
      // 夕ラッシュ: 商業・工業駅からの帰宅需要がピーク
      if (role === 'commercial' || role === 'industrial') directional = 3.0;
      else if (role === 'residential') directional = 2.2;
      else directional = 1.4;
    } else if (h >= 11 && h < 15) {
      // 昼閑散期: 旅客需要全体を抑制（貨物運行のゴールデンタイム）
      directional = 0.5;
    } else if (h >= 23 || h < 5) {
      // 深夜帯: 旅客需要激減
      directional = 0.15;
    }

    // 商業魅力度による買い物・通勤旅客需要への還元（駅周辺20マス圏内のローカル商業発展度を最新評価）
    const attractiveness = this.zoneManager.getCommercialAttractivenessAround(x, z, 20); // 0-1
    let attractivenessBoost = 1.0;
    if (role === 'residential' && attractiveness > 0) {
      // 近隣に商業エリアが発展しているほど、住宅駅からの旅客需要が増加する
      attractivenessBoost = 1.0 + attractiveness * 2.5;
    } else if (role === 'commercial' && attractiveness > 0) {
      // 商業駅自体も集客力上昇の恩恵を受ける
      attractivenessBoost = 1.0 + attractiveness * 1.5;
    }

    const multiplier = Math.max(0.02, baseCurve * directional * attractivenessBoost);

    // キャッシュを保存（同一時間帯内の不要な再計算を抑止）
    this.demandCache.set(key, {
      role,
      attractiveness,
      hour: h,
      multiplier
    });

    return multiplier;
  }

  private static baseHourCurve(h: number): number {
    switch (h) {
      case 0: return 0.1;
      case 1:
      case 2:
      case 3: return 0.03;
      case 4: return 0.08;
      case 5: return 0.3;
      case 6: return 0.8;
      case 7: return 1.0;
      case 8: return 1.0;
      case 9: return 0.9;
      case 10: return 0.7;
      case 11:
      case 12:
      case 13:
      case 14: return 0.6;
      case 15: return 0.7;
      case 16: return 0.85;
      case 17: return 1.0;
      case 18: return 1.0;
      case 19: return 0.9;
      case 20: return 0.6;
      case 21: return 0.4;
      case 22: return 0.25;
      case 23: return 0.15;
      default: return 0.5;
    }
  }
}
