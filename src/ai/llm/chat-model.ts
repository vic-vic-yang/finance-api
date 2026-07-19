/**
 * 统一的对话模型接口。
 *
 * 所有 OpenAI 兼容协议的模型（DeepSeek / MiMo / 千问 / Kimi / 智谱…）
 * 都用同一个 OpenAiCompatibleClient 实现，只是 baseUrl + apiKey + modelId 不同。
 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image_url';
  image_url: { url: string }; // base64 data url 或者 https url
}

export type MessagePart = TextPart | ImagePart;

/** 模型决定调用的工具（OpenAI tool_calls 协议直传）*/
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  /** string 是纯文本；数组是 multimodal（图文混合）；assistant 工具调用时可为 null */
  content?: string | MessagePart[] | null;
  /** assistant 角色当模型决定调工具时返回 */
  tool_calls?: ToolCall[];
  /** role='tool' 时必填，对应触发它的 tool_call.id */
  tool_call_id?: string;
  /** role='tool' 时附带的函数名（部分模型要求） */
  name?: string;
}

/** 工具规格（function calling） */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    /** 标准 JSON Schema */
    parameters: Record<string, any>;
  };
}

export interface ChatOptions {
  /** 'json_object' 强制返回合法 JSON；'text' 不限 */
  responseFormat?: 'json_object' | 'text';
  temperature?: number;
  maxTokens?: number;
  /** 工具列表（function calling）— 透传到 OpenAI 协议的 tools 字段 */
  tools?: ToolSpec[];
  /** 'auto'(默认) / 'none' / 强制某个工具 */
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  /**
   * 思考模式开关（目前仅对 DeepSeek V4 系生效，默认关闭）。
   * true = 显式开启；省略 / false = 关闭（省 token、降延迟）
   */
  thinking?: boolean;
}

export interface ChatResponse {
  /** 模型最终回复的文本（finish=tool_calls 时可能为空字符串） */
  content: string;
  /** 调试信息：token 用量 */
  usage?: { prompt: number; completion: number; total: number };
  /** OpenAI 协议的 finish_reason：stop / length / content_filter / tool_calls / ... */
  finishReason?: string;
  /** 模型决定调用的工具（function calling）。finish=tool_calls 时有值 */
  toolCalls?: ToolCall[];
}

export interface ChatModel {
  /** 友好显示名 */
  readonly name: string;
  /** 是否支持视觉输入 */
  readonly supportsVision: boolean;

  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
}
