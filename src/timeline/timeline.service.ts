import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';
import { mergeTimeline, TimelineEvent } from './timeline-merge';

/**
 * 财务事件时间线（GET /api/timeline）
 *
 * 把账单（含余额校准）、CFO 提案、通知、储蓄目标进展统一成一条可解释事件流。
 * 隐私不变式：备注/目标名以密文透传（base64），由客户端用账本 DEK 解密。
 */
@Injectable()
export class TimelineService {
  constructor(
    private prisma: PrismaService,
    private ledgers: LedgersService,
  ) {}

  async getTimeline(userId: string, ledgerId: string, limit?: number) {
    await this.ledgers.ensureMembership(userId, ledgerId);
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);

    const [bills, proposals, notifications, goals] = await Promise.all([
      this.prisma.bill.findMany({
        where: { ledgerId },
        orderBy: { date: 'desc' },
        take: n,
        select: {
          id: true, accountId: true, categoryId: true, type: true,
          amount: true, date: true, isTransfer: true, source: true,
          noteCipher: true, noteDekVer: true,
        },
      }),
      this.prisma.proposal.findMany({
        where: { ledgerId },
        orderBy: { createdAt: 'desc' },
        take: n,
        select: { id: true, type: true, severity: true, title: true, status: true, createdAt: true, decidedAt: true },
      }),
      // 通知是用户级：只取本账本相关 + 系统级（ledgerId=null）
      this.prisma.notification.findMany({
        where: { userId, OR: [{ ledgerId }, { ledgerId: null }] },
        orderBy: { createdAt: 'desc' },
        take: n,
        select: { id: true, type: true, title: true, body: true, readAt: true, createdAt: true },
      }),
      this.prisma.savingsGoal.findMany({
        where: { ledgerId },
        orderBy: { createdAt: 'desc' },
        take: n,
        select: { id: true, nameCipher: true, nameDekVer: true, targetAmount: true, isCompleted: true, completedAt: true, createdAt: true },
      }),
    ]);

    const b64 = (buf: unknown) => (buf ? Buffer.from(buf as any).toString('base64') : null);
    const events: TimelineEvent[] = [];

    for (const b of bills) {
      // source='reconcile' 是余额校准审计账单 → 单独作为「余额变化」事件
      events.push({
        kind: b.source === 'reconcile' ? 'balance_change' : 'bill',
        at: b.date,
        id: 'bill:' + b.id,
        data: {
          billId: b.id, accountId: b.accountId, categoryId: b.categoryId,
          type: b.type, amount: Number(b.amount), isTransfer: b.isTransfer,
          source: b.source, noteCipher: b64(b.noteCipher), noteDekVer: b.noteDekVer,
        },
      });
    }
    for (const p of proposals) {
      events.push({
        kind: 'proposal', at: p.createdAt, id: 'proposal:' + p.id,
        data: { proposalId: p.id, type: p.type, severity: p.severity, title: p.title, status: p.status, decidedAt: p.decidedAt?.toISOString() ?? null },
      });
    }
    for (const n of notifications) {
      events.push({
        kind: 'notification', at: n.createdAt, id: 'notification:' + n.id,
        data: { notificationId: n.id, type: n.type, title: n.title, body: n.body, readAt: n.readAt?.toISOString() ?? null },
      });
    }
    for (const g of goals) {
      events.push({
        kind: 'goal_created', at: g.createdAt, id: 'goal:created:' + g.id,
        data: { goalId: g.id, nameCipher: b64(g.nameCipher), nameDekVer: g.nameDekVer, targetAmount: Number(g.targetAmount) },
      });
      if (g.isCompleted && g.completedAt) {
        events.push({
          kind: 'goal_completed', at: g.completedAt, id: 'goal:completed:' + g.id,
          data: { goalId: g.id, nameCipher: b64(g.nameCipher), nameDekVer: g.nameDekVer, targetAmount: Number(g.targetAmount) },
        });
      }
    }

    const merged = mergeTimeline(events, n);
    return {
      events: merged.map((e) => ({ kind: e.kind, at: e.at.toISOString(), id: e.id, ...e.data })),
    };
  }
}
