import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StockService } from './stock.service';
import {
  STOCK_CLOSE_SOURCE,
  STOCK_PAPER_SOURCE,
  calcClosePnl,
  calcFinalMarkDelta,
  roundMoney,
} from './stock-close';

/**
 * 股票持仓自动结算 + 平仓：
 *  - 关联了账户的持仓，每天 15:00（A股收盘后）按最新价计算「当日盈亏」，
 *    在关联账户记一条流水（source='stock' 的普通收支账单，各统计聚合点按
 *    source 排除、不计收支），并把账户余额更新为最新市值。
 *  - 幂等：同一天只结算一次（lastCalcAt 当天则跳过）。
 *  - 自愈：15:00 没跑成功（后端没开/失败），下次进入程序拉股票列表时补算
 *    （settleForUser）；后端重启时也补算（onModuleInit）。仅在 ≥15:00 才结算当天，
 *    保证用的是收盘价而非盘中价。
 *  - 当日盈亏 = (最新价 − 上次结算价) × 持股数。基准价在关联账户时用实时价建立，
 *    所以不会把"买入至今"的累计盈亏一次性灌进账户。
 *  - 平仓（closeHolding）：按用户确认的平仓价算相对成本的总盈亏，记
 *    source='stock_close' 流水（计入收支）；余额只做 lastPrice→平仓价的最后
 *    对齐，不再按总盈亏加减，避免与纸面结算双计。平仓后删除持仓以停止结算。
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

  /** 工作日 15:30 收盘后结算（15:00 收盘，留半小时让价格更稳；后端常驻时生效） */
  @Cron('0 30 15 * * 1-5')
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

  /** 组合每日总盈亏：聚合 source='stock' 的当日盈亏账单，按本地日合计 */
  async dailyPnl(
    userId: string,
    days = 30,
  ): Promise<{ date: string; pnl: number }[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);
    const bills = await this.prisma.bill.findMany({
      where: { userId, source: STOCK_PAPER_SOURCE, date: { gte: since } },
      select: { date: true, amount: true, type: true },
      orderBy: { date: 'asc' },
    });
    const map = new Map<string, number>();
    for (const b of bills) {
      const d = b.date;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const signed = (b.type === 'income' ? 1 : -1) * Number(b.amount);
      map.set(key, (map.get(key) ?? 0) + signed);
    }
    return [...map.entries()].map(([date, pnl]) => ({
      date,
      pnl: roundMoney(pnl),
    }));
  }

  /**
   * 全部平仓：按平仓价计算相对成本的总盈亏，写入关联账户流水后删除持仓。
   *
   * Body：{ closePrice, accountId? }
   *  - closePrice：用户确认的平仓价（必填）
   *  - accountId：记账账户；缺省用持仓已关联账户；都无则只删持仓不记账
   *
   * 记账口径（避免与每日纸面结算双计）：
   *  1. 若有 lastPrice：余额 += (closePrice − lastPrice)×shares（最后市值对齐），
   *     并记一条 source='stock' 纸面流水（与收盘结算同形）。
   *  2. 再记一条 source='stock_close' 的已实现盈亏 = (closePrice − buyPrice)×shares，
   *     计入收支统计，但**不再改余额**（市值已在账户里）。
   *  3. 删除 StockHolding，后续 settle 不再碰这只票。
   */
  async closeHolding(
    userId: string,
    symbol: string,
    body: { closePrice?: number; accountId?: string | null },
    opts?: { ledgerId?: string | null },
  ) {
    const sym = symbol.toUpperCase();
    const closePrice = Number(body?.closePrice);
    if (!(closePrice > 0) || !Number.isFinite(closePrice)) {
      throw new BadRequestException('请填写有效的平仓价格');
    }

    const holding = await this.prisma.stockHolding.findUnique({
      where: { userId_symbol: { userId, symbol: sym } },
    });
    if (!holding || !(holding.shares > 0) || !(holding.buyPrice > 0)) {
      throw new NotFoundException('没有可平仓的持仓');
    }

    const pnl = calcClosePnl({
      buyPrice: holding.buyPrice,
      shares: holding.shares,
      closePrice,
    });
    if (!pnl) {
      throw new BadRequestException('持仓数据无效，无法平仓');
    }

    const accountId = body?.accountId || holding.accountId || null;
    const ledgerId = holding.ledgerId || opts?.ledgerId || null;
    const now = new Date();

    // 无账户：只清持仓，返回预览盈亏（客户端可提示「未关联账户，未记流水」）
    if (!accountId || !ledgerId) {
      await this.prisma.stockHolding.delete({ where: { id: holding.id } });
      return {
        holding: null,
        closed: true,
        billed: false,
        symbol: sym,
        closePrice: roundMoney(closePrice),
        shares: holding.shares,
        buyPrice: holding.buyPrice,
        ...pnl,
        bill: null,
        message: '已平仓（未关联账户，未记流水）',
      };
    }

    const acc = await this.prisma.account.findFirst({
      where: {
        id: accountId,
        ledgerId,
        OR: [{ ownerId: null }, { ownerId: userId }],
      },
    });
    if (!acc) {
      throw new BadRequestException('关联账户不存在或无权使用');
    }

    const displayName = await this.resolveDisplayName(sym);
    const finalMark = calcFinalMarkDelta(
      holding.lastPrice,
      closePrice,
      holding.shares,
    );

    const bill = await this.prisma.$transaction(async (tx) => {
      // 并发保护：持仓仍在才删得掉；已被别的请求平仓则放弃
      const gone = await tx.stockHolding.deleteMany({
        where: { id: holding.id, userId },
      });
      if (gone.count === 0) {
        throw new BadRequestException('持仓已平仓或不存在');
      }

      const categoryId = await this.getOrCreateInvestCategory(tx, ledgerId);

      // 1) 最后市值对齐（纸面，与每日结算同 source，不计收支）
      if (Math.abs(finalMark) >= 0.01) {
        await tx.bill.create({
          data: {
            ledgerId,
            userId,
            accountId,
            categoryId,
            type: finalMark > 0 ? 'income' : 'expense',
            amount: new Prisma.Decimal(Math.abs(finalMark)),
            noteCipher: Buffer.from(`${displayName} 平仓结算`, 'utf8'),
            noteDekVer: 0,
            date: now,
            source: STOCK_PAPER_SOURCE,
            isTransfer: false,
          },
        });
        await tx.account.update({
          where: { id: accountId },
          data: { balance: { increment: new Prisma.Decimal(finalMark) } },
        });
      }

      // 2) 已实现总盈亏（计入收支；不改余额——避免与纸面双计）
      let closeBill = null;
      if (Math.abs(pnl.totalPnl) >= 0.01) {
        closeBill = await tx.bill.create({
          data: {
            ledgerId,
            userId,
            accountId,
            categoryId,
            type: pnl.totalPnl > 0 ? 'income' : 'expense',
            amount: new Prisma.Decimal(Math.abs(pnl.totalPnl)),
            // 系统账单：UTF-8 明文 + noteDekVer=0（与纸面结算一致）
            noteCipher: Buffer.from(
              `${displayName} 平仓盈亏 @${roundMoney(closePrice)}`,
              'utf8',
            ),
            noteDekVer: 0,
            date: now,
            source: STOCK_CLOSE_SOURCE,
            isTransfer: false,
          },
        });
      }

      return closeBill;
    });

    this.logger.log(
      `${sym} 平仓 @${closePrice} 股数=${holding.shares} 盈亏=${pnl.totalPnl} → 账户 ${accountId}`,
    );

    return {
      holding: null,
      closed: true,
      billed: bill != null,
      symbol: sym,
      closePrice: roundMoney(closePrice),
      shares: holding.shares,
      buyPrice: holding.buyPrice,
      ...pnl,
      bill: bill
        ? {
            id: bill.id,
            type: bill.type,
            amount: Number(bill.amount),
            source: bill.source,
          }
        : null,
      message:
        pnl.totalPnl >= 0
          ? `已平仓，盈利 ${pnl.totalPnl.toFixed(2)}`
          : `已平仓，亏损 ${Math.abs(pnl.totalPnl).toFixed(2)}`,
    };
  }

  private async resolveDisplayName(symbol: string): Promise<string> {
    const meta = await this.prisma.stockAnalysis.findFirst({
      where: { symbol },
      orderBy: { createdAt: 'desc' },
      select: { name: true, nameZh: true },
    });
    return meta?.nameZh || meta?.name || symbol;
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

    // 原子占位（防并发重复结算）：把 lastCalcAt 抢占为今天，只有一个并发运行成功。
    // 「今天是否已结算」的判断+写入必须原子，否则 15:30 前后多个 settleForUser 并发
    // 会各自以为今天没结算 → 同日重复记账、账户余额被重复加减。
    // updateMany 在行锁下重新校验 where，故第二个并发运行会 count=0 直接退出。
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const claim = await this.prisma.stockHolding.updateMany({
      where: {
        id: h.id,
        OR: [{ lastCalcAt: null }, { lastCalcAt: { lt: startToday } }],
      },
      data: { lastCalcAt: now },
    });
    if (claim.count === 0) return; // 今天已被别的运行结算过

    // 尚无基准价 → 仅建立基准，不记账
    if (h.lastPrice == null || !(h.lastPrice > 0)) {
      await this.prisma.stockHolding.update({
        where: { id: h.id },
        data: { lastPrice: price, lastCalcAt: now },
      });
      return;
    }

    // 市值变化：用于账户余额，保证账户 = 最新市值（即便漏结算多天也一次性自愈）
    const mvDelta = roundMoney((price - h.lastPrice) * h.shares);
    // 当日盈亏（流水口径）：优先「今日每股涨跌 × 股数」，与持仓卡一致；
    // 拿不到今日涨跌时才回退到市值变化。避免漏结算把多天涨幅误记成「当日」。
    const change = live?.change;
    const dayDelta =
      change != null && Number.isFinite(change)
        ? roundMoney(change * h.shares)
        : mvDelta;

    if (Math.abs(mvDelta) < 0.01 && Math.abs(dayDelta) < 0.01) {
      // 无变化（停牌/周末/休市）→ 仅推进结算时间（仍更新持仓建议）
      await this.prisma.stockHolding.update({
        where: { id: h.id },
        data: { lastPrice: price, lastCalcAt: now },
      });
      return;
    }

    const displayName = await this.resolveDisplayName(h.symbol);

    await this.prisma.$transaction(async (tx) => {
      // 当日盈亏账单：按「今日涨跌」记，>0.01 才记一条
      if (Math.abs(dayDelta) >= 0.01) {
        const categoryId = await this.getOrCreateInvestCategory(tx, h.ledgerId);
        await tx.bill.create({
          data: {
            ledgerId: h.ledgerId,
            userId: h.userId,
            accountId: h.accountId,
            categoryId,
            type: dayDelta > 0 ? 'income' : 'expense',
            amount: new Prisma.Decimal(Math.abs(dayDelta)),
            // 系统账单：服务端无法加密，noteCipher 存 UTF-8 明文，noteDekVer=0 让客户端按明文显示
            noteCipher: Buffer.from(`${displayName} 当日盈亏`, 'utf8'),
            noteDekVer: 0,
            date: now,
            source: STOCK_PAPER_SOURCE,
            // 纸面盈亏是普通收支账单（有真实分类/图标/备注），
            // 不计入收支统计靠各聚合点排除 source='stock' 实现，而不是误用 isTransfer
            isTransfer: false,
          },
        });
      }
      // 余额更新为最新市值（按市值变化增减；盈→增，亏→减）
      if (Math.abs(mvDelta) >= 0.01) {
        await tx.account.update({
          where: { id: h.accountId },
          data: { balance: { increment: new Prisma.Decimal(mvDelta) } },
        });
      }
      await tx.stockHolding.update({
        where: { id: h.id },
        data: { lastPrice: price, lastCalcAt: now },
      });
    });
    this.logger.log(
      `${h.symbol} 当日${dayDelta > 0 ? '收益' : '亏损'} ${Math.abs(dayDelta).toFixed(2)}（市值变化 ${mvDelta.toFixed(2)}）→ 账户 ${h.accountId}`,
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
}
