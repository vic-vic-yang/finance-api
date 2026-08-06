import { ChatMessage } from '../ai/llm/chat-model';
import { BriefingFacts } from './briefing.facts';

/**
 * 每周管家简报 · LLM prompt 构建（纯函数，可单测）
 *
 * 隐私不变式：送给 LLM 的只有聚合数字、分类名与日期——
 * 账单备注是端到端加密的，服务端本来也解不开；
 * facts 里即使混入多余字段，[sanitizeFactsForLlm] 的白名单序列化
 * 也保证只有显式允许的 key 会进入 prompt。
 */

/** LLM 输出正文的最大字数（超过视为坏格式，降级模板） */
export const NARRATIVE_MAX_LEN = 400;
/** LLM 输出正文的最小字数（低于视为空响应，降级模板） */
export const NARRATIVE_MIN_LEN = 10;

const SYSTEM_PROMPT = [
  '你是「司库」，一位克制的私人财务管家。根据用户上周的财务聚合数据写一份周报正文。',
  '要求：',
  '1. 总字数不超过 150 字；',
  '2. 结构：第一句总结上周收支（支出为主，有环比就带一句）；',
  '   然后最多 3 条「值得注意」，每条一行、以「· 」开头（没有值得说的就少写或不写）；',
  '   最后一行以「建议：」开头，给一条具体、可执行的建议；',
  '3. 语气：专业、站在用户一边、不说教；不用 emoji，不堆砌感叹号；',
  '4. 只使用给定数据，不得编造数字或事件；',
  '5. 直接输出正文，不要标题、不要任何前后缀。',
].join('\n');

/**
 * facts 的白名单序列化——只有这些 key 会被送给 LLM。
 * 显式排除 billId / recurringId 等内部标识与任何意外混入的字段。
 */
export function sanitizeFactsForLlm(f: BriefingFacts): Record<string, unknown> {
  return {
    weekStart: f.weekStart,
    weekEnd: f.weekEnd,
    expense: f.expense,
    income: f.income,
    prevExpense: f.prevExpense,
    prevIncome: f.prevIncome,
    expenseChangePct: f.expenseChangePct,
    incomeChangePct: f.incomeChangePct,
    topExpenseCategories: f.topExpenseCategories.map((c) => ({
      name: c.name,
      amount: c.amount,
    })),
    largeExpenses: f.largeExpenses.map((l) => ({
      categoryName: l.categoryName,
      amount: l.amount,
      date: l.date,
    })),
    budgetOverspend: f.budgetOverspend.map((o) => ({
      name: o.name,
      budget: o.budget,
      spent: o.spent,
      over: o.over,
    })),
    upcomingRecurring: f.upcomingRecurring.map((r) => ({
      categoryName: r.categoryName,
      amount: r.amount,
      type: r.type,
      nextDate: r.nextDate,
    })),
    healthScore: f.healthScore,
  };
}

export function buildBriefingMessages(f: BriefingFacts): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `上周财务聚合数据（JSON）：\n${JSON.stringify(sanitizeFactsForLlm(f), null, 2)}`,
    },
  ];
}

/**
 * 清洗 + 校验 LLM 输出；不合法返回 null（调用方降级模板）。
 *  - 去掉可能的 markdown 代码围栏 / 首尾空白
 *  - 长度在 [NARRATIVE_MIN_LEN, NARRATIVE_MAX_LEN] 之间
 *  - 不含模板事故残留（undefined / NaN / null 字样）
 */
export function cleanupLlmNarrative(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  // 剥掉 ``` 围栏
  const fence = s.match(/^```[a-zA-Z]*\s*([\s\S]*?)```$/);
  if (fence) s = fence[1].trim();
  if (s.length < NARRATIVE_MIN_LEN || s.length > NARRATIVE_MAX_LEN) return null;
  if (/undefined|NaN|\bnull\b/.test(s)) return null;
  return s;
}
