import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StockService } from './stock.service';

/**
 * 股票持仓自动结算：
 *  - 关联了账户的持仓，每天 15:00（A股收盘后）按最新价计算「当日盈亏」，
 *    在关联账户记一条转账类流水(isTransfer，不计收支)，并把账户余额更新为最新市值。
 *  - 幂等：同一天只结算一次（lastCalcAt 当天则跳过）。
 *  - 自愈：15:00 没跑成功（后端没开/失败），下次进入程序拉股票列表时补算
 *    （settleForUser）；后端重启时也补算（onModuleInit）。仅在 ≥15:00 才结算当天，
 *    保证用的是收盘价而非盘中价。
 *  - 当日盈亏 = (最新价 − 上次结算价) × 持股数。基准价在关联账户时用实时价建立，
 *    所以不会把"买入至今"的累计盈亏一次性灌进账户。
 */
@Injectable()
export class StockHoldingService implements OnModuleInit {
  private readonly logger = new Logger('StockHolding');
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
  ) {}

  onModuleInit() {
    // 启动补算：把后端没开着时错过的收盘结算补上
    this.settleAllDue().catch((e) =>
      this.logger.warn(`启动补算失败：${e?.message}`),
    );
  }

  /** 每天 15:00 收盘后结算（后端常驻时生效） */
  @Cron('0 0 15 * * *')
  async scheduledSettle() {
    this.logger.log('收盘结算持仓当日盈亏（15:00）…');
    await this.settleAllDue().catch((e) =>
      this.logger.warn(`定时结算失败：${e?.message}`),
    );
  }

  /** 全量补算（启动 / 定时用）。inflight 锁避免并发重入。 */
  async settleAllDue(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this._settle({}).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** 某用户进入程序时的懒补算（不阻塞接口，吞异常） */
  async settleForUser(userId: string): Promise<void> {
    try {
      await this._settle({ userId });
    } catch (e: any) {
      this.logger.warn(`用户补算失败：${e?.message}`);
    }
  }

  private async _settle(where: Prisma.StockHoldingWhereInput): Promise<void> {
    const holdings = await this.prisma.stockHolding.findMany({
      where: {
        ...where,
        accountId: { not: null },
        ledgerId: { not: null },
      },
    });
    const now = new Date();
    for (const h of holdings) {
      try {
        await this.settleOne(h, now);
      } catch (e: any) {
        this.logger.warn(`结算 ${h.symbol} 失败：${e?.message}`);
      }
    }
  }

  /** 单只持仓结算（含幂等/收盘时间判断） */
  private async settleOne(h: any, now: Date): Promise<void> {
    if (!h.accountId || !h.ledgerId || !(h.shares > 0)) return;
    // 仅 ≥15:00 才结算"今天"（用收盘价，不用盘中价）
    if (now.getHours() < 15) return;
    // 同一天已结算 → 跳过
    if (h.lastCalcAt && this.isSameLocalDay(new Date(h.lastCalcAt), now)) return;

    const live = await this.stock.fetchLivePrice(h.symbol).catch(() => null);
    const price = live?.price;
    if (price == null || !(price > 0)) return; // 拿不到价 → 不动，下次再补

    // 账户仍存在且属于该账本
    const acc = await this.prisma.account.findFirst({
      where: { id: h.accountId, ledgerId: h.ledgerId },
    });
    if (!acc) return;

    // 顺带做一次「我的持仓 + 股票数据」的 AI 持仓决策分析（best-effort，不阻断结算）
    const advice = await this.stock
      .analyzeHoldingDecision(h.symbol, {
        buyPrice: h.buyPrice,
        shares: h.shares,
        currentPrice: price,
      })
      .catch(() => null);
    const adviceData: { advice?: string; adviceAt?: Date } = advice
      ? { advice: JSON.stringify(advice), adviceAt: now }
      : {};

    // 尚无基准价 → 仅建立基准，不记账
    if (h.lastPrice == null || !(h.lastPrice > 0)) {
      await this.prisma.stockHolding.update({
        where: { id: h.id },
        data: { lastPrice: price, lastCalcAt: now, ...adviceData },
      });
      return;
    }

    const delta = this.round2((price - h.lastPrice) * h.shares);

    if (Math.abs(delta) < 0.01) {
      // 无变化（停牌/周末/休市）→ 仅推进结算时间（仍更新持仓建议）
      await this.prisma.stockHolding.update({
        where: { id: h.id },
        data: { lastPrice: price, lastCalcAt: now, ...adviceData },
      });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const categoryId = await this.getOrCreateInvestCategory(tx, h.ledgerId);
      const amount = new Prisma.Decimal(Math.abs(delta));
      await tx.bill.create({
        data: {
          ledgerId: h.ledgerId,
          userId: h.userId,
          accountId: h.accountId,
          categoryId,
          type: delta > 0 ? 'income' : 'expense',
          amount,
          // 系统账单：服务端无法加密，noteCipher 存 UTF-8 明文，noteDekVer=0 让客户端按明文显示
          noteCipher: Buffer.from(`${h.symbol} 当日盈亏`, 'utf8'),
          noteDekVer: 0,
          date: now,
          source: 'stock',
          isTransfer: true, // 纸面盈亏：不计收支，仅反映市值变化
        },
      });
      // 余额更新为最新市值（按 delta 增减；盈→增，亏→减）
      await tx.account.update({
        where: { id: h.accountId },
        data: { balance: { increment: new Prisma.Decimal(delta) } },
      });
      await tx.stockHolding.update({
        where: { id: h.id },
        data: { lastPrice: price, lastCalcAt: now, ...adviceData },
      });
    });
    this.logger.log(
      `${h.symbol} 当日${delta > 0 ? '收益' : '亏损'} ${Math.abs(delta).toFixed(2)} → 账户 ${h.accountId}`,
    );
  }

  private async getOrCreateInvestCategory(
    tx: Prisma.TransactionClient,
    ledgerId: string,
  ): Promise<string> {
    const exist = await tx.category.findFirst({
      where: { ledgerId, name: '投资收益', parentId: null },
    });
    if (exist) return exist.id;
    const created = await tx.category.create({
      data: {
        name: '投资收益',
        type: 'income',
        ledgerId,
        icon: '📈',
        isSystem: false,
      },
    });
    return created.id;
  }

  private isSameLocalDay(a: Date, b: Date): boolean {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  private round2(x: number): number {
    return Math.round(x * 100) / 100;
  }
}
