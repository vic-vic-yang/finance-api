import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatModel } from './chat-model';
import { OpenAiCompatibleClient } from './openai-compatible';
import { LlmRegistry } from './llm-registry';

/** 客户端随请求头带来的个人 LLM 配置（Key 只存用户手机，服务端过手不落库） */
export interface HeaderLlmCfg {
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
}

export interface ResolvedLlm {
  name: string;
  model: ChatModel;
  /** personal=用户手机自带 / ledger=账本共享 / server=服务端默认(白名单) */
  source: 'personal' | 'ledger' | 'server';
}

/** 从请求头提取个人 LLM 配置；三件套不齐则视为未配置 */
export function headerLlmCfg(req: any): HeaderLlmCfg | null {
  const h = req?.headers ?? {};
  const baseUrl = String(h['x-llm-base-url'] ?? '').trim();
  const apiKey = String(h['x-llm-api-key'] ?? '').trim();
  const model = String(h['x-llm-model'] ?? '').trim();
  const visionModel = String(h['x-llm-vision-model'] ?? '').trim();
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model, visionModel: visionModel || undefined };
}

/**
 * LLM 三层解析（BYOK）：
 *   ① 请求头个人配置（永远最优先）
 *   ② 当前账本的共享配置（LedgerLlmConfig，Key 加密落库）
 *   ③ 服务端 .env 默认（LLM_DEFAULT_ALLOWED_USERS 白名单；未设置该变量=全放行）
 *   ④ 都没有 → 抛「请先配置 AI 模型」
 */
@Injectable()
export class LlmResolver {
  private readonly logger = new Logger(LlmResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly registry: LlmRegistry,
  ) {}

  // ── Key 加密（AES-256-GCM，密钥来自 LLM_CONFIG_SECRET，缺省回落 JWT_SECRET）──

  private aesKey(): Buffer {
    const secret =
      this.config.get<string>('LLM_CONFIG_SECRET') ||
      this.config.get<string>('JWT_SECRET') ||
      'siku-llm-config';
    return createHash('sha256').update(secret, 'utf8').digest();
  }

  encryptKey(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.aesKey(), iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
  }

  decryptKey(enc: string): string {
    const buf = Buffer.from(enc, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.aesKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  // ── 白名单 ────────────────────────────────────────────────

  /** 未配置 LLM_DEFAULT_ALLOWED_USERS 时全放行（平滑上线）；配置后仅名单内可用服务端默认 */
  serverDefaultAllowed(username?: string | null): boolean {
    const raw = this._allowedListRaw();
    if (!raw) return true;
    if (!username) return false;
    return this._isInList(username, raw);
  }

  /** 读取 LLM_DEFAULT_ALLOWED_USERS 原始值（空 = 未配置） */
  private _allowedListRaw(): string | null {
    const raw = (this.config.get<string>('LLM_DEFAULT_ALLOWED_USERS') || '').trim();
    return raw || null;
  }

  /** 用户名是否在逗号分隔的白名单中 */
  private _isInList(username: string, raw: string): boolean {
    return raw
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
      .includes(username.toLowerCase());
  }

  /**
   * 检查用户是否为 VIP（只看 vipTier，不关心 role）。
   * - VIP 到期时间 null = 永久有效
   */
  private async _isVip(userId?: string | null): Promise<boolean> {
    if (!userId) return false;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { vipTier: true, vipExpiresAt: true },
    });
    if (!user) return false;
    // 非 free 等级视为 VIP
    if (user.vipTier === 'free') return false;
    // 到期时间 null = 永久
    if (!user.vipExpiresAt) return true;
    return user.vipExpiresAt > new Date();
  }

  // ── 解析 ──────────────────────────────────────────────────

  async resolveText(opts: {
    userId?: string | null;
    username?: string | null;
    ledgerId?: string | null;
    header?: HeaderLlmCfg | null;
  }): Promise<ResolvedLlm> {
    // ① 个人（请求头）
    if (opts.header) {
      return {
        name: opts.header.model,
        source: 'personal',
        model: new OpenAiCompatibleClient(
          opts.header.model, false, opts.header.baseUrl,
          opts.header.apiKey, opts.header.model,
        ),
      };
    }
    // ② 账本共享
    if (opts.ledgerId) {
      const cfg = await this.prisma.ledgerLlmConfig.findUnique({
        where: { ledgerId: opts.ledgerId },
      });
      if (cfg) {
        try {
          const key = this.decryptKey(cfg.apiKeyEnc);
          return {
            name: cfg.modelId,
            source: 'ledger',
            model: new OpenAiCompatibleClient(
              cfg.modelId, false, cfg.baseUrl, key, cfg.modelId,
            ),
          };
        } catch (e: any) {
          this.logger.warn(`账本 LLM 配置解密失败：${e?.message}`);
        }
      }
    }
    // ③ 服务端默认（VIP / 白名单 / admin 可用）
    if (this.serverDefaultAllowed(opts.username)) {
      const name = this.registry.defaultTextModelName();
      if (name) {
        // 白名单内用户直接放行；其余需 VIP
        const listRaw = this._allowedListRaw();
        const inWhitelist = listRaw && opts.username && this._isInList(opts.username, listRaw);
        if (!inWhitelist && !(await this._isVip(opts.userId))) {
          throw new ForbiddenException(
            '服务端 AI 模型是 VIP 会员专属功能。请开通 VIP 或到「设置→AI 模型」配置你自己的模型',
          );
        }
        return { name, source: 'server', model: this.registry.get(name) };
      }
    }
    throw new ForbiddenException(
      '尚未配置 AI 模型：请到「我的→设置→AI 模型」填写你的模型和 Key，或联系管理员开通 VIP',
    );
  }

  /** 视觉模型解析（图片导入用）；返回 null 表示当前配置不支持视觉 */
  async resolveVision(opts: {
    userId?: string | null;
    username?: string | null;
    ledgerId?: string | null;
    header?: HeaderLlmCfg | null;
  }): Promise<ResolvedLlm | null> {
    if (opts.header) {
      const vm = opts.header.visionModel;
      if (!vm) return null;
      return {
        name: vm,
        source: 'personal',
        model: new OpenAiCompatibleClient(
          vm, true, opts.header.baseUrl, opts.header.apiKey, vm,
        ),
      };
    }
    if (opts.ledgerId) {
      const cfg = await this.prisma.ledgerLlmConfig.findUnique({
        where: { ledgerId: opts.ledgerId },
      });
      if (cfg) {
        if (!cfg.visionModelId) return null;
        try {
          const key = this.decryptKey(cfg.apiKeyEnc);
          return {
            name: cfg.visionModelId,
            source: 'ledger',
            model: new OpenAiCompatibleClient(
              cfg.visionModelId, true, cfg.baseUrl, key, cfg.visionModelId,
            ),
          };
        } catch { /* 解密失败按无视觉处理 */ }
      }
    }
    if (this.serverDefaultAllowed(opts.username)) {
      const name = this.registry.defaultVisionModelName();
      if (name) {
        const listRaw = this._allowedListRaw();
        const inWhitelist = listRaw && opts.username && this._isInList(opts.username, listRaw);
        if (!inWhitelist && !(await this._isVip(opts.userId))) {
          return null; // 非 VIP 不提供视觉模型
        }
        return { name, source: 'server', model: this.registry.get(name) };
      }
    }
    return null;
  }
}

// ── 账本共享配置 CRUD（配置页用） ─────────────────────────────

export interface LedgerLlmView {
  provider: string;
  baseUrl: string;
  modelId: string;
  visionModelId: string | null;
  ownerUserId: string;
  ownerName: string;
  isOwner: boolean;
}

declare module './llm-resolver' {
  interface LlmResolver {
    getConfigView(ledgerId: string, userId: string, username?: string | null):
      Promise<{ shared: LedgerLlmView | null; serverDefaultAllowed: boolean }>;
    upsertLedgerConfig(ledgerId: string, userId: string, dto: {
      provider?: string; baseUrl: string; modelId: string;
      visionModelId?: string | null; apiKey?: string;
    }): Promise<{ message: string }>;
    deleteLedgerConfig(ledgerId: string, userId: string): Promise<{ message: string }>;
  }
}

LlmResolver.prototype.getConfigView = async function (
  this: LlmResolver, ledgerId: string, userId: string, username?: string | null,
) {
  const self = this as any;
  const cfg = await self.prisma.ledgerLlmConfig.findUnique({ where: { ledgerId } });
  let shared: LedgerLlmView | null = null;
  if (cfg) {
    const owner = await self.prisma.user.findUnique({
      where: { id: cfg.ownerUserId },
      select: { username: true, nickname: true },
    });
    shared = {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      modelId: cfg.modelId,
      visionModelId: cfg.visionModelId,
      ownerUserId: cfg.ownerUserId,
      ownerName: (owner?.nickname || owner?.username || '成员') as string,
      isOwner: cfg.ownerUserId === userId,
    };
  }
  return { shared, serverDefaultAllowed: this.serverDefaultAllowed(username) };
};

LlmResolver.prototype.upsertLedgerConfig = async function (
  this: LlmResolver, ledgerId: string, userId: string,
  dto: { provider?: string; baseUrl: string; modelId: string; visionModelId?: string | null; apiKey?: string },
) {
  const self = this as any;
  const existing = await self.prisma.ledgerLlmConfig.findUnique({ where: { ledgerId } });
  if (existing && existing.ownerUserId !== userId) {
    throw new ForbiddenException('该账本的共享模型由其他成员配置，只有配置者本人可以修改');
  }
  const key = (dto.apiKey ?? '').trim();
  if (!existing && !key) {
    throw new ForbiddenException('请填写 API Key');
  }
  const apiKeyEnc = key ? this.encryptKey(key) : existing!.apiKeyEnc;
  await self.prisma.ledgerLlmConfig.upsert({
    where: { ledgerId },
    create: {
      ledgerId,
      ownerUserId: userId,
      provider: dto.provider ?? 'custom',
      baseUrl: dto.baseUrl,
      modelId: dto.modelId,
      visionModelId: dto.visionModelId ?? null,
      apiKeyEnc,
    },
    update: {
      provider: dto.provider ?? 'custom',
      baseUrl: dto.baseUrl,
      modelId: dto.modelId,
      visionModelId: dto.visionModelId ?? null,
      apiKeyEnc,
    },
  });
  return { message: '已共享给账本成员' };
};

LlmResolver.prototype.deleteLedgerConfig = async function (
  this: LlmResolver, ledgerId: string, userId: string,
) {
  const self = this as any;
  const existing = await self.prisma.ledgerLlmConfig.findUnique({ where: { ledgerId } });
  if (!existing) return { message: '已关闭共享' };
  if (existing.ownerUserId !== userId) {
    throw new ForbiddenException('只有配置者本人可以关闭共享');
  }
  await self.prisma.ledgerLlmConfig.delete({ where: { ledgerId } });
  return { message: '已关闭共享并删除服务器上的 Key' };
};
