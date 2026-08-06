import { BriefingFacts } from './briefing.facts';
import {
  buildBriefingMessages,
  cleanupLlmNarrative,
  sanitizeFactsForLlm,
} from './briefing.prompt';

function facts(over: Record<string, unknown> = {}): BriefingFacts {
  return {
    weekStart: '2026-07-20',
    weekEnd: '2026-07-26',
    prevWeekStart: '2026-07-13',
    prevWeekEnd: '2026-07-19',
    billCount: 8,
    expense: 800,
    income: 3000,
    prevExpense: 1000,
    prevIncome: 3000,
    expenseChangePct: -20,
    incomeChangePct: 0,
    topExpenseCategories: [{ categoryId: 'c1', name: '餐饮', amount: 300 }],
    largeExpenses: [],
    budgetOverspend: [],
    upcomingRecurring: [],
    healthScore: 75,
    advice: '继续保持记账节奏。',
    ...over,
  } as BriefingFacts;
}

describe('buildBriefingMessages', () => {
  it('system 约束结构 / 字数 / 语气；user 携带聚合 JSON', () => {
    const msgs = buildBriefingMessages(facts());
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('150');
    expect(msgs[0].content).toContain('建议');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('餐饮');
    expect(msgs[1].content).toContain('800');
  });

  it('隐私断言：混入备注原文 / 内部 id 的 facts 不会泄露进 prompt', () => {
    const poisoned = facts({
      note: '给女朋友买的生日礼物', // 假设混入的备注原文
      merchantName: '海底捞火锅(望京店)',
      billId: 'bill-secret-001',
    });
    (poisoned.topExpenseCategories[0] as any).note = '部门聚餐 AA';
    const msgs = buildBriefingMessages(poisoned);
    const payload = msgs.map((m) => m.content).join('\n');
    expect(payload).not.toContain('给女朋友买的生日礼物');
    expect(payload).not.toContain('海底捞');
    expect(payload).not.toContain('bill-secret-001');
    expect(payload).not.toContain('部门聚餐');
    expect(payload).not.toMatch(/note|merchant/i);
  });

  it('白名单序列化：只保留显式允许的 key', () => {
    const s = sanitizeFactsForLlm(facts());
    const keys = Object.keys(s).sort();
    expect(keys).toEqual(
      [
        'budgetOverspend',
        'expense',
        'expenseChangePct',
        'healthScore',
        'income',
        'incomeChangePct',
        'largeExpenses',
        'prevExpense',
        'prevIncome',
        'topExpenseCategories',
        'upcomingRecurring',
        'weekEnd',
        'weekStart',
      ].sort(),
    );
  });
});

describe('cleanupLlmNarrative', () => {
  it('正常文本通过', () => {
    expect(cleanupLlmNarrative('  上周支出 ¥800，比上上周少 20%。\n建议：继续保持。 ')).toBe(
      '上周支出 ¥800，比上上周少 20%。\n建议：继续保持。',
    );
  });

  it('剥掉 markdown 围栏', () => {
    expect(cleanupLlmNarrative('```\n上周支出 ¥800。\n```')).toBe('上周支出 ¥800。');
  });

  it('空 / 过短 / 过长 → null（降级模板）', () => {
    expect(cleanupLlmNarrative('')).toBeNull();
    expect(cleanupLlmNarrative(null)).toBeNull();
    expect(cleanupLlmNarrative('太短')).toBeNull();
    expect(cleanupLlmNarrative('长'.repeat(500))).toBeNull();
  });

  it('含 undefined / NaN / null 字样 → null', () => {
    expect(cleanupLlmNarrative('上周支出 undefined 元，请检查。')).toBeNull();
    expect(cleanupLlmNarrative('环比上涨 NaN%，数据异常请注意。')).toBeNull();
  });
});
