import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueryNotificationDto } from './dto/query-notification.dto';

/** 通知中心：用户级通知的查询 / 已读管理 + 供扫描任务写入。
 *  数据作用域 = 当前用户（req.user.id），与账本无关；写操作均校验归属。 */
@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  /** GET /notifications —— 分页，未读在前（readAt 为 null 排前），同状态按时间倒序 */
  async list(userId: string, q: QueryNotificationDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const where = { userId };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.notification.count({ where }),
      this.prisma.notification.findMany({
        where,
        orderBy: [
          // PostgreSQL 里 NULL 视为最大值，ASC 默认 NULLS LAST，需显式 nulls first 让未读排前
          { readAt: { sort: 'asc', nulls: 'first' } },
          { createdAt: 'desc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      items: items.map((n) => this.serialize(n)),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  /** GET /notifications/unread-count */
  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return { count };
  }

  /** PATCH /notifications/:id/read —— 幂等：已读的直接返回 */
  async markRead(userId: string, id: string) {
    const n = await this.prisma.notification.findFirst({
      where: { id, userId },
    });
    if (!n) throw new NotFoundException('通知不存在');
    if (n.readAt) return this.serialize(n);
    const updated = await this.prisma.notification.update({
      where: { id: n.id },
      data: { readAt: new Date() },
    });
    return this.serialize(updated);
  }

  /** POST /notifications/read-all */
  async markAllRead(userId: string) {
    const res = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }

  /** 供主动扫描任务写入 CFO 预警通知。
   *  同一 (userId, type='cfo_proposal', payload.dedupeKey) 只通知一次；
   *  返回是否新建。 */
  async createFromProposalOnce(
    userId: string,
    ledgerId: string,
    p: { id: string; dedupeKey: string; severity: string; title: string; body: string; type: string },
  ) {
    const existing = await this.prisma.notification.findFirst({
      where: {
        userId,
        type: 'cfo_proposal',
        payload: { path: ['dedupeKey'], equals: p.dedupeKey },
      },
      select: { id: true },
    });
    if (existing) return false;
    await this.prisma.notification.create({
      data: {
        userId,
        ledgerId,
        type: 'cfo_proposal',
        title: p.title,
        body: p.body,
        payload: {
          dedupeKey: p.dedupeKey,
          proposalId: p.id,
          severity: p.severity,
          detectorType: p.type,
        },
      },
    });
    return true;
  }

  /** 供周报调度器写入简报通知。
   *  同一 briefingId 只通知一次（调度器重跑幂等）；返回是否新建。 */
  async createBriefingOnce(
    userId: string,
    ledgerId: string,
    briefing: { id: string; narrative: string; weekStart: Date },
  ) {
    const existing = await this.prisma.notification.findFirst({
      where: {
        userId,
        type: 'briefing',
        payload: { path: ['briefingId'], equals: briefing.id },
      },
      select: { id: true },
    });
    if (existing) return false;
    await this.prisma.notification.create({
      data: {
        userId,
        ledgerId,
        type: 'briefing',
        title: '📋 你的上周财务简报到了',
        body: firstSentence(briefing.narrative),
        payload: {
          briefingId: briefing.id,
          weekStart: briefing.weekStart.toISOString(),
        },
      },
    });
    return true;
  }

  private serialize = (n: any) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    ledgerId: n.ledgerId,
    payload: n.payload,
    readAt: n.readAt,
    createdAt: n.createdAt,
  });
}

/** 取简报正文首句做通知 body（截断 80 字） */
function firstSentence(narrative: string): string {
  const s = (narrative ?? '').split(/[。！？!?\n]/).find((x) => x.trim().length > 0) ?? '';
  const t = s.trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}
