/** 复杂问题 Plan 模式：规则识别 + 工具编排提示（不额外调 LLM） */

export interface ChatPlan {
  steps: string[];
  hint: string;
}

const PLAN_RULES: Array<{ test: RegExp; tools: string[] }> = [
  {
    test: /全面|整体|综合|财务情况|财务状况|总览/,
    tools: ['getHealthScore', 'getForecast', 'listInsights', 'manageBudget'],
  },
  {
    test: /风险|预警|异常|有没有问题|要注意/,
    tools: ['listInsights', 'getHealthScore', 'getReconcileSummary'],
  },
  {
    test: /固定支出|订阅|周期|扣款|房租|房贷/,
    tools: ['listRecurring', 'getForecast'],
  },
  {
    test: /负债|欠款|借贷|借出|借入/,
    tools: ['listLoans', 'getHealthScore'],
  },
  {
    test: /比.*(上月|去年|同期)|涨|跌|环比|同比|变化/,
    tools: ['comparePeriods'],
  },
  {
    test: /转账|划转/,
    tools: ['queryTransfers'],
  },
  {
    test: /股票|持仓|盈亏/,
    tools: ['listStockHoldings'],
  },
];

/** 是否启用 Plan 模式（综合性 / 多意图问题） */
export function shouldPlan(message: string): boolean {
  const t = message.trim();
  if (t.length < 8) return false;

  const matched = PLAN_RULES.filter((r) => r.test.test(t));
  if (matched.length >= 2) return true;
  if (matched.length === 1 && /全面|整体|综合|分析|诊断|怎么样|如何/.test(t)) {
    return true;
  }
  if ((t.match(/[？?]/g)?.length ?? 0) >= 2) return true;
  if (/[，,、；;].+[，,、；;]/.test(t) && t.length >= 18) return true;
  return false;
}

/** 生成工具调用顺序提示，注入 system prompt */
export function buildPlan(message: string): ChatPlan | null {
  if (!shouldPlan(message)) return null;

  const tools = new Set<string>();
  for (const rule of PLAN_RULES) {
    if (rule.test.test(message)) {
      for (const tool of rule.tools) tools.add(tool);
    }
  }
  const steps = [...tools].slice(0, 5);
  if (steps.length < 2) return null;

  return {
    steps,
    hint:
      `【分析计划】用户问题是综合性的。请按顺序调用工具：${steps.join(' → ')}。` +
      '全部取数完成后再用 2-4 句中文汇总，不要中途只答一半；数字以工具结果为准。',
  };
}
