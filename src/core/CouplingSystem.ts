// 駅・信号場での分割併合システム（最大10両制限厳守）
// 「先行両数＋後続両数 ≤ 10両」かつ「合計両数 ≤ ホーム有効長」の安全条件を満たす場合のみ
// 後続列車の徐行進入・連結を許可する。実際の列車データの合体・分離処理は TrainManager が担い、
// このモジュールは常に「進入・分割してよいか」を決める純粋な安全判定のみを受け持つ。

import { SplitConfig } from '../simulation/WorldMap';

export const MAX_TRAIN_CARS = 10;

export interface CoupleEligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * ホームで停車中の先行編成に対し、後続編成が進入・連結してよいかを判定する。
 * 「合計両数 ≤ 10両」かつ「合計両数 ≤ ホーム有効長」を両方満たす場合のみ許可。
 */
export function checkCoupleEligibility(
  leadingCarCount: number,
  incomingCarCount: number,
  platformEffectiveLength: number
): CoupleEligibility {
  const combined = leadingCarCount + incomingCarCount;
  if (combined > MAX_TRAIN_CARS) {
    return { eligible: false, reason: `連結後${combined}両は最大${MAX_TRAIN_CARS}両制限を超過するため進入不可` };
  }
  if (combined > platformEffectiveLength) {
    return { eligible: false, reason: `連結後${combined}両がホーム有効長(${platformEffectiveLength}両)を超過するため進入不可` };
  }
  return { eligible: true };
}

export interface SplitValidation {
  valid: boolean;
  reason?: string;
}

/** 分割設定が現在の編成両数と整合しているかを検証する */
export function validateSplitConfig(carCount: number, config: SplitConfig | undefined): SplitValidation {
  if (!config || !config.enabled) return { valid: false };
  if (config.frontCars < 1 || config.rearCars < 1) {
    return { valid: false, reason: '分割後の両数はそれぞれ1両以上に設定してください' };
  }
  if (config.frontCars + config.rearCars !== carCount) {
    return { valid: false, reason: `前後合計(${config.frontCars + config.rearCars}両)が編成両数(${carCount}両)と一致していません` };
  }
  return { valid: true };
}
