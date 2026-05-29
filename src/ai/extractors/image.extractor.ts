import { Extractor, ExtractedInput } from './extractor';

/**
 * 图片 → multimodal 消息（直接交给视觉模型）。
 *
 * 不走 OCR：现代 VL 模型（MiMo-VL / Qwen-VL）直接读图比 OCR + LLM 准。
 */
export class ImageExtractor implements Extractor {
  supports(fileType: string): boolean {
    return fileType === 'image';
  }

  async extract(buf: Buffer, filename: string): Promise<ExtractedInput> {
    const mime = guessMime(filename);
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    return {
      kind: 'image',
      parts: [
        {
          type: 'text',
          text:
            '请识别这张图里的所有账单 / 交易 / 收支信息（小票、转账截图、银行流水截图、对账单等都可能），后续指令会指定输出格式。',
        },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    };
  }
}

function guessMime(filename: string): string {
  const f = filename.toLowerCase();
  if (f.endsWith('.png')) return 'image/png';
  if (f.endsWith('.webp')) return 'image/webp';
  if (f.endsWith('.heic') || f.endsWith('.heif')) return 'image/heic';
  return 'image/jpeg';
}
