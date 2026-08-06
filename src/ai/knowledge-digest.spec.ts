import {
  AccountSlice,
  buildKnowledgeText,
  BudgetSliceItem,
  CategoryBucket,
  DIGEST_MAX_CHARS,
  DigestSlices,
  GoalSliceItem,
  LoanSlice,
  MonthSlice,
  routeSlices,
  sliceToText,
} from './knowledge-digest';

// ── 测试数据构造 ─────────────────────────────────────────────

const month = (
  income: number,
  expense: number,
  top: CategoryBucket[] = [],
  prev: { expense?: number; income?: number } = {},
): MonthSlice => ({
  income,
  expense,
  count: 10,
  topExpense: top,
  prevExpense: prev.expense ?? null,
  prevIncome: prev.income ?? null,
});

const bucket = (name: string, amount: number): CategoryBucket => ({
  name,
  amount,
  count: 3,
});

const budget = (name: string, spent: number, limit: number): BudgetSliceItem => ({
  categoryName: name,
  period: 'MONTHLY',
  spent,
  limit,
});

const goal = (label: string, saved: number, target: number): GoalSliceItem => ({
  label,
  saved,
  target,
  progress: target > 0 ? saved / target : 0,
  isCompleted: false,
});

const noLoans: LoanSlice = {
  borrowOutstanding: 0,
  borrowCount: 0,
  lendOutstanding: 0,
  lendCount: 0,
};

const accounts = (
  count: number,
  total: number,
  extra: Partial<AccountSlice> = {},
): AccountSlice => ({
  count,
  totalBalance: total,
  creditBalance: extra.creditBalance ?? 0,
  debtBalance: extra.debtBalance ?? 0,
});

const slices = (over: Partial<DigestSlices> = {}): DigestSlices => ({
  thisMonth: month(5000, 3200, [bucket('餐饮', 800), bucket('交通', 300)], {
    expense: 2800,
  }),
  lastMonth: month(4800, 2800, [bucket('餐饮', 700)], { expense: 2600 }),
  budgets: [budget('餐饮', 800, 1000)],
  goals: [goal('目标 1', 2000, 10000)],
  loans: {
    borrowOutstanding: 5000,
    borrowCount: 2,
    lendOutstanding: 3000,
    lendCount: 1,
  },
  accounts: accounts(5, 50000, { creditBalance: -1200 }),
  ...over,
});

// ── 关键词路由 ───────────────────────────────────────────────

describe('routeSlices', () => {
  it('「预算」→ 预算切片', () => {
    expect(routeSlices('预算执行情况怎么样？')).toEqual(['budgets']);
  });

  it('「目标/储蓄」→ 目标切片', () => {
    expect(routeSlices('储蓄目标进度如何')).toEqual(['goals']);
    expect(routeSlices('我攒钱攒到哪了')).toEqual(['goals']);
  });

  it('「欠/借/负债」→ 借贷切片', () => {
    expect(routeSlices('我欠别人多少钱')).toContain('loans');
    expect(routeSlices('我有多少负债')).toEqual(['loans']);
    expect(routeSlices('借出去的钱收回来没')).toEqual(['loans']);
  });

  it('「上月/环比/同比」→ 上月 + 本月分类切片', () => {
    expect(routeSlices('上个月哪类花最多')).toEqual(['thisMonth', 'lastMonth']);
    expect(routeSlices('比上月环比怎么样')).toEqual(['thisMonth', 'lastMonth']);
  });

  it('「分类/哪类/花最多」→ 月度分类切片', () => {
    expect(routeSlices('哪类花得最多？')).toEqual(['thisMonth', 'lastMonth']);
    expect(routeSlices('分类占比看看')).toEqual(['thisMonth', 'lastMonth']);
  });

  it('「余额/账户/资产」→ 账户切片', () => {
    expect(routeSlices('我账户余额一共多少')).toEqual(['accounts']);
    expect(routeSlices('总资产呢')).toEqual(['accounts']);
  });

  it('裸「还」不误中借贷（预算还剩多少 → 只中预算）', () => {
    expect(routeSlices('预算还剩多少')).toEqual(['budgets']);
  });

  it('多关键词命中 → 按固定顺序合并去重', () => {
    expect(routeSlices('本月预算和储蓄目标怎么样')).toEqual([
      'thisMonth',
      'budgets',
      'goals',
    ]);
  });

  it('无匹配 → 兜底全量切片', () => {
    expect(routeSlices('今天天气怎么样')).toEqual([
      'thisMonth',
      'lastMonth',
      'budgets',
      'goals',
      'loans',
      'accounts',
    ]);
  });
});

// ── 切片文本化 ───────────────────────────────────────────────

describe('sliceToText', () => {
  it('月度切片含收支、环比与 TOP 分类', () => {
    const t = sliceToText('thisMonth', slices(), 5);
    expect(t).toContain('【本月收支】');
    expect(t).toContain('收入 ¥5000.00');
    expect(t).toContain('支出 ¥3200.00');
    expect(t).toContain('支出环比 +14.3%'); // 3200/2800 - 1
    expect(t).toContain('餐饮 ¥800.00');
  });

  it('无上月数据时不出现环比', () => {
    const s = slices({ thisMonth: month(100, 50, [bucket('餐饮', 50)]) });
    expect(sliceToText('thisMonth', s, 5)).not.toContain('环比');
  });

  it('预算切片含已用/上限/剩余', () => {
    const t = sliceToText('budgets', slices(), 5);
    expect(t).toContain('【预算执行】');
    expect(t).toContain('餐饮');
    expect(t).toContain('已用 ¥800.00 / ¥1000.00（80%）');
    expect(t).toContain('剩 ¥200.00');
  });

  it('空预算 / 空目标 / 空借贷给兜底文案', () => {
    const s = slices({ budgets: [], goals: [], loans: noLoans });
    expect(sliceToText('budgets', s, 5)).toContain('未设任何预算');
    expect(sliceToText('goals', s, 5)).toContain('还没有创建储蓄目标');
    expect(sliceToText('loans', s, 5)).toContain('没有未结清的借贷');
  });

  it('借贷切片区分借入（我欠别人）与借出（别人欠我）', () => {
    const t = sliceToText('loans', slices(), 5);
    expect(t).toContain('我欠别人（借入）未还 ¥5000.00（2 笔）');
    expect(t).toContain('别人欠我（借出）未收 ¥3000.00（1 笔）');
  });

  it('账户切片含合计与信用卡合计', () => {
    const t = sliceToText('accounts', slices(), 5);
    expect(t).toContain('共 5 个账户');
    expect(t).toContain('合计余额 ¥50000.00');
    expect(t).toContain('信用卡账户合计 ¥-1200.00');
  });
});

// ── 注入文本组装与长度上限 ────────────────────────────────────

describe('buildKnowledgeText', () => {
  it('带「真实数据摘要」头部，且只含路由命中的切片', () => {
    const t = buildKnowledgeText('预算还剩多少', slices());
    expect(t).toContain('真实数据摘要');
    expect(t).toContain('【预算执行】');
    expect(t).not.toContain('【借贷往来】');
    expect(t).not.toContain('【储蓄目标】');
  });

  it('无匹配时注入紧凑全量摘要', () => {
    const t = buildKnowledgeText('随便聊聊', slices());
    for (const tag of [
      '【本月收支】',
      '【上月收支】',
      '【预算执行】',
      '【储蓄目标】',
      '【借贷往来】',
      '【账户总览】',
    ]) {
      expect(t).toContain(tag);
    }
  });

  it('全量摘要长度 ≤ 上限（正常数据量）', () => {
    const t = buildKnowledgeText('随便聊聊', slices());
    expect(t.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });

  it('超大数据量时先降 TOP5→TOP3，仍超限则硬截断，永不超过上限', () => {
    const big: CategoryBucket[] = Array.from({ length: 5 }, (_, i) =>
      bucket(`一个很长的分类名字编号${i}号`, 9999.99),
    );
    const s = slices({
      thisMonth: month(99999, 88888, big, { expense: 77777 }),
      lastMonth: month(99999, 77777, big, { expense: 66666 }),
      budgets: Array.from({ length: 12 }, (_, i) =>
        budget(`超长预算分类名称${i}号`, 888.88, 1000),
      ),
      goals: Array.from({ length: 8 }, (_, i) =>
        goal(`目标 ${i + 1}`, 1234.56, 9999.99),
      ),
    });
    const t = buildKnowledgeText('随便聊聊', s);
    expect(t.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    // 触发了降级/截断
    expect(t.endsWith('…') || !t.includes('TOP5')).toBe(true);
  });

  it('自定义上限同样生效', () => {
    const t = buildKnowledgeText('随便聊聊', slices(), 200);
    expect(t.length).toBeLessThanOrEqual(200);
  });
});
