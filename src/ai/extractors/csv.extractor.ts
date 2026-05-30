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
    const text = decodeText(buf);

    let rows: string[][];
    try {
      rows = csvParse(text, { skipEmptyLines: true, relaxColumnCount: true });
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
