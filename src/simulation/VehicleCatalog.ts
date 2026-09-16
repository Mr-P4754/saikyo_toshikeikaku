/**
 * オリジナル車両カタログ（実在車両名不使用・原作オマージュ）
 */
export interface VehicleModelInfo {
  id: string;
  name: string;
  category: 'diesel' | 'commuter' | 'suburban' | 'express';
  nickname: string;
  description: string;
  basePrice: number; // 1両あたりの基本価格
  baseCapacity: number; // 1両あたりの定員
  maxSpeed: number; // km/h
  farePerRide: number; // ⑩ 乗客1人あたりの運賃
  // Visual properties
  bodyColor: number; // メイン車体色
  stripeColor: number; // 帯色
  roofColor: number; // 屋根色
  cabShape: 'flat' | 'slanted' | 'streamline'; // 前面形状
}

export const VEHICLE_CATALOG: VehicleModelInfo[] = [
  {
    id: 'kiha-400',
    name: 'キハ400形 気動車',
    category: 'diesel',
    nickname: 'ノスタルジア',
    description: '非電化ローカル線で親しまれる国鉄調の暖かみのある朱色とクリームの気動車。単行(1両)運行に最適。',
    basePrice: 20000000,
    baseCapacity: 60,
    maxSpeed: 85,
    farePerRide: 260,
    bodyColor: 0xe67e22, // オレンジ/朱色
    stripeColor: 0xfdfefe, // クリーム白帯
    roofColor: 0x7f8c8d,
    cabShape: 'flat'
  },
  {
    id: 'kiha-1100',
    name: 'キハ1100形 軽快気動車',
    category: 'diesel',
    nickname: 'はやて',
    description: '加速性能に優れたモダンな白とグリーンの最新鋭ディーゼルカー。山岳路線や勾配区間に強い。',
    basePrice: 25000000,
    baseCapacity: 65,
    maxSpeed: 100,
    farePerRide: 300,
    bodyColor: 0xf8fafc, // ホワイト
    stripeColor: 0x10b981, // エメラルドグリーン
    roofColor: 0x64748b,
    cabShape: 'slanted'
  },
  {
    id: 'commuter-1070',
    name: '1070系 直流近郊電車',
    category: 'suburban',
    nickname: 'ニッコウ',
    description: '伝統的な2ドア近郊型電車。クリームとバーガンディのラインが特徴的な安定のロングセラー。',
    basePrice: 24000000,
    baseCapacity: 90,
    maxSpeed: 105,
    farePerRide: 320,
    bodyColor: 0xfef9c3, // アイボリークリーム
    stripeColor: 0x991b1b, // バーガンディ/ワインレッド
    roofColor: 0x475569,
    cabShape: 'flat'
  },
  {
    id: 'commuter-2050',
    name: '2050系 軽量通勤電車',
    category: 'commuter',
    nickname: 'シティライナー',
    description: '軽量ステンレス車体に鮮やかなスカイブルー帯を巻いた都市通勤用電車。コストパフォーマンス抜群。',
    basePrice: 28000000,
    baseCapacity: 120,
    maxSpeed: 110,
    farePerRide: 350,
    bodyColor: 0xd1d5db, // シルバーメタリック
    stripeColor: 0x0284c7, // スカイブルー
    roofColor: 0x64748b,
    cabShape: 'slanted'
  },
  {
    id: 'suburban-2170',
    name: '2170系 大型近郊電車',
    category: 'suburban',
    nickname: 'マリンブルー',
    description: '都市と近郊を結ぶ大容量近郊電車。ブルーとクリームのラインで長距離高速輸送に対応。',
    basePrice: 32000000,
    baseCapacity: 135,
    maxSpeed: 120,
    farePerRide: 420,
    bodyColor: 0xd1d5db, // シルバー
    stripeColor: 0x1e3a8a, // ディープマリンブルー
    roofColor: 0x334155,
    cabShape: 'slanted'
  },
  {
    id: 'metro-2310',
    name: '2310系 標準都市型電車',
    category: 'commuter',
    nickname: 'メトロポリス',
    description: '最新鋭のVVVFインバータを搭載した主力通勤電車。高い加減速力で高密度輸送を支える。',
    basePrice: 35000000,
    baseCapacity: 140,
    maxSpeed: 120,
    farePerRide: 400,
    bodyColor: 0xd1d5db, // シルバー
    stripeColor: 0x059669, // フォレストグリーン
    roofColor: 0x475569,
    cabShape: 'slanted'
  },
  {
    id: 'private-3000',
    name: '3000系 私鉄優等電車',
    category: 'commuter',
    nickname: 'アーバンエキスプレス',
    description: '私鉄直通運転で活躍するスタイリッシュな赤いストライプの電車。客車内の静粛性と乗り心地が抜群。',
    basePrice: 33000000,
    baseCapacity: 125,
    maxSpeed: 115,
    farePerRide: 460,
    bodyColor: 0xe2e8f0, // 明るいシルバー
    stripeColor: 0xd97706, // サンライズオレンジ＆レッド
    roofColor: 0x475569,
    cabShape: 'slanted'
  },
  {
    id: 'express-aex',
    name: '特急 EXP-AE "スカイアロー"',
    category: 'express',
    nickname: 'スカイアロー',
    description: '空港直通・都市間特急用の最高速流線型トレイン。圧倒的な高速性能と美しいエアロダイナミクスボディ。',
    basePrice: 50000000,
    baseCapacity: 110,
    maxSpeed: 160,
    farePerRide: 850,
    bodyColor: 0x0f172a, // ナイトブルー＆メタリックホワイト
    stripeColor: 0x38bdf8, // ネオンシアン
    roofColor: 0x0284c7,
    cabShape: 'streamline'
  }
];

export function getVehicleById(id: string): VehicleModelInfo {
  return VEHICLE_CATALOG.find(v => v.id === id) || VEHICLE_CATALOG[3];
}

/**
 * ⑩ 走行費用（1日・1編成あたり）。運賃単価と最高速度によって決まる
 * （高速・高運賃の車両ほど、電力・保守などの走行コストも大きくなる）。
 */
export function getRunningCostPerDay(model: VehicleModelInfo, carCount: number): number {
  return Math.round((model.maxSpeed * 3000 + model.farePerRide * 40) * carCount);
}
