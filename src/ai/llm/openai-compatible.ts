import { Logger } from '@nestjs/common';
import {
  ChatMessage,
  ChatModel,
  ChatOptions,
  ChatResponse,
} from './chat-model';

/**
 * OpenAI 兼容协议的通用客户端。
 *
 * DeepSeek / 小米 MiMo / 通义千问 / Moonshot Kimi / 智谱 GLM
 * 这些国内大厂的 API 大都遵循 OpenAI Chat Completions 协议，
 * 只是 baseUrl + apiKey + 模型 id 不同。所以一个客户端搞定所有。
 */
export class OpenAiCompatibleClient implements ChatModel {
  private readonly logger = new Logger(OpenAiCompatibleClient.name);

  constructor(
    public readonly name: string,
    public readonly supportsVision: boolean,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly modelId: string,
  ) {}

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages,
      temperature: options.temperature ?? 0.2,
    };
    if (options.maxTokens) body.max_tokens = options.maxTokens;
    if (options.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice ?? 'auto';
    }

    const url = `${this.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    const startedAt = Date.now();

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`LLM[${this.name}] 网络错误: ${e}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `LLM[${this.name}] HTTP ${res.status}: ${text.slice(0, 500)}`,
      );
    }

    const data = (await res.json()) as any;
    const msg = data?.choices?.[0]?.message ?? {};
    const finishReason = data?.choices?.[0]?.finish_reason as string | undefined;

    // 优先用 content；如果空就回退到 reasoning_content（reasoner 系模型在这里）
    let content: string =
      typeof msg.content === 'string' ? msg.content.trim() : '';
    if (!content && typeof msg.reasoning_content === 'string') {
      content = msg.reasoning_content.trim();
    }

    const usage = data?.usage
      ? {
          prompt: data.usage.prompt_tokens ?? 0,
          completion: data.usage.completion_tokens ?? 0,
          total: data.usage.total_tokens ?? 0,
        }
      : undefined;
    this.logger.log(
      `chat [${this.name}] ${Date.now() - startedAt}ms ` +
        `tokens=${usage?.total ?? '?'} finish=${finishReason ?? '?'}`,
    );

    if (!content) {
      // 完全空 —— 把全量响应打到 logcat 方便排查，错误信息也带 finish_reason
      this.logger.error(
        `LLM[${this.name}] empty content. finish=${finishReason}. ` +
          `full response: ${JSON.stringify(data).slice(0, 1500)}`,
      );
      throw new Error(
        `LLM[${this.name}] 返回为空 (finish_reason=${finishReason ?? 'unknown'})。` +
          `可能原因：触发内容过滤 / 模型不支持 JSON 模式 / 输出被截。`,
      );
    }

    // finish=length 表示输出被 maxTokens 截了，JSON 大概率坏的
    if (finishReason === 'length') {
      this.logger.warn(
        `LLM[${this.name}] 输出被 maxTokens 截断，JSON 可能不完整`,
      );
    }

    // 透传 tool_calls（function calling）
    const toolCalls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((t: any) => ({
          id: String(t.id),
          type: 'function' as const,
          function: {
            name: String(t.function?.name ?? ''),
            arguments: String(t.function?.arguments ?? ''),
          },
        }))
      : undefined;

    return { content, usage, finishReason, toolCalls };
  }
}
