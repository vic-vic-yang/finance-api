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
      // Kimi K3 等模型只允许 temperature=1；确保不低于 1
      temperature: Math.max(1, options.temperature ?? 0.2),
    };
    if (options.maxTokens) body.max_tokens = options.maxTokens;
    if (options.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice ?? 'auto';
    }

    // 兼容两种 baseUrl 格式：
    //   "https://api.deepseek.com"       → /v1/chat/completions
    //   "https://api.moonshot.cn/v1"     → /chat/completions（已含 /v1）
    const base = this.baseUrl.replace(/\/+$/, '');
    const url = base.endsWith('/v1')
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;
    const startedAt = Date.now();

    // 瞬时网络故障（连接被掐断/超时/429/5xx）自动重试：1s、3s 退避后再试，
    // 共 3 次。注意读响应体也可能断（TypeError: terminated），所以整段都在重试圈里。
    const MAX_ATTEMPTS = 3;
    let data: any;
    for (let attempt = 1; ; attempt++) {
      try {
        let res: Response;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
            // 单次尝试最长 5 分钟（大流水解析输出长），防挂死
            signal: AbortSignal.timeout(300_000),
          });
        } catch (e) {
          throw new Error(`LLM[${this.name}] 网络错误: ${e}`);
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(
            `LLM[${this.name}] HTTP ${res.status}: ${text.slice(0, 500)}`,
          );
          // 429/5xx 值得重试；4xx（参数/鉴权错）重试也没用
          (err as any).retryable = res.status === 429 || res.status >= 500;
          throw err;
        }

        // 读响应体：连接中途断开会在这里抛 TypeError: terminated
        data = (await res.json()) as any;
        break;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        const retryable =
          (e as any)?.retryable === true ||
          /terminated|aborted|timeout|fetch failed|network|ECONNRESET|ECONNREFUSED|socket|EPIPE|UND_ERR/i.test(
            msg,
          );
        if (!retryable || attempt >= MAX_ATTEMPTS) throw e;
        const delay = attempt === 1 ? 1000 : 3000;
        this.logger.warn(
          `chat [${this.name}] 第 ${attempt} 次失败(${msg.slice(0, 120)})，${delay}ms 后重试…`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
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
