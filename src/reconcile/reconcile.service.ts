import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';
import {
  RcBill,
  ReconcileSeverity,
  checkBalanceDrift,
  checkRecurringMissing,
  checkSuspectedDuplicates,
  checkTransferOrphans,
  worstSeverity,
} from './checks';

/** 对账报告的区块（前端按 key 渲染对应条目结构） */
export interface ReconcileSection {
  key: 'balanceDrift' | 'suspectedDuplicates' | 'recurringMissing' | 'transferOrphans';
  title: string;
  severity: ReconcileSeverity;
  count: number;
  items: any[];
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** 重复检测前溯 4 天（与窗口一致）；转账配对前/后各放宽 2 天 */
const LOOKBACK_DAYS = 4;
const FORWARD_DAYS = 2;

/**
 * 对账中心：对某个月做四项内部一致性检查（只读报告，不做修复）。
 *
 * 数据范围：
 *  - 余额一致性 / 缺腿 / 周期缺记只覆盖当前用户可见账户（共享 + 本人私人），
 *    他人私人账户的余额校准无法由本用户完成，故排除。
 *  - 疑似重复检查扩到全账本账户：共享账本里同一笔消费可能被不同成员
 *    在各自账户各记一次（各自导入流水），只有跨账户比对能发现。
 *  - 账户名 / 备注密文原样返回（base64），客户端用账本 DEK 解密展示。
 */
@Injectable()
export class ReconcileService {
  constructor(
    private prisma: PrismaService,
    private ledgers: LedgersService,
  ) {}

  async report(userId: string, ledgerId: string, month?: string) {
    await this.ledgers.ensureMembership(userId, ledgerId);

    const { key, start, end } = this._parseMonth(month);
    const now = new Date();
    // 历史月份 asOf = 月末；当前月份 asOf = 现在（周期项只报"已过期"的）
    const asOf = end.getTime() < now.getTime() ? end : now;

    // ── 数据加载 ─────────────────────────────────────────────
    // 余额 / 缺腿 / 周期检查只覆盖当前用户可见账户（共享 + 本人私人）；
    // 疑似重复检查扩到全账本账户——共享账本里同一笔消费可能被不同成员
    // 在各自账户各记一次，只有跨账户比对才能发现。
    const allAccounts = await this.prisma.account.findMany({
      where: { ledgerId },
      select: {
        id: true, ownerId: true, nameCipher: true, nameDekVer: true, type: true,
        icon: true, initialBalance: true, balance: true,
      },
    });
    const accounts = allAccounts.filter(
      (a) => a.ownerId == null || a.ownerId === userId,
    );
    const accountIds = accounts.map((a) => a.id);
    const allAccountIds = allAccounts.map((a) => a.id);
    if (accountIds.length === 0) {
      return { month: key, generatedAt: now, sections: [] };
    }

    const winStart = new Date(start.getTime() - LOOKBACK_DAYS * 86_400_000);
    const winEnd = new Date(end.getTime() + FORWARD_DAYS * 86_400_000);

    const [nonStockAgg, stockAgg, windowBills, recurring, categories] =
      await Promise.all([
        // 全历史非股票流水净额（余额恒等式用；转账双腿天然各记一收一支）。
        // 排除 paper stock（改余额但恒等式不算）与 stock_close（计入收支但不改余额）。
        this.prisma.bill.groupBy({
          by: ['accountId', 'type'],
          where: {
            ledgerId,
            accountId: { in: accountIds },
            source: { notIn: ['stock', 'stock_close'] },
          },
          _sum: { amount: true },
        }),
        // stock / stock_close 净额（仅用于"偏差可能来自股票记账"提示）
        this.prisma.bill.groupBy({
          by: ['accountId', 'type'],
          where: {
            ledgerId,
            accountId: { in: accountIds },
            source: { in: ['stock', 'stock_close'] },
          },
          _sum: { amount: true },
        }),
        // 月窗账单（重复 / 缺腿 / 周期匹配用），含密文摘要字段
        this.prisma.bill.findMany({
          where: {
            ledgerId,
            accountId: { in: allAccountIds },
            date: { gte: winStart, lte: winEnd },
          },
          select: {
            id: true, accountId: true, categoryId: true, type: true,
            amount: true, date: true, isTransfer: true, source: true,
            bankBalance: true,
            externalId: true,
            noteCipher: true, noteDekVer: true,
          },
        }),
        this.prisma.recurringBill.findMany({
          where: {
            ledgerId,
            isActive: true,
            isAuto: false, // AI 候选未确认，不报缺记
            accountId: { in: accountIds },
          },
          select: {
            id: true, accountId: true, categoryId: true, type: true,
            amount: true, nextDate: true, cycleType: true, cycleDay: true,
          },
        }),
        this.prisma.category.findMany({
          where: { OR: [{ ledgerId }, { isSystem: true }] },
          select: { id: true, parentId: true, name: true, icon: true },
        }),
      ]);

    // ── 纯函数检查 ───────────────────────────────────────────
    const toNet = (agg: typeof nonStockAgg) => {
      const m = new Map<string, Prisma.Decimal>();
      for (const row of agg) {
        const sum = row._sum.amount ?? new Prisma.Decimal(0);
        const signed = row.type === 'income' ? sum : sum.neg();
        m.set(row.accountId, (m.get(row.accountId) ?? new Prisma.Decimal(0)).add(signed));
      }
      return m;
    };

    const visibleAccountIds = new Set(accountIds);
    const toRc = (b: (typeof windowBills)[number]): RcBill => ({
      id: b.id,
      accountId: b.accountId,
      categoryId: b.categoryId,
      type: b.type,
      amount: b.amount,
      date: b.date,
      isTransfer: b.isTransfer,
      source: b.source,
      bankBalance: b.bankBalance,
      externalId: b.externalId,
    });
    // 缺腿 / 周期匹配只用可见账户的账单；重复检查用全账本账单
    const rcBills: RcBill[] = windowBills
      .filter((b) => visibleAccountIds.has(b.accountId))
      .map(toRc);
    const rcAllBills: RcBill[] = windowBills.map(toRc);

    const drifts = checkBalanceDrift(accounts, toNet(nonStockAgg), toNet(stockAgg));
    const dups = checkSuspectedDuplicates(rcAllBills, start, end);
    const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
    const missing = checkRecurringMissing(
      recurring.map((r) => ({
        id: r.id, accountId: r.accountId, categoryId: r.categoryId,
        type: r.type, amount: r.amount, nextDate: r.nextDate,
      })),
      rcBills,
      parentOf,
      start,
      end,
      asOf,
    );
    const orphans = checkTransferOrphans(rcBills, start, end);

    // ── 序列化 ───────────────────────────────────────────────
    // 账户名映射覆盖全账本账户：跨账户重复对的另一腿可能属于其他成员
    const accById = new Map(allAccounts.map((a) => [a.id, a]));
    const billById = new Map(windowBills.map((b) => [b.id, b]));
    const catById = new Map(categories.map((c) => [c.id, c]));
    const num = (d: Prisma.Decimal) => Number(d.toFixed(2));
    const b64 = (buf: Buffer | Uint8Array | null | undefined) =>
      buf ? Buffer.from(buf).toString('base64') : null;

    /** 账户展示上下文（密文原样，客户端 DEK 解） */
    const accCtx = (accountId: string) => {
      const a = accById.get(accountId);
      return {
        accountId,
        accountNameCipher: a ? b64(a.nameCipher as any) : null,
        accountNameDekVer: a?.nameDekVer ?? 1,
        accountIcon: a?.icon ?? null,
        accountType: a?.type ?? null,
      };
    };
    const billRef = (id: string) => {
      const b = billById.get(id);
      return {
        id,
        date: b?.date ?? null,
        noteCipher: b ? b64(b.noteCipher as any) : null,
        noteDekVer: b?.noteDekVer ?? 1,
        // 每条腿带自己的账户上下文：跨账户对要能显示两个账户名
        ...(b ? accCtx(b.accountId) : {}),
      };
    };

    const driftItems = drifts.map((d) => ({
      ...accCtx(d.accountId),
      initialBalance: num(d.initialBalance),
      flowNet: num(d.flowNet),
      expected: num(d.expected),
      actual: num(d.actual),
      drift: num(d.drift),
      hasStock: d.hasStock,
      severity: d.severity,
    }));

    const dupItems = dups.map((d) => ({
      ...accCtx(d.accountId),
      type: d.type,
      amount: num(d.amount),
      gapDays: d.gapDays,
      crossAccount: d.crossAccount ?? false,
      bills: [billRef(d.first.id), billRef(d.second.id)],
      severity: d.severity,
    }));

    const missingItems = missing.map((m) => {
      const cat = catById.get(m.categoryId);
      const rec = recurring.find((r) => r.id === m.recurringId);
      return {
        recurringId: m.recurringId,
        dueDate: m.dueDate,
        type: m.type,
        amount: num(m.amount),
        categoryId: m.categoryId,
        categoryName: cat?.name ?? '未分类',
        categoryIcon: cat?.icon ?? null,
        cycleType: rec?.cycleType ?? null,
        cycleDay: rec?.cycleDay ?? null,
        ...accCtx(m.accountId),
        severity: m.severity,
      };
    });

    const orphanItems = orphans.map((o) => ({
      billId: o.id,
      date: o.date,
      type: o.type,
      amount: num(new Prisma.Decimal(o.amount)),
      noteCipher: b64(billById.get(o.id)?.noteCipher as any),
      noteDekVer: billById.get(o.id)?.noteDekVer ?? 1,
      ...accCtx(o.accountId),
      severity: 'warning' as const,
    }));

    const sections: ReconcileSection[] = [
      {
        key: 'balanceDrift',
        title: '余额一致性',
        severity: worstSeverity(drifts),
        count: driftItems.length,
        items: driftItems,
      },
      {
        key: 'suspectedDuplicates',
        title: '疑似重复账单',
        severity: worstSeverity(dups),
        count: dupItems.length,
        items: dupItems,
      },
      {
        key: 'recurringMissing',
        title: '周期账单缺记',
        severity: worstSeverity(missing),
        count: missingItems.length,
        items: missingItems,
      },
      {
        key: 'transferOrphans',
        title: '转账缺腿',
        severity: worstSeverity(orphans.map(() => ({ severity: 'warning' as const }))),
        count: orphanItems.length,
        items: orphanItems,
      },
    ];

    return { month: key, generatedAt: now, sections };
  }

  /** month=YYYY-MM（缺省 = 当前月）；月界按服务器本地时区，与 insights/budgets 一致 */
  private _parseMonth(month?: string): { key: string; start: Date; end: Date } {
    let y: number;
    let m: number; // 0-based
    if (month === undefined || month === '') {
      const now = new Date();
      y = now.getFullYear();
      m = now.getMonth();
    } else {
      if (!MONTH_RE.test(month)) {
        throw new BadRequestException('month 格式应为 YYYY-MM，如 2025-06');
      }
      y = Number(month.slice(0, 4));
      m = Number(month.slice(5, 7)) - 1;
    }
    const start = new Date(y, m, 1, 0, 0, 0, 0);
    const end = new Date(y, m + 1, 0, 23, 59, 59, 999);
    const key = `${y}-${String(m + 1).padStart(2, '0')}`;
    return { key, start, end };
  }
}
