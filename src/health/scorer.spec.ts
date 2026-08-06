import { Prisma } from '@prisma/client';
import {
  GRADE_BANDS,
  HealthInput,
  NEUTRAL_SCORE,
  WEIGHTS,
  budgetDisciplineDim,
  debtPressureDim,
  emergencyFundDim,
  gradeOf,
  recordStreakDim,
  savingRateDim,
  scoreHealth,
} from './scorer';

const dec = (s: string | number) => new Prisma.Decimal(s);

/** 各维度都健康的基准输入：储蓄率 50%、预算全守住、应急金 12 个月、天天记账、无借贷 */
const healthyInput = (): HealthInput => ({
  last3Income: dec('30000'),
  last3Expense: dec('15000'),
  budgets: [
    { amount: dec('5000'), used: dec('3000') },
    { amount: dec('2000'), used: dec('1999.99') },
  ],
  assetBalance: dec('60000'),
  recordDays: 30,
  outstandingBorrow: dec('0'),
});

const dimOf = (r: ReturnType<typeof scoreHealth>, key: string) =>
  r.dimensions.find((d) => d.key === key)!;

describe('权重与分档常量', () => {
  it('权重合计 100', () => {
    const sum = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
    expect(sum).toBe(100);
  });

  it('gradeOf 边界：90=S / 89=A / 80=A / 70=B / 60=C / 59=D / 0=D', () => {
    expect(gradeOf(100)).toBe('S');
    expect(gradeOf(90)).toBe('S');
    expect(gradeOf(89)).toBe('A');
    expect(gradeOf(80)).toBe('A');
    expect(gradeOf(70)).toBe('B');
    expect(gradeOf(60)).toBe('C');
    expect(gradeOf(59)).toBe('D');
    expect(gradeOf(0)).toBe('D');
    // 分档表本身按 min 降序
    for (let i = 1; i < GRADE_BANDS.length; i++) {
      expect(GRADE_BANDS[i].min).toBeLessThan(GRADE_BANDS[i - 1].min);
    }
  });
});

describe('满分档', () => {
  it('所有维度满分 → 总分 100 / S', () => {
    const r = scoreHealth(healthyInput());
    expect(r.dimensions.every((d) => d.score === 100)).toBe(true);
    expect(r.score).toBe(100);
    expect(r.grade).toBe('S');
  });

  it('储蓄率 ≥ 30% → 100；刚好 −30% → 0', () => {
    expect(savingRateDim(dec('10000'), dec('7000')).score).toBe(100); // +30%
    expect(savingRateDim(dec('10000'), dec('5000')).score).toBe(100); // +50% 封顶
    expect(savingRateDim(dec('10000'), dec('13000')).score).toBe(0); // −30%
    expect(savingRateDim(dec('10000'), dec('20000')).score).toBe(0); // −100% 封底
  });

  it('应急金 ≥ 6 个月 → 100；0 资产 → 0', () => {
    expect(emergencyFundDim(dec('30000'), dec('15000')).score).toBe(100); // 月均 5000，可撑 6 个月
    expect(emergencyFundDim(dec('99999'), dec('15000')).score).toBe(100); // 超 6 个月封顶
    expect(emergencyFundDim(dec('0'), dec('15000')).score).toBe(0);
  });

  it('无借贷 → 负债压力 100', () => {
    expect(debtPressureDim(dec('0'), dec('10000')).score).toBe(100);
  });
});

describe('零分档', () => {
  it('所有维度零分 → 总分 0 / D', () => {
    const r = scoreHealth({
      last3Income: dec('10000'),
      last3Expense: dec('14000'), // 储蓄率 −40% → 0
      budgets: [{ amount: dec('1000'), used: dec('1000.01') }], // 超支 → 0
      assetBalance: dec('0'), // 应急金 0 个月；负债压力分母为 0
      recordDays: 0,
      outstandingBorrow: dec('5000'),
    });
    expect(r.dimensions.every((d) => d.score === 0)).toBe(true);
    expect(r.score).toBe(0);
    expect(r.grade).toBe('D');
  });

  it('有借款但资产 ≤ 0 → 负债压力 0', () => {
    expect(debtPressureDim(dec('5000'), dec('0')).score).toBe(0);
    expect(debtPressureDim(dec('5000'), dec('-100')).score).toBe(0);
  });

  it('借款占资产 ≥ 50% → 0；占比 25% → 50', () => {
    expect(debtPressureDim(dec('5000'), dec('10000')).score).toBe(0); // 50%
    expect(debtPressureDim(dec('6000'), dec('10000')).score).toBe(0); // 60%
    expect(debtPressureDim(dec('2500'), dec('10000')).score).toBe(50); // 25%
  });
});

describe('数据不足中性分', () => {
  it('近 3 月收入为 0 → 储蓄率给中性分并注明数据不足', () => {
    const d = savingRateDim(dec('0'), dec('5000'));
    expect(d.score).toBe(NEUTRAL_SCORE);
    expect(d.headline).toContain('暂无收入');
    expect(d.advice).toContain('数据不足');
  });

  it('无预算 → 预算纪律给中性分并提示「先建预算」', () => {
    const d = budgetDisciplineDim([]);
    expect(d.score).toBe(NEUTRAL_SCORE);
    expect(d.headline).toContain('尚未设置预算');
    expect(d.advice).toContain('先建预算');
  });

  it('近 3 月支出为 0 → 应急金给中性分（估不出可撑月数）', () => {
    const d = emergencyFundDim(dec('60000'), dec('0'));
    expect(d.score).toBe(NEUTRAL_SCORE);
    expect(d.advice).toContain('数据不足');
  });

  it('中性分参与加权：只有一个维度有数据时总分被中性分拉住', () => {
    const r = scoreHealth({
      last3Income: dec('0'), // 60
      last3Expense: dec('0'), // 应急金 60
      budgets: [], // 60
      assetBalance: dec('10000'),
      recordDays: 30, // 100
      outstandingBorrow: dec('0'), // 100
    });
    expect(dimOf(r, 'savingRate').score).toBe(NEUTRAL_SCORE);
    expect(dimOf(r, 'budgetDiscipline').score).toBe(NEUTRAL_SCORE);
    expect(dimOf(r, 'emergencyFund').score).toBe(NEUTRAL_SCORE);
    // (60*25 + 60*20 + 60*25 + 100*15 + 100*15) / 100 = 72
    expect(r.score).toBe(72);
    expect(r.grade).toBe('B');
  });
});

describe('各维度中间档', () => {
  it('储蓄率 0% → 50；+15% → 75', () => {
    expect(savingRateDim(dec('10000'), dec('10000')).score).toBe(50);
    expect(savingRateDim(dec('10000'), dec('8500')).score).toBe(75);
  });

  it('预算纪律：2 项中 1 项超支 → 50；临界 used == amount 不算超支', () => {
    const d = budgetDisciplineDim([
      { amount: dec('1000'), used: dec('1000') }, // 恰好用满，未超支
      { amount: dec('1000'), used: dec('1000.01') }, // 超支
    ]);
    expect(d.score).toBe(50);
    expect(d.headline).toBe('1/2 项预算未超支');
  });

  it('应急金 3 个月 → 50', () => {
    expect(emergencyFundDim(dec('15000'), dec('15000')).score).toBe(50); // 月均 5000
  });

  it('记账 15/30 天 → 50；超界输入被夹紧', () => {
    expect(recordStreakDim(15).score).toBe(50);
    expect(recordStreakDim(0).score).toBe(0);
    expect(recordStreakDim(30).score).toBe(100);
    expect(recordStreakDim(45).score).toBe(100); // 异常输入夹到 30 天
  });
});

describe('加权总分', () => {
  it('按权重加权平均并四舍五入', () => {
    const r = scoreHealth({
      last3Income: dec('10000'),
      last3Expense: dec('7000'), // 储蓄率 30% → 100（权重 25）
      budgets: [
        { amount: dec('1000'), used: dec('500') },
        { amount: dec('1000'), used: dec('1200') },
      ], // 1/2 → 50（权重 20）
      assetBalance: dec('30000'), // 应急金：月均支出 (7000+... 见下)
      recordDays: 15, // 50（权重 15）
      outstandingBorrow: dec('7500'), // 占资产 25% → 50（权重 15）
    });
    // 应急金：近 3 月支出 7000 → 月均 ≈ 2333.33，30000/2333.33 ≈ 12.9 个月 → 100
    expect(dimOf(r, 'emergencyFund').score).toBe(100);
    // (100*25 + 50*20 + 100*25 + 50*15 + 50*15) / 100 = 75
    expect(r.score).toBe(75);
    expect(r.grade).toBe('B');
    // 维度顺序固定
    expect(r.dimensions.map((d) => d.key)).toEqual([
      'savingRate',
      'budgetDiscipline',
      'emergencyFund',
      'recordStreak',
      'debtPressure',
    ]);
  });
});
