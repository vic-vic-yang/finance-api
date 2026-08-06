/**
 * AI 分类纠正（few-shot 自进化）的纯函数匹配器。
 *
 * 用户复核导入草稿时改过的「商户 → 分类」存为 AiCorrection（merchantKey 明文）。
 * 下次解析时把与待解析内容相似的纠正作为 few-shot 样例注入 prompt。
 * 抽成纯函数便于单测（correction-matcher.spec.ts）。
 */

export interface CorrectionEntry {
  merchantKey: string;
  categoryId: string;
}

/** few-shot 样例注入条数上限 */
export const MAX_FEWSHOT_CORRECTIONS = 8;

/** merchantKey 最大长度（与 schema 的 VarChar(100) 对齐） */
export const MERCHANT_KEY_MAX = 100;

/**
 * 规范化商户名：trim + 去全部空白 + 小写，截断到 100 字符。
 * 入库与匹配都走这里，保证「瑞幸 咖啡」「瑞幸咖啡」「Luckin Coffee」形态归一。
 */
export function normalizeMerchantKey(raw?: string | null): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .slice(0, MERCHANT_KEY_MAX);
}

/**
 * 单个商户名 → 命中的纠正列表（先精确匹配，再双向 contains 匹配）。
 *
 * - 精确：规范化后完全相等，优先级最高；
 * - 双向 contains：「瑞幸」命中「瑞幸咖啡」，「瑞幸咖啡（北京）」也命中「瑞幸咖啡」；
 * - 结果按 corrections 传入顺序（调用方按 updatedAt desc 传）去重，封顶 limit 条。
 */
export function findCorrectionMatches(
  corrections: CorrectionEntry[],
  merchant: string,
  limit = MAX_FEWSHOT_CORRECTIONS,
): CorrectionEntry[] {
  const key = normalizeMerchantKey(merchant);
  if (!key) return [];

  const exact: CorrectionEntry[] = [];
  const similar: CorrectionEntry[] = [];
  const seen = new Set<string>();

  for (const c of corrections) {
    const ck = normalizeMerchantKey(c.merchantKey);
    if (!ck || seen.has(ck)) continue;
    if (ck === key) {
      seen.add(ck);
      exact.push(c);
    } else if (ck.includes(key) || key.includes(ck)) {
      seen.add(ck);
      similar.push(c);
    }
  }
  return [...exact, ...similar].slice(0, limit);
}

/**
 * 从原始待解析文本（银行/支付流水全文）里挑出相关纠正。
 * 解析前还没有逐条商户名，用「规范化后的纠正 key 出现在规范化文本中」做相关性筛选；
 * 结果保持传入顺序（最近纠正优先），封顶 limit 条。
 */
export function matchCorrectionsInText(
  corrections: CorrectionEntry[],
  text: string,
  limit = MAX_FEWSHOT_CORRECTIONS,
): CorrectionEntry[] {
  const normText = normalizeMerchantKey(text);
  if (!normText) return [];

  const out: CorrectionEntry[] = [];
  const seen = new Set<string>();
  for (const c of corrections) {
    const ck = normalizeMerchantKey(c.merchantKey);
    if (!ck || seen.has(ck)) continue;
    if (normText.includes(ck)) {
      seen.add(ck);
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * 把命中的纠正格式化成 prompt 行：
 *   - 瑞幸咖啡 → 餐饮>咖啡（用户历史纠正）
 * categoryNameOf 把 categoryId 转成「一级>二级」展示名；拿不到就用原始 id。
 */
export function buildFewShotLines(
  matched: CorrectionEntry[],
  categoryNameOf: (categoryId: string) => string,
): string[] {
  return matched.map(
    (c) => `- ${c.merchantKey} → ${categoryNameOf(c.categoryId)}（用户历史纠正）`,
  );
}
