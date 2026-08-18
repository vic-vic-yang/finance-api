import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';
import { GoalsService } from '../goals/goals.service';
import { assembleFamilyReview } from './family-review.facts';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 月度家庭复盘（GET /api/family/review?month=YYYY-MM）
 *
 * 账本级、跨成员的月度聚合：全家收支、各成员贡献、预算超支、目标进展、Top 支出分类。
 * 隐私不变式：只读明文字段；目标名以密文透传由前端解密，本层绝不解密。
 */
@Injectable()
export class FamilyReviewService {
  constructor(
    private prisma: PrismaService,
    private ledgers: LedgersService,
    private goals: GoalsService,
  ) {}

  async review(userId: string, ledgerId: string, month?: string) {
    await this.ledgers.ensureMembership(userId, ledgerId);
    const { key, start, end } = this._parseMonth(month);

    const [bills, budgets, categories, goalsRes, membersRes] = await Promise.all([
      this.prisma.bill.findMany({
        where: { ledgerId, date: { gte: start, lte: end } },
        select: {
          id: true, userId: true, type: true, amount: true, categoryId: true,
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
      this.goals.findAll(userId, ledgerId),
      this.ledgers.listMembers(userId, ledgerId),
    ]);

    const facts = assembleFamilyReview({
      monthStart: start,
      monthEnd: end,
      bills,
      budgets,
      categories,
      goals: (goalsRes.goals ?? []).map((g: any) => ({
        id: g.id,
        targetAmount: Number(g.targetAmount ?? 0),
        currentSaved: Number(g.currentSaved ?? 0),
        progress: Number(g.progress ?? 0),
        isCompleted: !!g.isCompleted,
      })),
      members: (membersRes.members ?? []).map((m: any) => ({
        id: m.userId,
        name: m.displayName ?? m.username ?? '成员',
      })),
    });

    return {
      ...facts,
      // 覆盖 goals：加入密文字段供前端解密显示目标名
      goals: (goalsRes.goals ?? []).map((g: any) => ({
        id: g.id,
        nameCipher: g.nameCipher ?? null,
        nameDekVer: g.nameDekVer ?? 1,
        icon: g.icon ?? null,
        color: g.color ?? null,
        targetAmount: Number(g.targetAmount ?? 0),
        currentSaved: Number(g.currentSaved ?? 0),
        progress: Number(g.progress ?? 0),
        isCompleted: !!g.isCompleted,
      })),
      generatedAt: new Date(),
    };
  }

  private _parseMonth(month?: string) {
    let y: number;
    let m: number;
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
    const key = y + '-' + String(m + 1).padStart(2, '0');
    return { key, start, end };
  }
}
