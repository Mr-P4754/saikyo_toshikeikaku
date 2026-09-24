import { StationSchedule, StationActionMode, isMinuteInZone } from '../simulation/WorldMap';
export { isMinuteInZone };

export interface ArrivalDecision {
  mode: StationActionMode;
  requiredStopMinutes: number;
  isReverse?: boolean;
}

export interface DepartureEvaluation {
  canDepart: boolean;
  shouldReverse: boolean;
}

/** 
 * ホーム到着時、現在の時刻から「時間帯ゾーン」を評価し、初期動作モードを決定する。
 * 何も設定されていない時間帯はデフォルトで「hold（留置・発車時刻まで待機）」となる。
 */
export function resolveArrival(schedule: StationSchedule | undefined, hour: number, minute: number): ArrivalDecision {
  if (!schedule) return { mode: 'hold', requiredStopMinutes: 0 };
  const currentMin = hour * 60 + minute;

  // 現在時刻に合致するすべてのゾーンを抽出
  const activeZones = (schedule.timeZones || []).filter(z => isMinuteInZone(currentMin, z.startMin, z.endMin));

  if (activeZones.length === 0) {
    return { mode: 'hold', requiredStopMinutes: 0 };
  }

  // 1. 通過ゾーンがあれば通過優先
  const passZone = activeZones.find(z => z.mode === 'pass');
  if (passZone) {
    return { mode: 'pass', requiredStopMinutes: 0, isReverse: !!passZone.isReverse };
  }

  // 2. パターンダイヤゾーンがあれば待機（発車分まで停車）
  const patternZones = activeZones.filter(z => z.mode === 'pattern');
  if (patternZones.length > 0) {
    const anyReverse = patternZones.some(z => z.isReverse);
    return { mode: 'wait', requiredStopMinutes: 0, isReverse: anyReverse };
  }

  // 3. 停車時間指定ゾーン
  const stopZone = activeZones.find(z => z.mode === 'stop');
  if (stopZone) {
    return { mode: 'stop', requiredStopMinutes: stopZone.waitMinutes || 1, isReverse: !!stopZone.isReverse };
  }

  return { mode: 'hold', requiredStopMinutes: 0 };
}

/**
 * 対象のゲーム内時刻（0-1439分）が前フレームからの進行区間内に含まれるかを判定（日跨ぎ・フレームスキップ対応）
 */
export function isMinuteInRange(prevTotalMin: number, currentTotalMin: number, targetMin: number): boolean {
  if (prevTotalMin === currentTotalMin) {
    return targetMin === currentTotalMin;
  }
  const diff = (currentTotalMin - prevTotalMin + 1440) % 1440;
  // 12時間（720分）以上のワープは不自然なので完全一致にフォールバック
  if (diff > 720) {
    return targetMin === currentTotalMin;
  }
  const targetOffset = (targetMin - prevTotalMin + 1440) % 1440;
  return targetOffset > 0 && targetOffset <= diff;
}

/**
 * 毎時XX分（0-59分）が前フレームからの進行区間内に1回以上通過したかを判定（時跨ぎ・フレームスキップ対応）
 */
export function isPatternMinuteInRange(prevTotalMin: number, currentTotalMin: number, patternMinute: number): boolean {
  if (prevTotalMin === currentTotalMin) {
    return (currentTotalMin % 60) === patternMinute;
  }
  const diff = (currentTotalMin - prevTotalMin + 1440) % 1440;
  if (diff >= 60 || diff > 720) {
    // 60分以上スキップした場合は毎時全分を通過済み
    return true;
  }
  const startMinInHour = prevTotalMin % 60;
  const targetOffset = (patternMinute - startMinInHour + 60) % 60;
  return targetOffset > 0 && targetOffset <= diff;
}

/**
 * 駅停車中における動的発車判定
 * 到着時の固定値だけに依存せず、現在の時刻・最新スケジュール・経過時間からリアルタイムに判定する。
 * 複数のパターンダイヤや時間帯設定が重複していても、合致する発車ルールを漏れなく全件評価する。
 * 高倍速やフレーム落ちで時刻が飛んだ場合（prevHour, prevMinuteからの区間跨ぎ）も発車時刻を漏らさず検知する。
 */
export function evaluateStationDeparture(
  schedule: StationSchedule | undefined,
  currentHour: number,
  currentMinute: number,
  stopElapsedMinutes: number,
  initialMode: StationActionMode = 'hold',
  initialRequiredStopMinutes: number = 0,
  initialReverse: boolean = false,
  prevHour?: number,
  prevMinute?: number
): DepartureEvaluation {
  if (!schedule) return { canDepart: false, shouldReverse: false };

  const currentMin = ((currentHour % 24) * 60 + currentMinute) % 1440;
  const prevMin = (prevHour !== undefined && prevMinute !== undefined && prevHour >= 0 && prevMinute >= 0)
    ? ((prevHour % 24) * 60 + prevMinute) % 1440
    : currentMin;

  // 1. 発車時刻指定ピン（departures）のチェック（最優先）
  if (schedule.departures && schedule.departures.length > 0) {
    const matchedDep = schedule.departures.find(dep => isMinuteInRange(prevMin, currentMin, dep));
    if (matchedDep !== undefined) {
      const isRev = !!(schedule.reverseDepartures && schedule.reverseDepartures.some(rd => isMinuteInRange(prevMin, currentMin, rd)));
      return { canDepart: true, shouldReverse: isRev || initialReverse };
    }
  }

  // 2. 現在時刻（または通過区間）に一致する全時間帯ゾーンを収集
  const activeZones = (schedule.timeZones || []).filter(z =>
    isMinuteInZone(currentMin, z.startMin, z.endMin) ||
    (prevMin !== currentMin && isMinuteInZone(prevMin, z.startMin, z.endMin))
  );

  if (activeZones.length > 0) {
    // 2-a. 通過ゾーン: 即座に発車
    const passZone = activeZones.find(z => z.mode === 'pass');
    if (passZone) {
      return { canDepart: true, shouldReverse: !!passZone.isReverse || initialReverse };
    }

    // 2-b. パターンダイヤゾーン: フレームスキップによる分飛びを許容し、区間内に合致するものを全探索
    const matchedPattern = activeZones.find(z => {
      if (z.mode !== 'pattern') return false;
      const patMin = z.patternMinute ?? 0;
      return isPatternMinuteInRange(prevMin, currentMin, patMin);
    });
    if (matchedPattern) {
      return { canDepart: true, shouldReverse: !!matchedPattern.isReverse || initialReverse };
    }

    // 2-c. 〇分停車ゾーン: 指定停車時間（waitMinutes）が経過していれば発車
    const readyStopZone = activeZones.find(z => z.mode === 'stop' && stopElapsedMinutes >= (z.waitMinutes || 1));
    if (readyStopZone) {
      return { canDepart: true, shouldReverse: !!readyStopZone.isReverse || initialReverse };
    }

    // activeZones にパターンダイヤや未完了のstopゾーンが含まれている場合は、その発車タイミングまで待機
    const hasPattern = activeZones.some(z => z.mode === 'pattern');
    const hasStop = activeZones.some(z => z.mode === 'stop');
    if (hasPattern || hasStop) {
      return { canDepart: false, shouldReverse: false };
    }
  }

  // 3. 到着時モードに基づくフォールバック判定
  if (initialMode === 'stop' && initialRequiredStopMinutes > 0) {
    if (stopElapsedMinutes >= initialRequiredStopMinutes) {
      return { canDepart: true, shouldReverse: initialReverse };
    }
  }

  if (initialMode === 'reverse') {
    const delay = getReverseDelayMinutes(schedule);
    if (stopElapsedMinutes >= delay) {
      return { canDepart: true, shouldReverse: true };
    }
  }

  return { canDepart: false, shouldReverse: false };
}

/**
 * 毎フレーム発車可能か判定する（後方互換用関数）
 */
export function canDepart(
  schedule: StationSchedule | undefined,
  mode: StationActionMode,
  hour: number,
  minute: number,
  elapsedMinutes: number,
  requiredStopMinutes: number
): boolean {
  return evaluateStationDeparture(schedule, hour, minute, elapsedMinutes, mode, requiredStopMinutes).canDepart;
}

export function getReverseDelayMinutes(schedule: StationSchedule | undefined): number {
  return Math.max(0, Math.round(schedule?.reverseDelayMinutes ?? 3));
}
