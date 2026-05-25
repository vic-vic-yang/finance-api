import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

/// 统一的"对外用户信息"形状：包含 nickname + displayName（昵称优先回退用户名）
export function shapeUser(user: {
  id: string;
  username: string;
  nickname?: string | null;
  currentLedgerId?: string | null;
}) {
  const display = (user.nickname ?? '').trim();
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname ?? null,
    displayName: display.length > 0 ? display : user.username,
    ...(user.currentLedgerId !== undefined
      ? { currentLedgerId: user.currentLedgerId }
      : {}),
  };
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private ledgers: LedgersService,
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
      }),
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
}
