import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CfoService } from '../cfo/cfo.service';
import { NotificationsService } from './notifications.service';

/** 主动式 CFO 扫描：每天 08:17 把「近 30 天有记账」的用户的账本跑一遍检测器，
 *  新生成的 critical / warning 级建议写入通知中心（同一 dedupeKey 每用户只通知一次）。
 *
 *  设计要点：
 *  - 复用 CfoService.generateNewProposals（与用户打开 CFO 页时同一套检测逻辑），
 *    只处理本次新建的 Proposal，已存在的不重复通知；
 *  - 通知按账本成员扇出：建议属于账本，所有成员都应收到；
 *    createFromProposalOnce 按 (userId, dedupeKey) 去重，多成员账本轮流触发扫描也不会重复；
 *  - inflight 锁防重入；单 (用户, 账本) 失败不影响整体扫描。
 */
@Injectable()
export class ProactiveScanService {
  private readonly logger = new Logger('ProactiveScan');
  private inflight = false;

  constructor(
    private prisma: PrismaService,
    private cfo: CfoService,
    private notifications: NotificationsService,
  ) {}

  @Cron('0 17 8 * * *')
  async scheduledScan() {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const { users, ledgers, proposals, notified } = await this.scanAll();
      this.logger.log(
        `主动扫描完成：${users} 用户 / ${ledgers} 账本，新建建议 ${proposals} 条，发出通知 ${notified} 条`,
      );
    } catch (e: any) {
      this.logger.warn(`主动扫描失败：${e?.message}`);
    } finally {
      this.inflight = false;
    }
  }

  /** 全量扫描（定时任务入口；拆出来便于手动测试）。返回统计计数。 */
  async scanAll() {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    // 近 30 天有账单的用户（记账人维度）
    const activeUsers = await this.prisma.bill.findMany({
      where: { date: { gte: since } },
      select: { userId: true },
      distinct: ['userId'],
    });

    let ledgers = 0;
    let proposals = 0;
    let notified = 0;

    for (const { userId } of activeUsers) {
      // 该用户加入的全部账本
      const memberships = await this.prisma.ledgerMember.findMany({
        where: { userId },
        select: { ledgerId: true },
      });
      for (const { ledgerId } of memberships) {
        ledgers++;
        try {
          const created = await this.cfo.generateNewProposals(ledgerId, userId);
          // 只通知 critical / warning（info 级不打扰）
          const noteworthy = created.filter(
            (p) => p.severity === 'critical' || p.severity === 'warning',
          );
          if (noteworthy.length === 0) continue;
          proposals += noteworthy.length;

          // 扇出给账本全部成员；按 (userId, dedupeKey) 去重
          const members = await this.prisma.ledgerMember.findMany({
            where: { ledgerId },
            select: { userId: true },
          });
          for (const p of noteworthy) {
            for (const m of members) {
              const isNew = await this.notifications.createFromProposalOnce(
                m.userId,
                ledgerId,
                p,
              );
              if (isNew) notified++;
            }
          }
        } catch (e: any) {
          this.logger.warn(
            `扫描账本 ${ledgerId}（用户 ${userId}）失败：${e?.message}`,
          );
        }
      }
    }
    return { users: activeUsers.length, ledgers, proposals, notified };
  }
}
