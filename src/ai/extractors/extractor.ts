import * as iconv from 'iconv-lite';
import { MessagePart } from '../llm/chat-model';

/**
 * Extractor 的统一输出。
 *
 * - 文本文件（pdf/csv/xlsx/text）→ kind='text'，content 是字符串
 * - 图片 → kind='image'，parts 是 multimodal 消息数组（user 提示 + 图片 base64）
 */
export type ExtractedInput =
  | { kind: 'text'; content: string }
  | { kind: 'image'; parts: MessagePart[] };

export interface Extractor {
  /** 该 extractor 是否能处理这个 mime/fileType */
  supports(fileType: string): boolean;
  /** 实际提取 */
  extract(buf: Buffer, filename: string): Promise<ExtractedInput>;
}

/** 单次 LLM 调用的最大输入字符数（避免 token 爆炸 → 钱包爆炸）
 *  一年完整流水（pdf/csv）一般 80–120k 字符，留 150k 上限既能覆盖
 *  绝大多数真实账单，又不至于一发把 64k 上下文撑爆。 */
export const MAX_LLM_INPUT_CHARS = 150000;

/** 把长文本截断 + 末尾加个明显标记，免得 LLM 以为整个文件就这么长 */
export function capText(s: string): string {
  if (s.length <= MAX_LLM_INPUT_CHARS) return s;
  return (
    s.slice(0, MAX_LLM_INPUT_CHARS) +
    `\n\n[…内容过长已截断，共 ${s.length} 字符，仅前 ${MAX_LLM_INPUT_CHARS} 字符送给 AI…]`
  );
}

/** 给 message 字段一个"是否被截断"的标记，方便前端排查丢条问题 */
export function capInfo(s: string): { capped: boolean; original: number; sent: number } {
  return {
    capped: s.length > MAX_LLM_INPUT_CHARS,
    original: s.length,
    sent: Math.min(s.length, MAX_LLM_INPUT_CHARS),
  };
}

/**
 * 把文件字节解码成字符串，自动识别编码。
 *
 * 国内银行 / 支付宝导出的 csv/txt 几乎都是 **GBK/GB18030**，
 * 而微信、海外导出多为 UTF-8。Node 的 Buffer.toString 不支持 GBK，
 * 之前误回退到 latin1 → 中文全乱码 → LLM 解析不出任何账单。
 *
 * 策略：
 *   1. 有 UTF-8 BOM → 直接按 UTF-8
 *   2. 按 UTF-8 解码后若没有替换字符(U+FFFD) → 认为就是 UTF-8
 *   3. 否则按 GB18030（GBK/GB2312 的超集）解码
 */
export function decodeText(buf: Buffer): string {
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8').slice(1); // 去掉 BOM 字符
  }
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8; // 干净的 UTF-8
  // UTF-8 解不动 → 大概率是 GBK/GB18030（国内导出）
  try {
    const gbk = iconv.decode(buf, 'gb18030');
    // GB18030 解出来若仍满是替换字符，说明也不是它，退回 UTF-8 结果
    if (gbk.includes('�') && !utf8.includes('�')) return utf8;
    return gbk;
  } catch {
    return utf8;
  }
}

/** 简单的 MIME / 扩展名 → 内部 fileType 归一化 */
export function detectFileType(filename: string, mime?: string): string {
  const lower = filename.toLowerCase();
  if (mime?.startsWith('image/')) return 'image';
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') ||
      lower.endsWith('.webp') || lower.endsWith('.heic')) return 'image';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.json')) return 'text';
  return 'text'; // 兜底
}
