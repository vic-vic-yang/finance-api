import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLedgerDto } from './dto/create-ledger.dto';
import { UpdateLedgerDto } from './dto/update-ledger.dto';
import { JoinLedgerDto } from './dto/join-ledger.dto';
import { randomInt } from 'crypto';

@Injectable()
export class LedgersService {
  constructor(private prisma: PrismaService) {}

  /** 列出当前用户拥有 + 加入的所有账本 */
  async findAll(userId: string) {
    const memberships = await this.prisma.ledgerMember.findMany({
      where: { userId },
      include: {
        ledger: {
          include: {
            owner: { select: { id: true, username: true, nickname: true } },
            _count: { select: { members: true, bills: true } },
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    return {
      currentLedgerId: user?.currentLedgerId,
      ledgers: memberships.map((m) => {
        const nick = (m.ledger.owner.nickname ?? '').trim();
        return {
          id: m.ledger.id,
          name: m.ledger.name,
          icon: m.ledger.icon,
          isPersonal: m.ledger.isPersonal,
          ownerId: m.ledger.ownerId,
          ownerName: m.ledger.owner.username,
          ownerNickname: m.ledger.owner.nickname ?? null,
          ownerDisplayName:
            nick.length > 0 ? nick : m.ledger.owner.username,
          role: m.role,
          memberCount: m.ledger._count.members,
          billCount: m.ledger._count.bills,
          joinedAt: m.joinedAt,
        };
      }),
    };
  }

  /** 创建一个新账本，并把自己加为 owner。
   *  E2E 加密：客户端必须在创建时附上"用自己公钥包装好的 DEK"。 */
  async create(userId: string, dto: CreateLedgerDto) {
    if (!dto.dekWrapped) {
      throw new BadRequestException('缺少 dekWrapped（账本数据密钥）');
    }
    const dekBuf = Buffer.from(dto.dekWrapped, 'base64');
    const ledger = await this.prisma.$transaction(async (tx) => {
      const l = await tx.ledger.create({
        data: {
          name: dto.name,
          icon: dto.icon ?? '📒',
          ownerId: userId,
          isPersonal: false,
        },
      });
      await tx.ledgerMember.create({
        data: {
          ledgerId: l.id,
          userId,
          role: 'owner',
          dekWrapped: dekBuf,
          dekVersion: 1,
        },
      });
      return l;
    });
    return {
      message: '创建成功',
      ledger,
      dekWrapped: dekBuf.toString('base64'),
      dekVersion: 1,
    };
  }

  /** 切换当前账本 */
  async switchTo(userId: string, ledgerId: string) {
    await this.ensureMembership(userId, ledgerId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { currentLedgerId: ledgerId },
    });
    return { message: '已切换', currentLedgerId: ledgerId };
  }

  /** 重命名、改图标（仅 owner） */
  async update(userId: string, id: string, dto: UpdateLedgerDto) {
    await this.ensureOwner(userId, id);
    const ledger = await this.prisma.ledger.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
      },
    });
    return { message: '更新成功', ledger };
  }

  /** 删除账本（仅 owner，且不能删个人账本） */
  async remove(userId: string, id: string) {
    const ledger = await this.ensureOwner(userId, id);
    if (ledger.isPersonal) {
      throw new ForbiddenException('个人账本不可删除');
    }
    // 删账本会级联删 members / bills / accounts / budgets / categories / invites
    await this.prisma.ledger.delete({ where: { id } });

    // 把切换到该账本的所有用户重置为他们自己的个人账本
    const personalMap = await this.prisma.ledger.findMany({
      where: { isPersonal: true },
      select: { id: true, ownerId: true },
    });
    const ownerToPersonal: Record<string, string> = {};
    for (const p of personalMap) ownerToPersonal[p.ownerId] = p.id;

    const orphans = await this.prisma.user.findMany({
      where: { currentLedgerId: null },
      select: { id: true },
    });
    await Promise.all(
      orphans.map((u) =>
        ownerToPersonal[u.id]
          ? this.prisma.user.update({
              where: { id: u.id },
              data: { currentLedgerId: ownerToPersonal[u.id] },
            })
          : Promise.resolve(),
      ),
    );

    return { message: '已删除' };
  }

  /** 生成邀请码（仅 owner） */
  async createInvite(userId: string, ledgerId: string) {
    await this.ensureOwner(userId, ledgerId);
    // 随机 6 位数字
    let code = '';
    for (let i = 0; i < 5; i++) {
      code = String(randomInt(100000, 999999));
      const exists = await this.prisma.ledgerInvite.findUnique({
        where: { code },
      });
      if (!exists) break;
    }
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 天
    const invite = await this.prisma.ledgerInvite.create({
      data: {
        ledgerId,
        code,
        createdBy: userId,
        expiresAt,
      },
    });
    return {
      message: '邀请码生成成功',
      code: invite.code,
      expiresAt: invite.expiresAt,
    };
  }

  /** 使用邀请码加入账本（dekWrapped 暂为 null，待已有成员客户端帮忙包装） */
  async join(userId: string, dto: JoinLedgerDto) {
    const invite = await this.prisma.ledgerInvite.findUnique({
      where: { code: dto.code },
      include: { ledger: true },
    });
    if (!invite) throw new NotFoundException('邀请码无效');
    if (invite.usedBy) throw new BadRequestException('邀请码已被使用');
    if (invite.expiresAt < new Date())
      throw new BadRequestException('邀请码已过期');

    const existing = await this.prisma.ledgerMember.findUnique({
      where: {
        ledgerId_userId: { ledgerId: invite.ledgerId, userId },
      },
    });
    if (existing) throw new ConflictException('你已是该账本成员');

    await this.prisma.$transaction([
      this.prisma.ledgerMember.create({
        data: {
          ledgerId: invite.ledgerId,
          userId,
          role: 'member',
          // dekWrapped: null  — 待原成员的客户端轮询发现后 wrap 上传
        },
      }),
      this.prisma.ledgerInvite.update({
        where: { id: invite.id },
        data: { usedBy: userId, usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { currentLedgerId: invite.ledgerId },
      }),
    ]);

    return {
      message: `已加入「${invite.ledger.name}」，等待原成员授权解密`,
      ledger: invite.ledger,
      pending: true,
    };
  }

  /** 列出本账本里 dekWrapped 为空的成员（含其公钥），用于已持有 DEK 的成员
   *  客户端帮忙 wrap 后调 attachDek 上传。
   *  只有持有 DEK 的成员可以调（dekWrapped != null）。 */
  async listPendingMembers(userId: string, ledgerId: string) {
    const self = await this.ensureMembership(userId, ledgerId);
    if (!self.dekWrapped) {
      // 自己都没拿到 DEK，没法帮别人；返回空即可
      return { pending: [], selfPending: true };
    }
    const pending = await this.prisma.ledgerMember.findMany({
      where: { ledgerId, dekWrapped: null },
      include: {
        user: {
          select: { id: true, username: true, nickname: true, sm2PubKey: true },
        },
      },
    });
    return {
      selfPending: false,
      myDekVersion: self.dekVersion,
      pending: pending.map((m) => ({
        userId: m.userId,
        username: m.user.username,
        nickname: m.user.nickname,
        sm2PubKey: m.user.sm2PubKey,
      })),
    };
  }

  /** 已有成员把"为新成员包装好的 DEK"上传给服务端 */
  async attachDek(
    userId: string,
    ledgerId: string,
    targetUserId: string,
    dekWrappedBase64: string,
    dekVersion: number,
  ) {
    const self = await this.ensureMembership(userId, ledgerId);
    if (!self.dekWrapped) {
      throw new ForbiddenException('你尚未持有该账本密钥，无法授权他人');
    }
    if (dekVersion !== self.dekVersion) {
      throw new BadRequestException('DEK 版本不匹配，请刷新');
    }
    const target = await this.prisma.ledgerMember.findUnique({
      where: { ledgerId_userId: { ledgerId, userId: targetUserId } },
    });
    if (!target) throw new NotFoundException('目标成员不在该账本');
    if (target.dekWrapped) {
      // 已经被别人 wrap 过了，幂等返回
      return { message: '已存在', already: true };
    }
    await this.prisma.ledgerMember.update({
      where: { id: target.id },
      data: {
        dekWrapped: Buffer.from(dekWrappedBase64, 'base64'),
        dekVersion,
      },
    });
    return { message: '已授权', already: false };
  }

  /** 拉取当前用户在所有账本里的 dekWrapped（登录后客户端调一次） */
  async listMyDeks(userId: string) {
    const members = await this.prisma.ledgerMember.findMany({
      where: { userId, dekWrapped: { not: null } },
      select: {
        ledgerId: true,
        dekWrapped: true,
        dekVersion: true,
      },
    });
    return {
      deks: members.map((m) => ({
        ledgerId: m.ledgerId,
        dekWrapped: m.dekWrapped!.toString('base64'),
        dekVersion: m.dekVersion,
      })),
    };
  }

  /** 列出账本成员 */
  async listMembers(userId: string, ledgerId: string) {
    await this.ensureMembership(userId, ledgerId);
    const members = await this.prisma.ledgerMember.findMany({
      where: { ledgerId },
      include: {
        user: { select: { id: true, username: true, nickname: true } },
      },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    });
    return {
      members: members.map((m) => {
        const nick = (m.user.nickname ?? '').trim();
        return {
          id: m.id,
          userId: m.userId,
          username: m.user.username,
          nickname: m.user.nickname ?? null,
          displayName: nick.length > 0 ? nick : m.user.username,
          role: m.role,
          joinedAt: m.joinedAt,
        };
      }),
    };
  }

  /** 移除成员（owner 可踢人；成员可自行退出） */
  async removeMember(userId: string, ledgerId: string, targetUserId: string) {
    const ledger = await this.prisma.ledger.findUnique({
      where: { id: ledgerId },
    });
    if (!ledger) throw new NotFoundException('账本不存在');
    if (ledger.isPersonal)
      throw new ForbiddenException('个人账本不可操作成员');
    if (ledger.ownerId === targetUserId)
      throw new ForbiddenException('owner 不可被移除，请先转让或删除账本');

    const isSelf = userId === targetUserId;
    const isOwner = ledger.ownerId === userId;
    if (!isSelf && !isOwner)
      throw new ForbiddenException('无权操作');

    const m = await this.prisma.ledgerMember.findUnique({
      where: {
        ledgerId_userId: { ledgerId, userId: targetUserId },
      },
    });
    if (!m) throw new NotFoundException('成员不存在');

    await this.prisma.ledgerMember.delete({ where: { id: m.id } });

    // 如果被移除的人当前正用此账本，切回他的个人账本
    const personal = await this.prisma.ledger.findFirst({
      where: { ownerId: targetUserId, isPersonal: true },
    });
    if (personal) {
      await this.prisma.user.update({
        where: { id: targetUserId },
        data: { currentLedgerId: personal.id },
      });
    }
    return { message: isSelf ? '已退出账本' : '已移除成员' };
  }

  /** 工具：确认是成员 */
  async ensureMembership(userId: string, ledgerId: string) {
    const m = await this.prisma.ledgerMember.findUnique({
      where: { ledgerId_userId: { ledgerId, userId } },
    });
    if (!m) throw new ForbiddenException('无权访问该账本');
    return m;
  }

  /** 工具：确认是 owner */
  private async ensureOwner(userId: string, ledgerId: string) {
    const ledger = await this.prisma.ledger.findUnique({
      where: { id: ledgerId },
    });
    if (!ledger) throw new NotFoundException('账本不存在');
    if (ledger.ownerId !== userId)
      throw new ForbiddenException('仅账本创建者可操作');
    return ledger;
  }

  /** 工具：为新注册用户创建默认个人账本（DEK 由客户端预包装） */
  async createPersonalLedger(userId: string, dekWrapped: Buffer) {
    return this.prisma.$transaction(async (tx) => {
      const ledger = await tx.ledger.create({
        data: {
          name: '我的账本',
          icon: '💰',
          ownerId: userId,
          isPersonal: true,
        },
      });
      await tx.ledgerMember.create({
        data: {
          ledgerId: ledger.id,
          userId,
          role: 'owner',
          dekWrapped,
          dekVersion: 1,
        },
      });
      await tx.user.update({
        where: { id: userId },
        data: { currentLedgerId: ledger.id },
      });
      return ledger;
    });
  }
}
