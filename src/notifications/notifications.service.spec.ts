import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

/** PrismaService 纯 mock（不连库）：只覆盖通知中心的查询/去重/归属逻辑 */
const makePrisma = () => ({
  notification: {
    count: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn((promises: Promise<unknown>[]) => Promise.all(promises)),
});

describe('NotificationsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: NotificationsService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new NotificationsService(prisma as any);
  });

  describe('list', () => {
    it('未读在前（readAt nulls first）+ 时间倒序，分页参数正确', async () => {
      prisma.notification.count.mockResolvedValue(25);
      prisma.notification.findMany.mockResolvedValue([
        {
          id: 'n1', userId: 'u1', ledgerId: 'l1', type: 'cfo_proposal',
          title: 't', body: 'b', payload: null, readAt: null, createdAt: new Date(),
        },
      ]);
      const r = await svc.list('u1', { page: 2, pageSize: 20 });
      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1' },
          orderBy: [
            { readAt: { sort: 'asc', nulls: 'first' } },
            { createdAt: 'desc' },
          ],
          skip: 20,
          take: 20,
        }),
      );
      expect(r.total).toBe(25);
      expect(r.hasMore).toBe(false); // 2*20=40 >= 25
      expect(r.items).toHaveLength(1);
    });

    it('第一页且总数超出一页时 hasMore=true', async () => {
      prisma.notification.count.mockResolvedValue(21);
      prisma.notification.findMany.mockResolvedValue([]);
      const r = await svc.list('u1', { page: 1, pageSize: 20 });
      expect(r.hasMore).toBe(true);
    });
  });

  describe('unreadCount', () => {
    it('只数未读', async () => {
      prisma.notification.count.mockResolvedValue(3);
      const r = await svc.unreadCount('u1');
      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { userId: 'u1', readAt: null },
      });
      expect(r.count).toBe(3);
    });
  });

  describe('markRead', () => {
    it('通知不属于当前用户 → NotFoundException', async () => {
      prisma.notification.findFirst.mockResolvedValue(null);
      await expect(svc.markRead('u1', 'nX')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.notification.update).not.toHaveBeenCalled();
    });

    it('已读的通知幂等返回，不重复 update', async () => {
      const read = {
        id: 'n1', userId: 'u1', ledgerId: null, type: 'cfo_proposal',
        title: 't', body: 'b', payload: null,
        readAt: new Date('2026-07-01'), createdAt: new Date(),
      };
      prisma.notification.findFirst.mockResolvedValue(read);
      const r = await svc.markRead('u1', 'n1');
      expect(prisma.notification.update).not.toHaveBeenCalled();
      expect(r.id).toBe('n1');
    });

    it('未读 → 写入 readAt', async () => {
      const unread = {
        id: 'n1', userId: 'u1', ledgerId: null, type: 'cfo_proposal',
        title: 't', body: 'b', payload: null, readAt: null, createdAt: new Date(),
      };
      prisma.notification.findFirst.mockResolvedValue(unread);
      prisma.notification.update.mockResolvedValue({ ...unread, readAt: new Date() });
      const r = await svc.markRead('u1', 'n1');
      expect(prisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: { readAt: expect.any(Date) },
      });
      expect(r.readAt).not.toBeNull();
    });
  });

  describe('markAllRead', () => {
    it('只更新未读行，返回更新数', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 4 });
      const r = await svc.markAllRead('u1');
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', readAt: null },
        data: { readAt: expect.any(Date) },
      });
      expect(r.updated).toBe(4);
    });
  });

  describe('createFromProposalOnce', () => {
    const p = {
      id: 'p1', dedupeKey: 'large:2026-07:b1', severity: 'critical',
      title: '大额支出', body: '...', type: 'large_expense',
    };

    it('同 (userId, dedupeKey) 已通知过 → 跳过', async () => {
      prisma.notification.findFirst.mockResolvedValue({ id: 'n0' });
      const created = await svc.createFromProposalOnce('u1', 'l1', p);
      expect(created).toBe(false);
      expect(prisma.notification.create).not.toHaveBeenCalled();
      // 去重查询必须带 payload.dedupeKey 条件
      expect(prisma.notification.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'u1',
          type: 'cfo_proposal',
          payload: { path: ['dedupeKey'], equals: p.dedupeKey },
        },
        select: { id: true },
      });
    });

    it('未通知过 → 写入，payload 携带 dedupeKey/proposalId/severity', async () => {
      prisma.notification.findFirst.mockResolvedValue(null);
      prisma.notification.create.mockResolvedValue({});
      const created = await svc.createFromProposalOnce('u1', 'l1', p);
      expect(created).toBe(true);
      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'u1',
          ledgerId: 'l1',
          type: 'cfo_proposal',
          payload: expect.objectContaining({
            dedupeKey: p.dedupeKey,
            proposalId: 'p1',
            severity: 'critical',
          }),
        }),
      });
    });
  });
});
