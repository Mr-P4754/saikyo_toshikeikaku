// わがまちレールウェイ コア定数定義

import { TrainSpeedDefinition } from './types';

/** チャンクサイズ (マス) */
export const CHUNK_SIZE = 32;

/** カメラズーム制限 (画面短辺マス数) */
export const CAMERA_ZOOM_LIMITS = {
  MIN_TILES: 12, // 最大ズームイン
  MAX_TILES: 100 // 最大ズームアウト（スマホ負荷クラッシュ防止）
} as const;

/** 時間・物理同期定数: 現実1秒 = ゲーム内1分 = 最低速車両の1マス移動 */
export const TIME_SIMULATION = {
  REAL_SECONDS_PER_GAME_MINUTE: 1.0,
  GAME_MINUTES_PER_DAY: 1440,
  BASE_SPEED_TILES_PER_MINUTE: 1.0 // 貨物・旧型基準
} as const;

/** 列車種別速度定義 (マス/分) */
export const TRAIN_SPEED_DEFINITIONS: Record<string, TrainSpeedDefinition> = {
  freight: { type: 'freight', name: '貨物・旧型', speedRatio: 1.0 },
  local: { type: 'local', name: '普通・各停', speedRatio: 1.5 },
  rapid: { type: 'rapid', name: '快速', speedRatio: 2.0 },
  express: { type: 'express', name: '特急', speedRatio: 3.0 }
} as const;

/** 階層定義 (全7階層) */
export const GRID_LAYERS = [-2, -1, 1, 2, 3, 4, 5] as const;

/** 最大編成長 */
export const MAX_TRAIN_CARS = 10;
