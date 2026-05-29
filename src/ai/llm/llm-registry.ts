import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatModel } from './chat-model';
import { OpenAiCompatibleClient } from './openai-compatible';

/**
 * 配置驱动的 LLM 注册中心。
 *
 * 每个槽位 = 一个模型，只要 3 个字段：
 *
 *   LLM_1_URL    = "https://api.deepseek.com"
 *   LLM_1_KEY    = "sk-xxx"
 *   LLM_1_MODEL  = "deepseek-chat"
 *
 * 是否支持视觉：按 model 名自动识别（含 vl / vision / multimodal / mm / image 字样的判为视觉）。
 * 想覆盖自动判断，可选填 LLM_1_VISION = "true" / "false"。
 *
 * 加新模型：复制 3 行改编号即可，无需动代码。同一个厂家的多个模型就开多个槽位。
 */
@Injectable()
export class LlmRegistry implements OnModuleInit {
  private readonly logger = new Logger(LlmRegistry.name);
  private readonly models = new Map<string, ChatModel>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    // 最多扫 20 个槽位
    for (let i = 1; i <= 20; i++) {
      const url = this.config.get<string>(`LLM_${i}_URL`)?.trim();
      const key = this.config.get<string>(`LLM_${i}_KEY`)?.trim();
      const model = this.config.get<string>(`LLM_${i}_MODEL`)?.trim();
      if (!url || !key || !model) continue;

      // 视觉能力：可选环境变量显式覆盖；否则按 model 名启发式判断
      const visionOverride = (
        this.config.get<string>(`LLM_${i}_VISION`) || ''
      )
        .trim()
        .toLowerCase();
      const supportsVision = ['true', '1', 'yes', 'y'].includes(visionOverride)
        ? true
        : ['false', '0', 'no', 'n'].includes(visionOverride)
          ? false
          : isVisionByName(model);

      if (this.models.has(model)) {
        this.logger.warn(`模型 ${model} 已注册，跳过槽位 LLM_${i}_*`);
        continue;
      }
      this.models.set(
        model,
        new OpenAiCompatibleClient(model, supportsVision, url, key, model),
      );
    }

    if (this.models.size === 0) {
      this.logger.warn(
        '⚠️ 没有注册任何 AI 模型 —— 在 .env 配 LLM_1_URL / LLM_1_KEY / LLM_1_MODEL',
      );
    } else {
      const list = [...this.models.values()]
        .map((m) => `${m.name}${m.supportsVision ? '(VL)' : ''}`)
        .join(', ');
      this.logger.log(`✅ 已注册 ${this.models.size} 个 AI 模型: ${list}`);
    }
  }

  list(): { name: string; supportsVision: boolean }[] {
    return [...this.models.values()].map((m) => ({
      name: m.name,
      supportsVision: m.supportsVision,
    }));
  }

  get(name: string): ChatModel {
    const m = this.models.get(name);
    if (!m) {
      throw new BadRequestException(
        `模型 ${name} 未注册。可用：${[...this.models.keys()].join(', ') || '（无）'}`,
      );
    }
    return m;
  }

  defaultTextModelName(): string | null {
    const want = this.config.get<string>('AI_DEFAULT_TEXT_MODEL');
    if (want && this.models.has(want)) return want;
    const textFirst = [...this.models.entries()].find(
      ([, v]) => !v.supportsVision,
    );
    if (textFirst) return textFirst[0];
    return [...this.models.keys()][0] ?? null;
  }

  defaultVisionModelName(): string | null {
    const want = this.config.get<string>('AI_DEFAULT_VISION_MODEL');
    if (want && this.models.has(want) && this.models.get(want)!.supportsVision) {
      return want;
    }
    const vl = [...this.models.entries()].find(([, v]) => v.supportsVision);
    return vl ? vl[0] : null;
  }
}

/**
 * 按 model id 启发式判断是否视觉模型。
 *
 * 业界惯例：模型名里含这些 token 的基本都是视觉 / 多模态。
 * 不准的话可在 .env 用 LLM_n_VISION="true|false" 强制覆盖。
 */
function isVisionByName(model: string): boolean {
  const m = model.toLowerCase();
  return (
    /(^|[-_])vl([-_]|$)/.test(m) ||
    m.includes('vision') ||
    m.includes('multimodal') ||
    /(^|[-_])mm([-_]|$)/.test(m) ||
    m.includes('image') ||
    m.includes('gpt-4o') ||
    m.includes('gpt-4-turbo')
  );
}
