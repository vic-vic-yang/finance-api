/** Yahoo 代码 → 东方财富 secid；美股等无对应市场时返回 null。 */
export function toEastmoneySecid(symbol: string): string | null {
  const up = symbol.trim().toUpperCase();
  const code = up.replace(/\.(SS|SZ|HK)$/, '');
  if (up.endsWith('.SS')) return `1.${code}`;
  if (up.endsWith('.SZ')) return `0.${code}`;
  if (up.endsWith('.HK')) return `116.${code.padStart(5, '0')}`;
  return null;
}

export function hasChineseText(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

/** 解析东方财富 `stock/get?fields=f58` 的中文证券简称。 */
export function parseEastmoneyChineseName(payload: any): string | null {
  const name = String(payload?.data?.f58 ?? '').trim();
  if (!name || name === '-' || !hasChineseText(name)) return null;
  return name.slice(0, 40);
}
