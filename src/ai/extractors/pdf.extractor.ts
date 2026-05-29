import { Logger } from '@nestjs/common';
import { Extractor, ExtractedInput, capText } from './extractor';

/**
 * PDF 文本提取器。
 *
 * 使用 pdfjs-dist（现代 pdf.js）逐页提取文本，比老的 pdf-parse
 * （内嵌 2017 年 pdf.js v1.10.100）更可靠，避免多页 PDF 后面页面
 * 因旧引擎解析失败而静默丢页。
 */

export class PdfExtractor implements Extractor {
  private readonly logger = new Logger(PdfExtractor.name);
  private _pdfjs: typeof import('pdfjs-dist') | null = null;

  supports(fileType: string): boolean {
    return fileType === 'pdf';
  }

  async extract(buf: Buffer): Promise<ExtractedInput> {
    if (!this._pdfjs) {
      // Node.js 环境必须用 legacy build（标准 build 是给浏览器用的）
      this._pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
      const { pathToFileURL } = require('node:url');
      this._pdfjs!.GlobalWorkerOptions.workerSrc = pathToFileURL(
        require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
      ).toString();
    }
    const pdfjs = this._pdfjs;

    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;

    const total = doc.numPages;
    const pageTexts: string[] = [];
    let totalChars = 0;

    for (let i = 1; i <= total; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();

      // 同一 y 坐标拼成一行（银行流水常用版式）
      const lines: string[] = [];
      let lastY: number | null = null;
      let currentLine = '';
      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        const y = (item as any).transform?.[5] as number | undefined;
        if (lastY != null && y !== lastY) {
          lines.push(currentLine.trim());
          currentLine = '';
        }
        currentLine += (item as any).str as string;
        lastY = y ?? lastY;
      }
      if (currentLine.trim()) lines.push(currentLine.trim());

      const pageText = lines.join('\n').trim();
      totalChars += pageText.length;
      pageTexts.push(pageText);

      if (pageText.length === 0) {
        this.logger.warn(
          `PDF 第 ${i}/${total} 页 文本为空（可能是扫描件/图片页），建议拆成图片用视觉模型导入`,
        );
      }
    }

    doc.destroy();

    // 每页用 `--- 第 X/Y 页 ---` 标记，方便 LLM 感知页面边界
    const fullText = pageTexts
      .map((t, idx) => {
        if (t.length === 0) return `--- 第 ${idx + 1}/${total} 页（无文本）---`;
        return `--- 第 ${idx + 1}/${total} 页 ---\n${t}`;
      })
      .join('\n\n');

    const emptyCount = pageTexts.filter((t) => t.length === 0).length;
    this.logger.log(
      `PDF ${total} 页，提取 ${totalChars} 字符，${emptyCount} 页无文本`,
    );

    if (fullText.trim().length === 0) {
      throw new Error(
        'PDF 内所有页面均无文本（可能是扫描件），请拆成图片上传走视觉模型',
      );
    }

    return { kind: 'text', content: capText(fullText) };
  }
}
