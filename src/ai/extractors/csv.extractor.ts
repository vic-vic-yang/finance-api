import { parse as csvParse } from 'csv-parse/sync';
import { Extractor, ExtractedInput, capText, decodeText } from './extractor';

/**
 * CSV → markdown 表格字符串（LLM 对 markdown 表格识别率最高）
 */
export class CsvExtractor implements Extractor {
  supports(fileType: string): boolean {
    return fileType === 'csv';
  }

  async extract(buf: Buffer): Promise<ExtractedInput> {
    // 自动识别编码：UTF-8 / GBK·GB18030（支付宝、银行导出几乎都是 GBK）
    const decoded = decodeText(buf);
    // 切掉支付宝/微信账单顶部的"汇总抬头块"（账号/统计/重要提示等十几行）。
    // 否则真正的列头被埋在中间、且前导块里的不配对引号会把 CSV 解析搞崩。
    const text = stripStatementPreamble(decoded);

    let rows: string[][];
    try {
      // relaxQuotes：账单里偶有不配对引号，放宽容错避免整段被吞
      rows = csvParse(text, {
        skipEmptyLines: true,
        relaxColumnCount: true,
        relaxQuotes: true,
      });
    } catch (e) {
      throw new Error(`CSV 解析失败: ${e}`);
    }
    if (rows.length === 0) {
      throw new Error('CSV 为空');
    }

    // 取前 1000 行避免文本太长 token 爆炸
    const head = rows[0];
    const body = rows.slice(1, 1001);
    const md = toMarkdownTable(head, body);
    return { kind: 'text', content: capText(md) };
  }
}

/**
 * 支付宝/微信导出的 CSV 顶部有一段汇总抬头（账号、统计、重要提示…），
 * 真正的列头在中间某行。找到列头行（含"交易时间"等 + "金额"）并从那里起截，
 * 把前面的抬头块丢掉。找不到则原样返回（普通银行 CSV 通常第一行就是列头）。
 */
function stripStatementPreamble(text: string): string {
  const lines = text.split(/\r?\n/);
  const headerKeys = ['交易时间', '交易创建时间', '交易日期', '记账日期', '交易时间点'];
  const idx = lines.findIndex(
    (l) => headerKeys.some((k) => l.includes(k)) && l.includes('金额'),
  );
  if (idx > 0) return lines.slice(idx).join('\n');
  return text;
}

function toMarkdownTable(header: string[], rows: string[][]): string {
  const headLine = `| ${header.map(esc).join(' | ')} |`;
  const sep = `| ${header.map(() => '---').join(' | ')} |`;
  const bodyLines = rows.map(
    (r) =>
      `| ${header
        .map((_, i) => esc(r[i] ?? ''))
        .join(' | ')} |`,
  );
  return [headLine, sep, ...bodyLines].join('\n');
}

function esc(s: string): string {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
