import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';
import { SmService } from '../crypto/sm.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RecoverStartDto } from './dto/recover-start.dto';
import { RecoverFinishDto } from './dto/recover-finish.dto';

/// 统一的"对外用户信息"形状：包含 nickname + displayName（昵称优先回退用户名）
export function shapeUser(user: {
  id: string;
  username: string;
  nickname?: string | null;
  role?: string | null;
  currentLedgerId?: string | null;
  briefingEnabled?: boolean;
}) {
  const display = (user.nickname ?? '').trim();
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname ?? null,
    displayName: display.length > 0 ? display : user.username,
    role: user.role ?? 'user',
    ...(user.currentLedgerId !== undefined
      ? { currentLedgerId: user.currentLedgerId }
      : {}),
    ...(user.briefingEnabled !== undefined
      ? { briefingEnabled: user.briefingEnabled }
      : {}),
  };
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private ledgers: LedgersService,
    private sm: SmService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });
    if (existing) throw new ConflictException('用户名已存在');

    const hash = await bcrypt.hash(dto.password, 12);

    // 把客户端送来的 base64 / hex 解成 Buffer 落库（Prisma Bytes）
    const sm2PrivByPwd = Buffer.from(dto.sm2PrivByPwd, 'base64');
    const sm2PrivByRecovery = Buffer.from(dto.sm2PrivByRecovery, 'base64');
    const kdfSalt = Buffer.from(dto.kdfSalt, 'base64');
    const recoveryHash = Buffer.from(dto.recoveryHash, 'base64');
    const personalDek = Buffer.from(dto.personalLedgerDekWrapped, 'base64');

    const user = await this.prisma.user.create({
      data: {
        username: dto.username,
        password: hash,
        sm2PubKey: dto.sm2PubKey,
        sm2PrivByPwd,
        sm2PrivByRecovery,
        kdfSalt,
        recoveryHash,
      },
    });

    // 自动创建个人账本，DEK 由客户端预包装传入
    const ledger = await this.ledgers.createPersonalLedger(user.id, personalDek);

    const token = this.jwt.sign({ userId: user.id });
    return {
      message: '注册成功',
      token,
      user: shapeUser({
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        role: user.role,
        currentLedgerId: ledger.id,
      }),
      // 注册即返回 keyBundle，让客户端可立即缓存（避免马上再发一次 login）
      keyBundle: this.buildKeyBundleStub({
        sm2PubKey: dto.sm2PubKey,
        sm2PrivByPwd: dto.sm2PrivByPwd,
        sm2PrivByRecovery: dto.sm2PrivByRecovery,
        kdfSalt: dto.kdfSalt,
      }),
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });
    if (!user) throw new UnauthorizedException('用户名或密码错误');

    const match = await bcrypt.compare(dto.password, user.password);
    if (!match) throw new UnauthorizedException('用户名或密码错误');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });

    // 防御：极少数情况下用户没有当前账本（被踢出唯一账本）
    // E2E 加密下，服务端无法自动建账本（无法生成 DEK），让客户端拿到 keyBundle
    // 后调 POST /ledgers 主动建一个，并把当前账本指向新账本
    let currentLedgerId = user.currentLedgerId;
    if (!currentLedgerId) {
      const personal = await this.prisma.ledger.findFirst({
        where: { ownerId: user.id, isPersonal: true },
      });
      if (personal) {
        currentLedgerId = personal.id;
        await this.prisma.user.update({
          where: { id: user.id },
          data: { currentLedgerId },
        });
      }
      // 否则保持 null，让客户端发现后建账本
    }

    const token = this.jwt.sign({ userId: user.id });
    return {
      message: '登录成功',
      token,
      user: shapeUser({
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        role: user.role,
        currentLedgerId,
      }),
      keyBundle: {
        sm2PubKey: user.sm2PubKey,
        sm2PrivByPwd: user.sm2PrivByPwd
          ? user.sm2PrivByPwd.toString('base64')
          : null,
        sm2PrivByRecovery: user.sm2PrivByRecovery
          ? user.sm2PrivByRecovery.toString('base64')
          : null,
        kdfSalt: user.kdfSalt ? user.kdfSalt.toString('base64') : null,
      },
    };
  }

  /** keyBundle 装配（注册路径用，跟 login 一致 shape） */
  private buildKeyBundleStub(b: {
    sm2PubKey: string;
    sm2PrivByPwd: string;
    sm2PrivByRecovery: string;
    kdfSalt: string;
  }) {
    return {
      sm2PubKey: b.sm2PubKey,
      sm2PrivByPwd: b.sm2PrivByPwd,
      sm2PrivByRecovery: b.sm2PrivByRecovery,
      kdfSalt: b.kdfSalt,
    };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) throw new NotFoundException('用户不存在');
    return {
      user: shapeUser({
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        currentLedgerId: user.currentLedgerId,
        briefingEnabled: user.briefingEnabled,
      }),
    };
  }

  /// 每周管家简报开关（我的 → 设置）
  async setBriefingEnabled(userId: string, enabled: boolean) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { briefingEnabled: enabled },
      select: { briefingEnabled: true },
    });
    return { briefingEnabled: user.briefingEnabled };
  }

  /// 改密码：客户端已经用 PBKDF2(新密码, 同 salt) 重新加密了 privKey，
  /// 服务端只验旧密码 + 更新 bcrypt + sm2PrivByPwd
  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');

    const match = await bcrypt.compare(dto.oldPassword, user.password);
    if (!match) throw new UnauthorizedException('旧密码不正确');

    if (dto.oldPassword === dto.newPassword) {
      throw new BadRequestException('新密码不能与旧密码相同');
    }

    const newHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: newHash,
        sm2PrivByPwd: Buffer.from(dto.sm2PrivByPwd, 'base64'),
      },
    });
    return { message: '密码已更新' };
  }

  /// 忘密码第一步：返回 salt + 恢复码加密的 privKey 密文
  /// 客户端拿到后本地用恢复码解出 privKey，再用新密码重新加密
  async recoverStart(dto: RecoverStartDto) {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });
    // 防"通过响应推断用户是否存在"——错误信息统一
    if (!user || !user.kdfSalt || !user.sm2PrivByRecovery) {
      throw new UnauthorizedException('用户名或恢复码无效');
    }
    return {
      kdfSalt: user.kdfSalt.toString('base64'),
      sm2PrivByRecovery: user.sm2PrivByRecovery.toString('base64'),
    };
  }

  /// 忘密码第二步：服务端验恢复码 → bcrypt 新密码 → 更新 sm2PrivByPwd → 发 token + keyBundle
  async recoverFinish(dto: RecoverFinishDto) {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });
    if (!user || !user.kdfSalt || !user.recoveryHash) {
      throw new UnauthorizedException('用户名或恢复码无效');
    }

    // 服务端校验恢复码：SM3(recoveryCode || kdfSalt) === stored recoveryHash？
    // 客户端格式化的恢复码是 "AABB-CCDD-EEFF-..." 这种大写，user 输入大小写可能混乱
    // 这里按原值校验，跟注册时一致即可
    const recoveryCode = dto.recoveryCode.trim().toUpperCase();
    const expected = this.sm.sm3(
      Buffer.concat([Buffer.from(recoveryCode, 'utf8'), user.kdfSalt]),
    );
    if (!crypto.timingSafeEqual(expected, user.recoveryHash)) {
      throw new UnauthorizedException('用户名或恢复码无效');
    }

    const newHash = await bcrypt.hash(dto.newPassword, 12);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: newHash,
        sm2PrivByPwd: Buffer.from(dto.sm2PrivByPwd, 'base64'),
      },
    });

    // 直接发 JWT，让用户免输新密码立刻进 App
    const token = this.jwt.sign({ userId: updated.id });
    return {
      message: '密码已重置，已自动登录',
      token,
      user: shapeUser({
        id: updated.id,
        username: updated.username,
        nickname: updated.nickname,
        currentLedgerId: updated.currentLedgerId,
      }),
      keyBundle: {
        sm2PubKey: updated.sm2PubKey,
        sm2PrivByPwd: updated.sm2PrivByPwd?.toString('base64') ?? null,
        sm2PrivByRecovery: updated.sm2PrivByRecovery?.toString('base64') ?? null,
        kdfSalt: updated.kdfSalt?.toString('base64') ?? null,
      },
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const nickname =
      dto.nickname === undefined
        ? undefined
        : dto.nickname.trim().length === 0
          ? null
          : dto.nickname.trim();
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(nickname !== undefined && { nickname }),
      },
    });
    return {
      message: '已更新',
      user: shapeUser({
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        currentLedgerId: user.currentLedgerId,
      }),
    };
  }

  async getVipStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, vipTier: true, vipExpiresAt: true },
    });
    if (!user) throw new NotFoundException('用户不存在');
    const now = new Date();
    const isVip =
      user.vipTier !== 'free' &&
      (!user.vipExpiresAt || user.vipExpiresAt > now);
    return {
      role: user.role,
      vipTier: user.vipTier,
      vipExpiresAt: user.vipExpiresAt?.toISOString() ?? null,
      isVip,
      remainingDays:
        user.vipExpiresAt && user.vipExpiresAt > now
          ? Math.ceil((user.vipExpiresAt.getTime() - now.getTime()) / 86400000)
          : 0,
    };
  }

  /**
   * 注销账号（上架合规要求的注销入口）：删除用户个人数据。
   *
   * 前置约束：若用户仍是共享账本 owner（还有其他成员）或 member，
   * 必须先转让/退出，避免误删其他成员的数据。
   * 通过约束后：手动清「裸 userId」表，再删 User，依赖外键级联删除其
   * owned 账本（含账本内 Bill/Account/Category/Budget 等）及
   * Bill/Notification/Briefing/AiImport/AiCorrection/LedgerMember 等。
   */
  async deleteAccount(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');

    // 共享账本约束检查
    const ownedShared = await this.prisma.ledger.findFirst({
      where: {
        ownerId: userId,
        isPersonal: false,
        members: { some: { userId: { not: userId } } },
      },
    });
    if (ownedShared) {
      throw new BadRequestException(
        '你仍是共享账本的拥有者，请先在「账本管理」转让或删除该账本后再注销',
      );
    }
    const joinedShared = await this.prisma.ledgerMember.findFirst({
      where: { userId, ledger: { isPersonal: false } },
    });
    if (joinedShared) {
      throw new BadRequestException(
        '你仍加入了共享账本，请先在「账本管理」退出该账本后再注销',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // 1) 无外键级联的「裸 userId」表，需手动清，否则删 User 后成孤儿数据
      await tx.ledgerInvite.deleteMany({ where: { createdBy: userId } });
      await tx.ledgerLlmConfig.deleteMany({ where: { ownerUserId: userId } });
      await tx.stockAnalysis.deleteMany({ where: { userId } });
      await tx.stockHolding.deleteMany({ where: { userId } });
      await tx.loan.deleteMany({ where: { userId } });
      await tx.savingsGoal.deleteMany({ where: { userId } });
      await tx.aiInsightDismissal.deleteMany({ where: { userId } });

      // 2) 删 User：外键级联删除其 owned 账本及账本内数据、userId 级联表
      await tx.user.delete({ where: { id: userId } });
    });

    return { deleted: true };
  }
}
