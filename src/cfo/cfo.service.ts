import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BudgetsService } from '../budgets/budgets.service';
import { GoalsService } from '../goals/goals.service';
import { DetectorInput, DetectorBill, ProposalDraft } from './detectors/types';
import { detectRecategorizeOther } from './detectors/recategorize-other';
import { detectLargeExpense } from './detectors/large-expense';
import { detectOverspend } from './detectors/overspend';
import { detectIdleToGoal } from './detectors/idle-to-goal';
import { detectDuplicate } from './detectors/duplicate';

const DETECTORS = [
  detectRecategorizeOther,
  detectLargeExpense,
  detectOverspend,
  detectIdleToGoal,
  detectDuplicate,
];

@Injectable()
export class CfoService {
  constructor(
    private prisma: PrismaService,
    private budgets: BudgetsService,
    private goals: GoalsService,
  ) {}

  /** GET /cfo/proposals —— 惰性生成 + 返回 pending */
  async listAndGenerate(ledgerId: string, userId: string) {
    const input = await this.buildInput(ledgerId, userId);
    const muted = await this.mutedTypes(ledgerId, input.now);

    const drafts: ProposalDraft[] = [];
    for (const d of DETECTORS) drafts.push(...d(input));

    for (const draft of drafts) {
      if (muted.has(draft.type)) continue;
      // 按 dedupeKey 跳过任何已存在项(含已决定)
      const exists = await this.prisma.proposal.findUnique({
        where: { ledgerId_dedupeKey: { ledgerId, dedupeKey: draft.dedupeKey } },
      });
      if (exists) continue;
      await this.prisma.proposal.create({
        data: {
          ledgerId,
          type: draft.type,
          severity: draft.severity,
          title: draft.title,
          body: draft.body,
          actionKind: draft.actionKind,
          actionParams: (draft.actionParams ?? undefined) as any,
          requiresClient: draft.requiresClient,
          evidenceRefs: (draft.evidenceRefs ?? undefined) as any,
          dedupeKey: draft.dedupeKey,
        },
      });
    }

    const pending = await this.prisma.proposal.findMany({
      where: { ledgerId, status: 'pending', type: { not: 'chat_action' } },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
    });
    return pending.map((p) => this.serialize(p));
  }

  private async mutedTypes(ledgerId: string, now: Date): Promise<Set<string>> {
    const fb = await this.prisma.proposalFeedback.findMany({
      where: { ledgerId, mutedUntil: { gt: now } },
      select: { type: true },
    });
    return new Set(fb.map((f) => f.type));
  }

  private serialize = (p: any) => ({
    id: p.id,
    type: p.type,
    status: p.status,
    severity: p.severity,
    title: p.title,
    body: p.body,
    actionKind: p.actionKind,
    actionParams: p.actionParams,
    requiresClient: p.requiresClient,
    createdAt: p.createdAt,
  });

  /** 把明文数据查出来喂给 detector。绝不读取任何加密 note/name 字段。 */
  private async buildInput(ledgerId: string, userId: string): Promise<DetectorInput> {
    const now = new Date();
    const periodKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const since90 = new Date(now);
    since90.setDate(since90.getDate() - 90);

    // 仅取明文字段：绝不 select noteCipher
    const rawRecent = await this.prisma.bill.findMany({
      where: { ledgerId, date: { gte: since90 } },
      select: {
        id: true,
        accountId: true,
        categoryId: true,
        type: true,
        amount: true,
        date: true,
        externalId: true,
        isTransfer: true,
        category: { select: { name: true } },
      },
    });
    const toBill = (b: any): DetectorBill => ({
      id: b.id,
      accountId: b.accountId,
      categoryId: b.categoryId,
      categoryName: b.category?.name ?? '其他',
      type: b.type,
      amount: Number(b.amount),
      date: b.date,
      externalId: b.externalId,
      isTransfer: b.isTransfer,
    });
    const recentBills = rawRecent.map(toBill);
    const bills = recentBills.filter((b) => b.date >= monthStart);

    const rawAcc = await this.prisma.account.findMany({
      where: { ledgerId },
      select: { id: true, type: true, balance: true },
    });
    const accounts = rawAcc.map((a) => ({
      id: a.id,
      accountType: a.type,
      balance: Number(a.balance),
    }));

    // 复用 budgets service 的"已用"口径。findAll 返回 { budgets: [...] }，
    // 每条含 id / categoryId / category(关系) / period / amount(Number) / spent(Number)。
    const budgetRes = await this.budgets.findAll(ledgerId);
    const budgets = (budgetRes.budgets ?? [])
      .filter((b: any) => b.categoryId)
      .map((b: any) => ({
        id: b.id,
        categoryId: b.categoryId,
        categoryName: b.category?.name ?? '',
        period: b.period,
        limit: Number(b.amount),
        spent: Number(b.spent ?? 0),
      }));

    // 复用 goals service 的进度口径。findAll 返回 { goals: [...] }，
    // 每条含 id / accountId / targetAmount(Number) / currentSaved(Number)。
    const goalRes = await this.goals.findAll(userId, ledgerId);
    const goals = (goalRes.goals ?? []).map((g: any) => ({
      id: g.id,
      accountId: g.accountId ?? null,
      target: Number(g.targetAmount ?? 0),
      saved: Number(g.currentSaved ?? 0),
    }));

    // 近月各账户支出合计 + 距上次流出天数
    const recentExpenseByAccount: Record<string, number> = {};
    const lastOutflow: Record<string, number> = {};
    for (const b of recentBills) {
      if (b.type !== 'expense' || b.isTransfer) continue;
      if (b.date >= monthStart) {
        recentExpenseByAccount[b.accountId] =
          (recentExpenseByAccount[b.accountId] ?? 0) + b.amount;
      }
      const days = Math.floor((now.getTime() - b.date.getTime()) / 86400000);
      if (lastOutflow[b.accountId] === undefined || days < lastOutflow[b.accountId]) {
        lastOutflow[b.accountId] = days;
      }
    }
    const lastOutflowDays: Record<string, number> = {};
    for (const a of accounts) lastOutflowDays[a.id] = lastOutflow[a.id] ?? 9999;

    return {
      periodKey,
      now,
      bills,
      recentBills,
      accounts,
      budgets,
      goals,
      recentExpenseByAccount,
      lastOutflowDays,
    };
  }

  /** 对话动作：agent 在聊天里提议一个写操作 → 建一条待确认 Proposal，返回给聊天出卡 */
  async createChatAction(
    ledgerId: string,
    a: {
      actionKind: string;
      actionParams: Record<string, unknown>;
      title: string;
      body: string;
      requiresClient: boolean;
      severity?: string;
    },
  ) {
    const p = await this.prisma.proposal.create({
      data: {
        ledgerId,
        type: 'chat_action',
        status: 'pending',
        severity: a.severity ?? 'info',
        title: a.title,
        body: a.body,
        actionKind: a.actionKind,
        actionParams: a.actionParams as any,
        requiresClient: a.requiresClient,
        evidenceRefs: undefined,
        // 对话动作是临时的、不该被去重合并 → dedupeKey 必须唯一
        dedupeKey: `chat:${Date.now()}:${Math.round(Math.random() * 1e9)}`,
      },
    });
    return this.serialize(p);
  }

  /** POST /cfo/proposals/:id/decide */
  async decide(
    ledgerId: string,
    userId: string,
    id: string,
    action: 'approve' | 'dismiss' | 'snooze' | 'resolve',
  ) {
    const p = await this.prisma.proposal.findFirst({ where: { id, ledgerId } });
    if (!p) throw new NotFoundException('建议不存在');

    if (action === 'dismiss') {
      await this.bumpFeedback(ledgerId, p.type, 'dismissed');
      return this.finish(id, 'dismissed');
    }
    if (action === 'snooze') return this.finish(id, 'snoozed');
    if (action === 'resolve') {
      // 客户端协助动作完成后回调
      await this.bumpFeedback(ledgerId, p.type, 'approved');
      return this.finish(id, 'done');
    }
    // approve —— 服务端可执行的动作在此跑；requiresClient 的交给客户端，自己只置 approved
    if (p.requiresClient) {
      await this.bumpFeedback(ledgerId, p.type, 'approved');
      return this.finish(id, 'approved'); // 等客户端 resolve
    }
    await this.execute(ledgerId, p);
    await this.bumpFeedback(ledgerId, p.type, 'approved');
    return this.finish(id, 'done');
  }

  private async execute(ledgerId: string, p: any) {
    const params = (p.actionParams ?? {}) as any;
    if (p.actionKind === 'acknowledge') return; // 仅确认，无副作用
    if (p.actionKind === 'adjust_budget') {
      const newLimit = new Prisma.Decimal(String(params.newLimit));
      if (params.budgetId) {
        const exist = await this.prisma.budget.findFirst({
          where: { id: params.budgetId as string, ledgerId },
        });
        if (!exist) throw new BadRequestException('预算已变更');
        await this.prisma.budget.update({
          where: { id: exist.id },
          data: { amount: newLimit },
        });
        return;
      }
      // 没有 budgetId → 按分类+周期 upsert
      const categoryId = params.categoryId as string | undefined;
      const period = (params.period as string) || 'MONTHLY';
      if (!categoryId) throw new BadRequestException('缺少分类');
      const found = await this.prisma.budget.findFirst({
        where: { ledgerId, categoryId, period: period as any },
      });
      if (found) {
        await this.prisma.budget.update({
          where: { id: found.id },
          data: { amount: newLimit },
        });
      } else {
        await this.prisma.budget.create({
          data: {
            ledgerId,
            categoryId,
            period: period as any,
            amount: newLimit,
            startDate: new Date(),
          },
        });
      }
      return;
    }
    if (p.actionKind === 'delete_bill') {
      const bill = await this.prisma.bill.findFirst({
        where: { id: params.billId, ledgerId },
      });
      if (!bill) throw new BadRequestException('账单已不存在');
      await this.prisma.$transaction([
        this.prisma.bill.delete({ where: { id: bill.id } }),
        this.prisma.account.update({
          where: { id: bill.accountId },
          data: {
            balance:
              bill.type === 'income'
                ? { decrement: bill.amount }
                : { increment: bill.amount },
          },
        }),
      ]);
      return;
    }
    throw new BadRequestException(`未知动作 ${p.actionKind}`);
  }

  private finish(id: string, status: string) {
    return this.prisma.proposal
      .update({ where: { id }, data: { status, decidedAt: new Date() } })
      .then((p) => this.serialize(p));
  }

  private async bumpFeedback(
    ledgerId: string,
    type: string,
    field: 'dismissed' | 'approved',
  ) {
    const fb = await this.prisma.proposalFeedback.upsert({
      where: { ledgerId_type: { ledgerId, type } },
      create: { ledgerId, type, [field]: 1 },
      update: { [field]: { increment: 1 } },
    });
    if (field === 'dismissed' && fb.dismissed >= 3) {
      const mutedUntil = new Date();
      mutedUntil.setDate(mutedUntil.getDate() + 30);
      await this.prisma.proposalFeedback.update({
        where: { ledgerId_type: { ledgerId, type } },
        data: { mutedUntil },
      });
    }
  }
}
