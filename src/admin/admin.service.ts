import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  // ── 平台概览 ──────────────────────────────────────────────

  async getSummary() {
    const [totalUsers, totalVip, totalLedgers, totalBills] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({
        where: { vipTier: { not: 'free' } },
      }),
      this.prisma.ledger.count(),
      this.prisma.bill.count(),
    ]);
    // 30 天内活跃用户（有记账行为）
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const activeUsers = await this.prisma.bill.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: thirtyDaysAgo } },
    });
    return {
      totalUsers,
      totalVip,
      totalLedgers,
      totalBills,
      activeUsers30d: activeUsers.length,
    };
  }

  // ── 用户列表（分页 + 搜索）────────────────────────────────

  async listUsers(params: {
    page?: number;
    pageSize?: number;
    q?: string;
    vip?: string;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (params.q) {
      where.OR = [
        { username: { contains: params.q } },
        { nickname: { contains: params.q } },
      ];
    }
    if (params.vip && params.vip !== 'all') {
      where.vipTier = params.vip === 'free' ? 'free' : { not: 'free' };
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: [
          { lastActiveAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        select: {
          id: true,
          username: true,
          nickname: true,
          role: true,
          vipTier: true,
          vipExpiresAt: true,
          vipNote: true,
          createdAt: true,
          lastActiveAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users: users.map((u) => ({
        ...u,
        vipExpiresAt: u.vipExpiresAt?.toISOString() ?? null,
        createdAt: u.createdAt.toISOString(),
        lastActiveAt: u.lastActiveAt?.toISOString() ?? null,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  // ── 用户详情 ──────────────────────────────────────────────

  async getUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        nickname: true,
        role: true,
        vipTier: true,
        vipExpiresAt: true,
        vipNote: true,
        createdAt: true,
        _count: {
          select: {
            ownedLedgers: true,
            bills: true,
            aiImports: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('用户不存在');
    return {
      ...user,
      vipExpiresAt: user.vipExpiresAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      stats: {
        ledgers: user._count.ownedLedgers,
        bills: user._count.bills,
        aiImports: user._count.aiImports,
      },
      _count: undefined,
    };
  }

  // ── VIP 设置 ──────────────────────────────────────────────

  async setVip(
    id: string,
    data: { vipTier: string; vipExpiresAt?: string | null; vipNote?: string | null },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');

    const now = new Date();
    let expiresAt: Date | null = null;
    if (data.vipExpiresAt) {
      expiresAt = new Date(data.vipExpiresAt);
      if (isNaN(expiresAt.getTime())) {
        expiresAt = new Date(now.getTime() + 365 * 86400000); // 默认一年
      }
    }
    // 如果设回 free，清空到期时间
    if (data.vipTier === 'free') {
      expiresAt = null;
    }

    await this.prisma.user.update({
      where: { id },
      data: {
        vipTier: data.vipTier,
        vipExpiresAt: expiresAt,
        vipNote: data.vipNote ?? null,
      },
    });
    return { message: 'VIP 设置已更新' };
  }

  // ── 角色设置 ──────────────────────────────────────────────

  async setRole(id: string, role: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('用户不存在');
    if (!['user', 'admin'].includes(role)) {
      throw new NotFoundException('无效角色，仅支持 user / admin');
    }
    await this.prisma.user.update({
      where: { id },
      data: { role },
    });
    return { message: '角色已更新' };
  }

  // ── VIP 到期预警 ──────────────────────────────────────────

  async listExpiringVip(days: number = 30) {
    const now = new Date();
    const deadline = new Date(now.getTime() + days * 86400000);

    const users = await this.prisma.user.findMany({
      where: {
        vipTier: { not: 'free' },
        vipExpiresAt: { not: null, lte: deadline, gte: now },
      },
      orderBy: { vipExpiresAt: 'asc' },
      select: {
        id: true,
        username: true,
        nickname: true,
        vipTier: true,
        vipExpiresAt: true,
      },
    });

    return {
      users: users.map((u) => ({
        ...u,
        vipExpiresAt: u.vipExpiresAt!.toISOString(),
        remainingDays: Math.ceil(
          (u.vipExpiresAt!.getTime() - now.getTime()) / 86400000,
        ),
      })),
      total: users.length,
    };
  }
}
