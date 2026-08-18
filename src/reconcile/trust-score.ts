/**
 * 数据可信度评分 · 纯函数
 *
 * 把「对账中心」四项一致性检查的结果 + 账户覆盖率，合成 0-100 的可信度分，
 * 用来给 AI 结论（CFO 建议 / 周报 / 预测）标注「结果有多可靠」。
 *
 * 隐私不变式：只消费明文的计数/占比，绝不触碰 noteCipher / nameCipher。
 * 金额、日期由调用方（ReconcileService）聚合好后再传入。
 */

export type TrustDimensionKey =
  | 'accountCoverage'
  | 'balanceConsistency'
  | 'dedupCleanliness'
  | 'recurringCompleteness';

export interface DataTrustInput {
  /** 当前用户可见账户总数 */
  totalAccounts: number;
  /** 其中近 90 天有流水的账户数 */
  coveredAccounts: number;
  /** 余额漂移账户数 */
  balanceDriftCount: number;
  /** 疑似重复账单条数 */
  duplicateCount: number;
  /** 周期账单缺记条数 */
  missingRecurringCount: number;
  /** 转账缺腿条数 */
  orphanTransferCount: number;
}

export interface TrustDimension {
  key: TrustDimensionKey;
  label: string;
  /** 0-100 */
  score: number;
  weight: number;
  headline: string;
  advice: string;
}

export interface DataTrustResult {
  /** 0-100 加权总分 */
  score: number;
  /** S / A / B / C / D */
  grade: string;
  dimensions: TrustDimension[];
}

/** 各维度权重（合计 100） */
export const TRUST_WEIGHTS: Record<TrustDimensionKey, number> = {
  accountCoverage: 30,
  balanceConsistency: 30,
  dedupCleanliness: 20,
  recurringCompleteness: 20,
};

/** 数据不足时的中性分 */
export const TRUST_NEUTRAL = 60;

const GRADE_BANDS: ReadonlyArray<{ grade: string; min: number }> = [
  { grade: 'S', min: 90 },
  { grade: 'A', min: 80 },
  { grade: 'B', min: 70 },
  { grade: 'C', min: 60 },
  { grade: 'D', min: 0 },
];

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function trustGrade(score: number): string {
  for (const b of GRADE_BANDS) if (score >= b.min) return b.grade;
  return 'D';
}

function dim(
  key: TrustDimensionKey,
  label: string,
  score: number,
  headline: string,
  advice: string,
): TrustDimension {
  return { key, label, score: clamp(score), weight: TRUST_WEIGHTS[key], headline, advice };
}

export function scoreDataTrust(input: DataTrustInput): DataTrustResult {
  const dims: TrustDimension[] = [];

  // 1. 账户覆盖率：近 90 天有流水的账户占比
  if (input.totalAccounts <= 0) {
    dims.push(dim('accountCoverage', '账户覆盖率', TRUST_NEUTRAL, '暂无账户', '先建账户并开始记账'));
  } else {
    const ratio = input.coveredAccounts / input.totalAccounts;
    const all = input.coveredAccounts >= input.totalAccounts;
    dims.push(dim(
      'accountCoverage',
      '账户覆盖率',
      ratio * 100,
      input.coveredAccounts + '/' + input.totalAccounts + ' 个账户近 90 天有流水',
      all ? '全部账户都在活跃记录' : '有账户久未同步，补录/导入能提升可信度',
    ));
  }

  // 2. 余额一致性：漂移账户（权重更高）+ 转账缺腿
  {
    const issues = input.balanceDriftCount * 2 + input.orphanTransferCount;
    const clean = input.balanceDriftCount === 0 && input.orphanTransferCount === 0;
    dims.push(dim(
      'balanceConsistency',
      '余额一致性',
      100 - issues * 15,
      clean
        ? '余额账实一致'
        : input.balanceDriftCount + ' 个账户余额漂移、' + input.orphanTransferCount + ' 笔转账缺腿',
      clean ? '账本内部自洽' : '到对账中心校准余额 / 补齐转账腿',
    ));
  }

  // 3. 去重洁净度
  {
    const clean = input.duplicateCount === 0;
    dims.push(dim(
      'dedupCleanliness',
      '去重洁净度',
      100 - input.duplicateCount * 10,
      clean ? '未发现疑似重复账单' : input.duplicateCount + ' 条疑似重复账单',
      clean ? '流水干净' : '到对账中心清理重复，避免金额虚高',
    ));
  }

  // 4. 周期完整性
  {
    const clean = input.missingRecurringCount === 0;
    dims.push(dim(
      'recurringCompleteness',
      '周期完整性',
      100 - input.missingRecurringCount * 15,
      clean ? '周期账单无缺记' : input.missingRecurringCount + ' 条周期账单缺记',
      clean ? '订阅/固定支出记录完整' : '补记缺的周期账单，预测会更准',
    ));
  }

  const totalWeight = dims.reduce((s, d) => s + d.weight, 0);
  const score = totalWeight > 0
    ? clamp(dims.reduce((s, d) => s + d.score * d.weight, 0) / totalWeight)
    : 0;
  return { score, grade: trustGrade(score), dimensions: dims };
}
