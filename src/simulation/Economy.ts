export interface FinancialReportData {
  fareIncome: number;
  constructionCost: number;
  maintenanceCost: number;
  netProfit: number;
  landValue: number;
  totalPopulation: number;
  trackLength: number;
  trainCount: number;
  stationCount: number;
}

export class Economy {
  public funds: number = 100000000; // ¥100,000,000 initial capital
  public population: number = 0;

  // Calendar
  public year: number = 1;
  public month: number = 4;
  public day: number = 1;

  // ⑤ ゲーム内時刻（当日の経過分数, 0-1440）。速度設定ごとの「現実1秒あたりのゲーム内分数」を直接加算する。
  private dayTimerMin: number = 0;

  // Accounting for current period
  public periodFareIncome: number = 0;
  public periodConstructionCost: number = 0;
  public periodMaintenanceCost: number = 0;

  constructor() {
    this.loadFromStorage();
  }

  public addFunds(amount: number) {
    this.funds += amount;
    if (amount > 0) {
      this.periodFareIncome += amount;
    }
  }

  public spendFunds(amount: number, isConstruction: boolean = true): boolean {
    if (this.funds < amount) {
      return false; // Insufficient funds
    }
    this.funds -= amount;
    if (isConstruction) {
      this.periodConstructionCost += amount;
    } else {
      this.periodMaintenanceCost += amount;
    }
    return true;
  }

  public addPopulation(amount: number) {
    this.population += amount;
  }

  /**
   * ⑤ ゲーム内カレンダーを進行させる。
   * minutesPerSecond: 現実1秒あたりに進むゲーム内分数
   *   （通常速度=10分/秒、高速=60分/秒(1時間/秒)、超高速=360分/秒(6時間/秒)）
   */
  public update(
    deltaTime: number,
    minutesPerSecond: number,
    onDayPassed: () => void,
    onMonthPassed: () => void
  ) {
    if (minutesPerSecond <= 0) return;

    this.dayTimerMin += deltaTime * minutesPerSecond;

    // 低フレームレートや超高速設定で1フレームに複数日進む場合に備えてループで消化する
    while (this.dayTimerMin >= 1440) {
      this.dayTimerMin -= 1440;
      this.day++;

      // End of month check
      const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][this.month - 1];
      if (this.day > daysInMonth) {
        this.day = 1;
        this.month++;
        if (this.month > 12) {
          this.month = 1;
          this.year++;
        }
        onMonthPassed();
      }

      onDayPassed();
    }
  }

  public getFormattedDate(): string {
    const yStr = String(this.year).padStart(2, '0');
    const mStr = String(this.month).padStart(2, '0');
    const dStr = String(this.day).padStart(2, '0');
    return `${yStr}年 ${mStr}月 ${dStr}日`;
  }

  /**
   * ⑥ ゲーム内時刻表示 (HH:MM)
   */
  public getFormattedTime(): string {
    const totalMinutes = Math.floor(this.dayTimerMin);
    const hh = String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0');
    const mm = String(totalMinutes % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  public getFormattedFunds(): string {
    return '¥' + this.funds.toLocaleString('ja-JP');
  }

  public getFormattedPopulation(): string {
    return this.population.toLocaleString('ja-JP') + '人';
  }

  public getFinancialReport(trackTiles: number, trainCount: number, stationCount: number): FinancialReportData {
    const netProfit = this.periodFareIncome - (this.periodConstructionCost + this.periodMaintenanceCost);
    return {
      fareIncome: this.periodFareIncome,
      constructionCost: this.periodConstructionCost,
      maintenanceCost: this.periodMaintenanceCost,
      netProfit,
      landValue: (this.population * 25000) + (trackTiles * 1500000),
      totalPopulation: this.population,
      trackLength: Math.round(trackTiles * 0.1 * 10) / 10,
      trainCount,
      stationCount
    };
  }

  public saveToStorage() {
    try {
      const data = {
        funds: this.funds,
        population: this.population,
        year: this.year,
        month: this.month,
        day: this.day,
        periodFareIncome: this.periodFareIncome,
        periodConstructionCost: this.periodConstructionCost,
        periodMaintenanceCost: this.periodMaintenanceCost
      };
      localStorage.setItem('stk_3d_economy', JSON.stringify(data));
    } catch (e) {
      console.warn('LocalStorage save failed', e);
    }
  }

  public loadFromStorage(): boolean {
    try {
      const raw = localStorage.getItem('stk_3d_economy');
      if (raw) {
        const data = JSON.parse(raw);
        this.funds = data.funds ?? 100000000;
        this.population = data.population ?? 0;
        this.year = data.year ?? 1;
        this.month = data.month ?? 4;
        this.day = data.day ?? 1;
        this.periodFareIncome = data.periodFareIncome ?? 0;
        this.periodConstructionCost = data.periodConstructionCost ?? 0;
        this.periodMaintenanceCost = data.periodMaintenanceCost ?? 0;
        return true;
      }
    } catch (e) {
      console.warn('LocalStorage load failed', e);
    }
    return false;
  }

  public resetAll() {
    this.funds = 100000000;
    this.population = 0;
    this.year = 1;
    this.month = 4;
    this.day = 1;
    this.periodFareIncome = 0;
    this.periodConstructionCost = 0;
    this.periodMaintenanceCost = 0;
    try {
      localStorage.removeItem('stk_3d_economy');
    } catch (e) {}
  }
}
