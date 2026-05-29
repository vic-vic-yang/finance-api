import { parse as csvParse } from 'csv-parse/sync';
import { Extractor, ExtractedInput, capText } from './extractor';

/**
 * CSV → markdown 表格字符串（LLM 对 markdown 表格识别率最高）
 */
export class CsvExtractor implements Extractor {
  supports(fileType: string): boolean {
    return fileType === 'csv';
  }

  async extract(buf: Buffer): Promise<ExtractedInput> {
    // 尝试 utf8，失败回退 gbk（国内导出的 csv 多为 gbk）
    let text: string;
    try {
      text = buf.toString('utf8');
      // 简单 UTF-8 完整性校验：含 BOM 或不含问号方块即认为 OK
      if (text.includes('�')) throw new Error('not utf8');
    } catch {
      // 回退到 latin1（不丢字节，让 LLM 自己判断）
      text = buf.toString('latin1');
    }

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
