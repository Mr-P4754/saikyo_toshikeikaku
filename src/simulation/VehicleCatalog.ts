/**
 * ⑤ 列車カタログ（5種類に厳選・性能カスタマイズ済み）
 */
export interface VehicleModelInfo {
  id: string;
  name: string;
  category: 'commuter' | 'suburban' | 'rapid' | 'express' | 'limited-express';
  description: string;
  basePrice: number; // 1両あたりの購入価格
  baseCapacity: number; // 1両あたりの定員
  maxSpeed: number; // 最高速度 (km/h)
  farePerRide: number; // 乗客1人あたりの運賃 (円)
  dailyRunningCostPerCar: number; // 1両1日あたりの運行維持費 (円)
  // Visual properties (切妻型モデル)
  bodyColor: number; // 車体メイン色
  stripeColor: number; // 帯・アクセント色
  roofColor: number; // 屋根色
}

export const VEHICLE_CATALOG: VehicleModelInfo[] = [
  {
    id: 'commuter-train',
    name: '通勤型列車',
    category: 'commuter',
    description: '都市部の過密輸送を支える4ドア通勤型。高加減速・高定員で、低廉な運賃と低い運行費が強み。',
    basePrice: 22000000,
    baseCapacity: 150,
    maxSpeed: 95,
    farePerRide: 220,
    dailyRunningCostPerCar: 12000,
    bodyColor: 0xd1d5db, // メタリックシルバー
    stripeColor: 0x10b981, // 若草エメラルドグリーン
    roofColor: 0x475569
  },
  {
    id: 'suburban-train',
    name: '近郊型列車',
    category: 'suburban',
    description: '都市とベッドタウンを結ぶセミクロスシート近郊型。乗客定員と速度のバランスが優れ、汎用性抜群。',
    basePrice: 28000000,
    baseCapacity: 120,
    maxSpeed: 110,
    farePerRide: 320,
    dailyRunningCostPerCar: 18000,
    bodyColor: 0xfef9c3, // アイボリークリーム
    stripeColor: 0xe67e22, // オレンジ帯
    roofColor: 0x64748b
  },
  {
    id: 'rapid-train',
    name: '快速用列車',
    category: 'rapid',
    description: '主要駅を結ぶ高速快速用トレイン。軽量ステンレス車体で俊敏に走行し、高い運賃収入を生み出します。',
    basePrice: 35000000,
    baseCapacity: 110,
    maxSpeed: 125,
    farePerRide: 450,
    dailyRunningCostPerCar: 25000,
    bodyColor: 0xe2e8f0, // 明るいシルバー
    stripeColor: 0x0284c7, // スカイブルー
    roofColor: 0x334155
  },
  {
    id: 'express-train',
    name: '急行型列車',
    category: 'express',
    description: '長距離優等列車として設計された伝統の急行型。ゆったりとした車内空間と、割高な急行運賃が魅力。',
    basePrice: 42000000,
    baseCapacity: 90,
    maxSpeed: 135,
    farePerRide: 680,
    dailyRunningCostPerCar: 35000,
    bodyColor: 0x991b1b, // バーガンディ・深紅
    stripeColor: 0xfde047, // ゴールドイエロー帯
    roofColor: 0x334155
  },
  {
    id: 'limited-express-train',
    name: '特急型列車',
    category: 'limited-express',
    description: '鉄道会社の威信をかけたフラッグシップ特急。最高峰の160km/h走行と最高額の特急運賃で莫大な収益を実現。',
    basePrice: 55000000,
    baseCapacity: 75,
    maxSpeed: 160,
    farePerRide: 1100,
    dailyRunningCostPerCar: 50000,
    bodyColor: 0x0f172a, // ナイトネイビー
    stripeColor: 0x38bdf8, // ネオンシアン帯
    roofColor: 0x0284c7
  }
];

export function getVehicleById(id: string): VehicleModelInfo {
  return VEHICLE_CATALOG.find(v => v.id === id) || VEHICLE_CATALOG[0];
}

/**
 * ⑤ 走行費用（1日・1編成あたり）。各車種に定義された専用の走行費用 × 両数。
 */
export function getRunningCostPerDay(model: VehicleModelInfo, carCount: number): number {
  return model.dailyRunningCostPerCar * carCount;
}
