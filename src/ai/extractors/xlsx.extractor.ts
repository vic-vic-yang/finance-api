import * as XLSX from 'xlsx';
import { Extractor, ExtractedInput, capText } from './extractor';

/**
 * Excel → 每个 sheet 转 markdown 表格，拼接送 LLM
 */
export class XlsxExtractor implements Extractor {
  supports(fileType: string): boolean {
    return fileType === 'xlsx';
  }

  async extract(buf: Buffer): Promise<ExtractedInput> {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const parts: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: false,
        defval: '',
      }) as string[][];
      if (rows.length === 0) continue;
      const header = rows[0].map((c) => String(c ?? ''));
      const body = rows.slice(1, 1001).map((r) => r.map((c) => String(c ?? '')));
      parts.push(`### sheet: ${sheetName}`);
      parts.push(toMarkdownTable(header, body));
    }
    if (parts.length === 0) throw new Error('Excel 内容为空');
    return { kind: 'text', content: capText(parts.join('\n\n')) };
  }
}

function toMarkdownTable(header: string[], rows: string[][]): string {
  const headLine = `| ${header.map(esc).join(' | ')} |`;
  const sep = `| ${header.map(() => '---').join(' | ')} |`;
  const bodyLines = rows.map(
    (r) =>
      `| ${header.map((_, i) => esc(r[i] ?? '')).join(' | ')} |`,
  );
  return [headLine, sep, ...bodyLines].join('\n');
}

function esc(s: string): string {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
