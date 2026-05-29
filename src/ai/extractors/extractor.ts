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
