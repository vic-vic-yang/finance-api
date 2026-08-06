import { BriefingFacts, fmtMoney } from './briefing.facts';

/**
 * 每周管家简报 · 模板兜底正文（纯函数，可单测）
 *
 * LLM 不可用 / 超时 / 返回坏格式时的确定性降级：
 * 没有配置任何 AI 模型的用户也必须收到像样的简报——这是「实用最重要」的底线。
 *
 * 结构（与 LLM 输出约定一致）：
 *   第 1 行：一句总结（支出 + 环比，有收入时带上）
 *   随后：值得注意（最多 3 条，「· 」开头；没有则整段省略）
 *   最后：建议：…（确定性建议，与 facts.advice 同一句）
 */

/** 环比一句话；基期为 0（null）时不提环比 */
export function changePhrase(pct: number | null): string {
  if (pct == null) return '';
  if (Math.abs(pct) < 0.05) return '，与上上周持平';
  return pct > 0
    ? `，比上上周多 ${Math.abs(pct)}%`
    : `，比上上周少 ${Math.abs(pct)}%`;
}

/** 「值得注意」条目（最多 3 条，按重要性排序） */
export function notablePoints(f: BriefingFacts): string[] {
  const points: string[] = [];
  for (const o of f.budgetOverspend.slice(0, 2)) {
    points.push(`「${o.name}」预算已超支 ${fmtMoney(o.over)}`);
  }
  for (const l of f.largeExpenses.slice(0, 2)) {
    points.push(`一笔大额支出 ${fmtMoney(l.amount)}（${l.categoryName}）`);
  }
  if (f.topExpenseCategories.length > 0) {
    const top = f.topExpenseCategories[0];
    points.push(`「${top.name}」花费最多，共 ${fmtMoney(top.amount)}`);
  }
  if (f.upcomingRecurring.length > 0) {
    const total = f.upcomingRecurring.reduce((s, r) => s + r.amount, 0);
    points.push(
      `本周有 ${f.upcomingRecurring.length} 笔周期扣款待扣（约 ${fmtMoney(total)}）`,
    );
  }
  return points.slice(0, 3);
}

export function renderTemplateBriefing(f: BriefingFacts): string {
  const lines: string[] = [];

  // 1) 总结
  let summary = `上周支出 ${fmtMoney(f.expense)}${changePhrase(f.expenseChangePct)}`;
  if (f.income > 0) {
    summary += `；收入 ${fmtMoney(f.income)}`;
  }
  summary += '。';
  lines.push(summary);

  // 2) 值得注意
  const points = notablePoints(f);
  for (const p of points) {
    lines.push(`· ${p}`);
  }

  // 3) 建议
  lines.push(`建议：${f.advice}`);

  return lines.join('\n');
}
