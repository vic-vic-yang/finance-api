import { Extractor, ExtractedInput, capText } from './extractor';

export class TextExtractor implements Extractor {
  supports(fileType: string): boolean {
    return fileType === 'text';
  }

  async extract(buf: Buffer): Promise<ExtractedInput> {
    const text = buf.toString('utf8').trim();
    if (text.length === 0) throw new Error('文本内容为空');
    return { kind: 'text', content: capText(text) };
  }
}
