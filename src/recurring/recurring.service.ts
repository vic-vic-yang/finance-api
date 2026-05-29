import {
  Injectable, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';
import { CreateRecurringDto } from './dto/create-recurring.dto';
import { UpdateRecurringDto } from './dto/update-recurring.dto';

/**
 * 周期账单。
 *
 * 两个能力：
 *   1. 候选检测（GET /candidates）：从历史账单里聚类找疑似周期消费，不入库
 *   2. CRUD：用户确认/手动维护的周期账单
 *
 * 候选检测算法（纯 SQL + 内存聚类，无 LLM）：
 *   - 取最近 6 个月、type=expense 的所有账单（不看 note，note 是密文）
 *   - 按 (categoryId, accountId, 金额取整) 分组，金额允许 ±5% 浮动
 *   - 组内笔数 ≥ 3 + 时间间隔标准差 ≤ 2 天 → 候选
 *   - 排除已确认的周期账单（同 categoryId + accountId + 金额 ±5%）
 */
@Injectable()
export class RecurringService {
  constructor(
    private prisma: PrismaService,
    private ledgers: LedgersService,
  ) {}

  // ── 候选检测 ────────────────────────────────────────────────

  async candidates(userId: string, ledgerId: string) {
    await this.ledgers.ensureMembership(userId, ledgerId);

    const sinceDate = new Date();
    sinceDate.setMonth(sinceDate.getMonth() - 6);

    const bills = await this.prisma.bill.findMany({
      where: {
        ledgerId,
        type: 'expense',
        date: { gte: sinceDate },
      },
      select: {
        id: true,
        amount: true,
        date: true,
        categoryId: true,
        accountId: true,
      },
      orderBy: { date: 'asc' },
    });

    // 按 (categoryId, accountId, 金额桶) 分组；金额桶 = 金额取整到 ±5%
    type B = (typeof bills)[number];
    const groups = new Map<string, B[]>();
    for (const b of bills) {
      const amt = Number(b.amount);
      // 桶宽：金额的 5% 或 0.5 取大，保证 5 元±0.25 → 5；100±5 → 100
      const bucketStep = Math.max(amt * 0.05, 0.5);
      const bucket = Math.round(amt / bucketStep);
      const key = `${b.categoryId}|${b.accountId}|${bucket}|${bucketStep.toFixed(2)}`;
      const arr = groups.get(key) ?? [];
      arr.push(b);
      groups.set(key, arr);
    }

    // 已确认的周期账单：用于过滤已成立的（不再当候选推）
    const existing = await this.prisma.recurringBill.findMany({
      where: { ledgerId, isActive: true },
      select: { categoryId: true, accountId: true, amount: true },
    });

    const candidates: Array<{
      categoryId: string;
      accountId: string;
      type: 'expense';
      amount: number;
      cycleType: 'monthly';
      cycleDay: number;
      confidence: number;
      sampleCount: number;
      sampleBillIds: string[];
      avgIntervalDays: number;
      stddevDays: number;
      lastDate: string;
      nextDate: string;
    }> = [];

    for (const [, arr] of groups) {
      if (arr.length < 3) continue;

      // 算时间间隔（天）
      const intervals: number[] = [];
      for (let i = 1; i < arr.length; i++) {
        const ms = arr[i].date.getTime() - arr[i - 1].date.getTime();
        intervals.push(ms / 86_400_000);
      }
      const mean = intervals.reduce((s, x) => s + x, 0) / intervals.length;
      const variance =
        intervals.reduce((s, x) => s + (x - mean) ** 2, 0) / intervals.length;
      const stddev = Math.sqrt(variance);

      // 周期 25–35 天 ≈ 月度（最常见）
      if (mean < 25 || mean > 35) continue;
      if (stddev > 5) continue; // 太散，不是规律

      // 该组金额取中位数（更稳）
      const sortedAmts = arr
        .map((b) => Number(b.amount))
        .sort((a, b) => a - b);
      const medAmount = sortedAmts[Math.floor(sortedAmts.length / 2)];

      // 排除已有的
      const dup = existing.find(
        (e) =>
          e.categoryId === arr[0].categoryId &&
          e.accountId === arr[0].accountId &&
          Math.abs(Number(e.amount) - medAmount) / medAmount < 0.05,
      );
      if (dup) continue;

      // cycleDay = 最常出现的日期（1–31）
      const dayCounts = new Map<number, number>();
      for (const b of arr) {
        const d = b.date.getDate();
        dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
      }
      const cycleDay = Array.from(dayCounts.entries()).sort(
        (a, b) => b[1] - a[1],
      )[0][0];

      // 置信度：笔数越多 + σ 越小 → 越高
      let confidence = 0.5;
      if (arr.length >= 6 && stddev < 1) confidence = 0.95;
      else if (arr.length >= 4 && stddev < 2) confidence = 0.85;
      else if (arr.length >= 3 && stddev < 3) confidence = 0.7;
      else confidence = 0.6;

      const lastDate = arr[arr.length - 1].date;
      const nextDate = this._computeNext('monthly', cycleDay, lastDate);

      candidates.push({
        categoryId: arr[0].categoryId,
        accountId: arr[0].accountId,
        type: 'expense',
        amount: Math.round(medAmount * 100) / 100,
        cycleType: 'monthly',
        cycleDay,
        confidence,
        sampleCount: arr.length,
        sampleBillIds: arr.map((b) => b.id), // 客户端可拿这几个 bill 解密 note 显示
        avgIntervalDays: Math.round(mean * 10) / 10,
        stddevDays: Math.round(stddev * 10) / 10,
        lastDate: lastDate.toISOString(),
        nextDate: nextDate.toISOString(),
      });
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    return { candidates };
  }

  // ── CRUD ────────────────────────────────────────────────────

  async findAll(userId: string, ledgerId: string) {
    await this.ledgers.ensureMembership(userId, ledgerId);
    const items = await this.prisma.recurringBill.findMany({
      where: { ledgerId, isActive: true },
      orderBy: { nextDate: 'asc' },
    });
    return { recurring: items.map(this.serialize) };
  }

  async create(userId: string, ledgerId: string, dto: CreateRecurringDto) {
    await this.ledgers.ensureMembership(userId, ledgerId);

    // 校验账户在本账本 + 用户可用
    const acc = await this.prisma.account.findFirst({
      where: {
        id: dto.accountId,
        ledgerId,
        OR: [{ ownerId: null }, { ownerId: userId }],
      },
    });
    if (!acc) throw new BadRequestException('账户不存在或无权使用');

    // 校验分类
    const cat = await this.prisma.category.findFirst({
      where: {
        id: dto.categoryId,
        OR: [{ ledgerId }, { isSystem: true }],
      },
    });
    if (!cat) throw new BadRequestException('分类不存在');

    const nextDate = this._computeNext(dto.cycleType, dto.cycleDay, new Date());

    const created = await this.prisma.recurringBill.create({
      data: {
        ledgerId,
        categoryId: dto.categoryId,
        accountId: dto.accountId,
        type: dto.type ?? 'expense',
        amount: new Prisma.Decimal(dto.amount),
        noteCipher: dto.noteCipher ? Buffer.from(dto.noteCipher, 'base64') : null,
        noteDekVer: dto.noteDekVer ?? null,
        cycleType: dto.cycleType,
        cycleDay: dto.cycleDay,
        nextDate,
        isActive: dto.isActive ?? true,
        isAuto: dto.isAuto ?? false,
        confidence: dto.confidence ?? null,
      },
    });
    return { message: '创建成功', recurring: this.serialize(created) };
  }

  async update(userId: string, ledgerId: string, id: string, dto: UpdateRecurringDto) {
    await this.ledgers.ensureMembership(userId, ledgerId);
    const exist = await this.prisma.recurringBill.findFirst({
      where: { id, ledgerId },
    });
    if (!exist) throw new NotFoundException('周期账单不存在');

    const data: Prisma.RecurringBillUpdateInput = {};
    if (dto.categoryId !== undefined) data.category = { connect: { id: dto.categoryId } };
    if (dto.accountId !== undefined) data.account = { connect: { id: dto.accountId } };
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.amount !== undefined) data.amount = new Prisma.Decimal(dto.amount);
    if (dto.noteCipher !== undefined) {
      data.noteCipher = dto.noteCipher
        ? Buffer.from(dto.noteCipher, 'base64')
        : null;
    }
    if (dto.noteDekVer !== undefined) data.noteDekVer = dto.noteDekVer;
    if (dto.cycleType !== undefined) data.cycleType = dto.cycleType;
    if (dto.cycleDay !== undefined) data.cycleDay = dto.cycleDay;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    // 任何 cycleType / cycleDay 变化都重算 nextDate
    if (dto.cycleType !== undefined || dto.cycleDay !== undefined) {
      data.nextDate = this._computeNext(
        dto.cycleType ?? exist.cycleType as any,
        dto.cycleDay ?? exist.cycleDay,
        new Date(),
      );
    }

    const updated = await this.prisma.recurringBill.update({
      where: { id },
      data,
    });
    return { message: '更新成功', recurring: this.serialize(updated) };
  }

  async remove(userId: string, ledgerId: string, id: string) {
    await this.ledgers.ensureMembership(userId, ledgerId);
    const exist = await this.prisma.recurringBill.findFirst({
      where: { id, ledgerId },
    });
    if (!exist) throw new NotFoundException('周期账单不存在');
    await this.prisma.recurringBill.delete({ where: { id } });
    return { message: '删除成功' };
  }

  // ── 工具 ────────────────────────────────────────────────────

  /** 算下次触发日期：从 from 之后第一个匹配 cycleDay 的时间点 */
  private _computeNext(
    cycleType: 'monthly' | 'weekly' | 'yearly' | string,
    cycleDay: number,
    from: Date,
  ): Date {
    const now = new Date(from);
    if (cycleType === 'weekly') {
      // cycleDay: 1=周一 ... 7=周日
      const today = now.getDay() || 7; // JS 周日=0 → 7
      let delta = cycleDay - today;
      if (delta <= 0) delta += 7;
      const next = new Date(now);
      next.setDate(now.getDate() + delta);
      next.setHours(9, 0, 0, 0);
      return next;
    }
    if (cycleType === 'yearly') {
      // cycleDay: mmdd（如 0815 → 815）
      const mm = Math.floor(cycleDay / 100);
      const dd = cycleDay % 100;
      const thisYear = new Date(now.getFullYear(), mm - 1, dd, 9, 0, 0);
      if (thisYear.getTime() > now.getTime()) return thisYear;
      return new Date(now.getFullYear() + 1, mm - 1, dd, 9, 0, 0);
    }
    // monthly: 这个月的 cycleDay 还没到 → 这个月；否则下个月
    // 若 cycleDay > 当月天数（如 31 在 2 月）→ 取当月最后一天
    const tryMonth = (y: number, m: number) => {
      const lastDay = new Date(y, m + 1, 0).getDate();
      const day = Math.min(cycleDay, lastDay);
      return new Date(y, m, day, 9, 0, 0);
    };
    const thisMonth = tryMonth(now.getFullYear(), now.getMonth());
    if (thisMonth.getTime() > now.getTime()) return thisMonth;
    return tryMonth(now.getFullYear(), now.getMonth() + 1);
  }

  private serialize = (r: any) => ({
    id: r.id,
    ledgerId: r.ledgerId,
    categoryId: r.categoryId,
    accountId: r.accountId,
    type: r.type,
    amount: Number(r.amount),
    noteCipher: r.noteCipher
      ? Buffer.from(r.noteCipher).toString('base64')
      : null,
    noteDekVer: r.noteDekVer,
    cycleType: r.cycleType,
    cycleDay: r.cycleDay,
    nextDate: r.nextDate,
    isActive: r.isActive,
    isAuto: r.isAuto,
    confidence: r.confidence,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}
