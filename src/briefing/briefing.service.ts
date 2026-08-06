import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';
import { LlmResolver } from '../ai/llm/llm-resolver';
import { HealthService } from '../health/health.service';
import {
  assembleBriefingFacts,
  lastWeekMonday,
  BriefingFacts,
  BriefingFactsInput,
} from './briefing.facts';
import { renderTemplateBriefing } from './briefing.template';
import { buildBriefingMessages, cleanupLlmNarrative } from './briefing.prompt';

/** 生成结果：briefing 为 null 表示空数据周（不生成）；isNew 表示本次新建 */
export interface GenerateResult {
  briefing: any | null;
  isNew: boolean;
  facts: BriefingFacts | null;
}

/**
 * 每周管家简报 · 数据拉取 + 生成编排 + 查询。
 *
 * 生成链路：SQL 聚合 → assembleBriefingFacts（纯函数）→
 *   LLM 正文（账本共享配置 / VIP 槽位，无请求头场景与 tools.controller 同款降级）
 *   → 失败自动降级 renderTemplateBriefing。
 * (userId, ledgerId, weekStart) 唯一约束保证调度器重跑幂等。
 */
@Injectable()
export class BriefingService {
  private readonly logger = new Logger('Briefing');

  constructor(
    private prisma: PrismaService,
    private ledgers: LedgersService,
    private llmResolver: LlmResolver,
    private health: HealthService,
  ) {}

  // ── 查询 ───────────────────────────────────────────────────

  /** GET /briefings/latest —— 最新一份；没有则 briefing=null */
  async latest(userId: string, ledgerId: string) {
    await this.ledgers.ensureMembership(userId, ledgerId);
    const b = await this.prisma.briefing.findFirst({
      where: { userId, ledgerId },
      orderBy: { weekStart: 'desc' },
    });
    return { briefing: b ? this.serialize(b) : null };
  }

  /** GET /briefings —— 历史列表，新周在前 */
  async list(userId: string, ledgerId: string, page = 1, pageSize = 20) {
    await this.ledgers.ensureMembership(userId, ledgerId);
    const where = { userId, ledgerId };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.briefing.count({ where }),
      this.prisma.briefing.findMany({
        where,
        orderBy: { weekStart: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: items.map((b) => this.serialize(b)),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  private serialize = (b: any) => ({
    id: b.id,
    ledgerId: b.ledgerId,
    weekStart: b.weekStart,
    facts: safeParseFacts(b.factsJson),
    narrative: b.narrative,
    source: b.source,
    createdAt: b.createdAt,
  });

  // ── 生成 ───────────────────────────────────────────────────

  /**
   * 生成某用户某账本的上周简报。
   *  - 已存在 → 直接返回（isNew=false），重跑幂等；
   *  - 空数据周（上周 0 笔账单）→ briefing=null，不生成。
   */
  async generateForLedger(
    userId: string,
    ledgerId: string,
    now = new Date(),
  ): Promise<GenerateResult> {
    const weekStart = lastWeekMonday(now);

    const existing = await this.prisma.briefing.findUnique({
      where: { userId_ledgerId_weekStart: { userId, ledgerId, weekStart } },
    });
    if (existing) {
      return {
        briefing: existing,
        isNew: false,
        facts: safeParseFacts(existing.factsJson),
      };
    }

    const facts = await this.collectFacts(userId, ledgerId, weekStart, now);
    if (!facts) return { briefing: null, isNew: false, facts: null };

    const { narrative, source } = await this.writeNarrative(userId, ledgerId, facts);

    let briefing;
    try {
      briefing = await this.prisma.briefing.create({
        data: {
          userId,
          ledgerId,
          weekStart,
          factsJson: JSON.stringify(facts),
          narrative,
          source,
        },
      });
    } catch (e: any) {
      // 并发重跑撞上唯一约束：按已存在处理（幂等）
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const dup = await this.prisma.briefing.findUnique({
          where: { userId_ledgerId_weekStart: { userId, ledgerId, weekStart } },
        });
        return { briefing: dup, isNew: false, facts };
      }
      throw e;
    }
    return { briefing, isNew: true, facts };
  }

  /** SQL 聚合两周账单 / 预算 / 分类 / 周期扣款 / 健康分 → 纯函数组装 */
  private async collectFacts(
    userId: string,
    ledgerId: string,
    weekStart: Date,
    now: Date,
  ): Promise<BriefingFacts | null> {
    const prevStart = new Date(weekStart);
    prevStart.setDate(prevStart.getDate() - 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);
    // 本周（生成周）窗口：周期扣款到期判断用
    const thisMonday = new Date(weekStart);
    thisMonday.setDate(thisMonday.getDate() + 7);
    const thisSunday = new Date(thisMonday);
    thisSunday.setDate(thisSunday.getDate() + 6);
    thisSunday.setHours(23, 59, 59, 999);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

    const [bills, budgets, categories, recurringDue, monthCatAgg] =
      await Promise.all([
        // 两周窗口全部账单（过滤在纯函数层做，这里只取明文字段，绝不取 noteCipher）
        this.prisma.bill.findMany({
          where: { ledgerId, date: { gte: prevStart, lte: weekEnd } },
          select: {
            id: true, type: true, amount: true, categoryId: true,
            isTransfer: true, source: true, date: true,
          },
        }),
        this.prisma.budget.findMany({
          where: { ledgerId, period: 'MONTHLY' },
          select: { categoryId: true, amount: true },
        }),
        this.prisma.category.findMany({
          where: { OR: [{ ledgerId }, { isSystem: true }] },
          select: { id: true, name: true, parentId: true },
        }),
        // 本周将到期的启用中周期扣款（名称是密文，只取分类 / 金额 / 日期）
        this.prisma.recurringBill.findMany({
          where: {
            ledgerId,
            isActive: true,
            nextDate: { gte: thisMonday, lte: thisSunday },
          },
          select: { id: true, categoryId: true, amount: true, type: true, nextDate: true },
        }),
        // 本月至今支出按分类（预算执行口径；过滤转账 / stock）
        this.prisma.bill.groupBy({
          by: ['categoryId'],
          where: {
            ledgerId,
            type: 'expense',
            isTransfer: false,
            source: { not: 'stock' },
            date: { gte: monthStart, lte: now },
          },
          _sum: { amount: true },
        }),
      ]);

    // 健康分：可选增强，失败（如无配置 / 非成员边界）不影响简报
    let healthScore: number | null = null;
    try {
      healthScore = (await this.health.score(userId, ledgerId)).score;
    } catch {
      healthScore = null;
    }

    const monthSpentByCategory: Record<string, Prisma.Decimal> = {};
    for (const r of monthCatAgg) {
      monthSpentByCategory[r.categoryId] = r._sum.amount ?? new Prisma.Decimal(0);
    }

    const input: BriefingFactsInput = {
      weekStart,
      bills: bills.map((b) => ({ ...b, type: b.type as string })),
      budgets,
      monthSpentByCategory,
      categories,
      recurringDue: recurringDue.map((r) => ({ ...r, type: r.type as string })),
      healthScore,
    };
    return assembleBriefingFacts(input);
  }

  /** LLM 优先，失败 / 坏格式自动降级模板。服务端自发任务没有请求头配置。 */
  private async writeNarrative(
    userId: string,
    ledgerId: string,
    facts: BriefingFacts,
  ): Promise<{ narrative: string; source: 'llm' | 'template' }> {
    try {
      const llm = await this.llmResolver.resolveText({
        userId,
        ledgerId,
        header: null,
      });
      const res = await llm.model.chat(buildBriefingMessages(facts), {
        maxTokens: 600,
      });
      const narrative = cleanupLlmNarrative(res.content);
      if (narrative) return { narrative, source: 'llm' };
      this.logger.warn(`LLM 简报正文格式不合格（${res.content?.length ?? 0} 字），降级模板`);
    } catch (e: any) {
      this.logger.warn(`LLM 简报生成失败，降级模板：${e?.message}`);
    }
    return { narrative: renderTemplateBriefing(facts), source: 'template' };
  }
}

function safeParseFacts(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
