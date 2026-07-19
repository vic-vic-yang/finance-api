import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgersService } from '../../ledgers/ledgers.service';
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
  /** personal=用户手机自带 / ledger=账本共享 / server=服务端默认(VIP) */
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
 *   ③ 服务端 .env 默认（仅 VIP 用户可用）
 *   ④ 都没有 → 抛「请先配置 AI 模型」
 */
@Injectable()
export class LlmResolver implements OnModuleInit {
  private readonly logger = new Logger(LlmResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly registry: LlmRegistry,
    private readonly ledgers: LedgersService,
  ) {}

  onModuleInit() {
    if (
      !this.config.get<string>('LLM_CONFIG_SECRET') &&
      !this.config.get<string>('JWT_SECRET')
    ) {
      this.logger.warn(
        '⚠️ LLM_CONFIG_SECRET / JWT_SECRET 均未配置，账本共享 LLM Key 将用内置兜底密钥加密——生产环境必须配置！',
      );
    }
  }

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

  // ── VIP ─────────────────────────────────────────────────

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
    // ③ 服务端默认（仅 VIP）
    if (await this._isVip(opts.userId)) {
      const name = this.registry.defaultTextModelName();
      if (name) {
        return { name, source: 'server', model: this.registry.get(name) };
      }
    }
    throw new ForbiddenException(
      '尚未配置 AI 模型：请到「我的→设置→AI 模型」填写你的模型和 Key，或开通 VIP 使用服务端内置模型',
    );
  }

  /** 视觉模型解析（图片导入用）；返回 null 表示当前配置不支持视觉 */
  async resolveVision(opts: {
    userId?: string | null;
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
    // 服务端默认视觉模型（仅 VIP）
    if (await this._isVip(opts.userId)) {
      const name = this.registry.defaultVisionModelName();
      if (name) {
        return { name, source: 'server', model: this.registry.get(name) };
      }
    }
    return null;
  }

  // ── 账本共享配置 CRUD（配置页用；一律先校验账本成员身份） ────────

  /** 当前账本的共享配置视图（不含 Key）+ 是否 VIP（可用服务端默认） */
  async getConfigView(
    ledgerId: string,
    userId: string,
  ): Promise<{ shared: LedgerLlmView | null; serverDefaultAllowed: boolean }> {
    await this.ledgers.ensureMembership(userId, ledgerId);
    const cfg = await this.prisma.ledgerLlmConfig.findUnique({
      where: { ledgerId },
    });
    let shared: LedgerLlmView | null = null;
    if (cfg) {
      const owner = await this.prisma.user.findUnique({
        where: { id: cfg.ownerUserId },
        select: { username: true, nickname: true },
      });
      shared = {
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        modelId: cfg.modelId,
        visionModelId: cfg.visionModelId,
        ownerUserId: cfg.ownerUserId,
        ownerName: owner?.nickname || owner?.username || '成员',
        isOwner: cfg.ownerUserId === userId,
      };
    }
    return { shared, serverDefaultAllowed: await this._isVip(userId) };
  }

  /** 保存/更新账本共享配置（Key 加密落库；仅配置者可改） */
  async upsertLedgerConfig(
    ledgerId: string,
    userId: string,
    dto: {
      provider?: string;
      baseUrl: string;
      modelId: string;
      visionModelId?: string | null;
      apiKey?: string;
    },
  ): Promise<{ message: string }> {
    await this.ledgers.ensureMembership(userId, ledgerId);
    const existing = await this.prisma.ledgerLlmConfig.findUnique({
      where: { ledgerId },
    });
    if (existing && existing.ownerUserId !== userId) {
      throw new ForbiddenException('该账本的共享模型由其他成员配置，只有配置者本人可以修改');
    }
    const key = (dto.apiKey ?? '').trim();
    if (!existing && !key) {
      throw new ForbiddenException('请填写 API Key');
    }
    const apiKeyEnc = key ? this.encryptKey(key) : existing!.apiKeyEnc;
    await this.prisma.ledgerLlmConfig.upsert({
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
  }

  /** 关闭共享并删除服务器上的 Key（仅配置者） */
  async deleteLedgerConfig(
    ledgerId: string,
    userId: string,
  ): Promise<{ message: string }> {
    await this.ledgers.ensureMembership(userId, ledgerId);
    const existing = await this.prisma.ledgerLlmConfig.findUnique({
      where: { ledgerId },
    });
    if (!existing) return { message: '已关闭共享' };
    if (existing.ownerUserId !== userId) {
      throw new ForbiddenException('只有配置者本人可以关闭共享');
    }
    await this.prisma.ledgerLlmConfig.delete({ where: { ledgerId } });
    return { message: '已关闭共享并删除服务器上的 Key' };
  }
}

export interface LedgerLlmView {
  provider: string;
  baseUrl: string;
  modelId: string;
  visionModelId: string | null;
  ownerUserId: string;
  ownerName: string;
  isOwner: boolean;
}
