import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { BriefingService } from './briefing.service';
import { NotificationsService } from '../notifications/notifications.service';

/** 每周管家简报调度：每周一 08:37 为「近 14 天有记账且开启简报」的用户
 *  生成上周（周一~周日完整周）简报，并写入通知中心
 *  （前端本地推送桥会把新通知弹成系统通知——这是简报触达用户的通道）。
 *
 *  设计要点（与 proactive-scan 同款）：
 *  - inflight 锁防重入；单 (用户, 账本) 失败不影响整体扫描；
 *  - (userId, ledgerId, weekStart) 唯一约束 + createBriefingOnce 双重幂等，重跑不重复；
 *  - 空数据周（上周 0 笔账单）跳过，不打扰。
 */
@Injectable()
export class BriefingScheduler {
  private readonly logger = new Logger('BriefingScheduler');
  private inflight = false;

  constructor(
    private prisma: PrismaService,
    private briefing: BriefingService,
    private notifications: NotificationsService,
  ) {}

  @Cron('0 37 8 * * 1')
  async scheduledRun() {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const { users, ledgers, generated, notified } = await this.runAll();
      this.logger.log(
        `周报调度完成：${users} 用户 / ${ledgers} 账本，生成简报 ${generated} 份，发出通知 ${notified} 条`,
      );
    } catch (e: any) {
      this.logger.warn(`周报调度失败：${e?.message}`);
    } finally {
      this.inflight = false;
    }
  }

  /** 全量扫描（定时任务入口；拆出来便于手动测试）。返回统计计数。 */
  async runAll(now = new Date()) {
    const since = new Date(now);
    since.setDate(since.getDate() - 14);

    // 近 14 天有账单的用户（记账人维度）
    const activeUsers = await this.prisma.bill.findMany({
      where: { date: { gte: since } },
      select: { userId: true },
      distinct: ['userId'],
    });
    if (activeUsers.length === 0) {
      return { users: 0, ledgers: 0, generated: 0, notified: 0 };
    }

    // 过滤掉关闭周报开关的用户
    const enabled = await this.prisma.user.findMany({
      where: {
        id: { in: activeUsers.map((u) => u.userId) },
        briefingEnabled: true,
      },
      select: { id: true },
    });

    let ledgers = 0;
    let generated = 0;
    let notified = 0;

    for (const { id: userId } of enabled) {
      const memberships = await this.prisma.ledgerMember.findMany({
        where: { userId },
        select: { ledgerId: true },
      });
      for (const { ledgerId } of memberships) {
        ledgers++;
        try {
          const { briefing, isNew } = await this.briefing.generateForLedger(
            userId,
            ledgerId,
            now,
          );
          if (!briefing || !isNew) continue;
          generated++;
          if (
            await this.notifications.createBriefingOnce(userId, ledgerId, briefing)
          ) {
            notified++;
          }
        } catch (e: any) {
          this.logger.warn(
            `生成周报失败（账本 ${ledgerId}，用户 ${userId}）：${e?.message}`,
          );
        }
      }
    }
    return { users: enabled.length, ledgers, generated, notified };
  }
}
