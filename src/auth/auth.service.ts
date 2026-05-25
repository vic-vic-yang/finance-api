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
    const user = await this.prisma.user.create({
      data: { username: dto.username, password: hash },
    });

    // 自动创建个人账本
    const ledger = await this.ledgers.createPersonalLedger(user.id);

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
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });
    if (!user) throw new UnauthorizedException('用户名或密码错误');

    const match = await bcrypt.compare(dto.password, user.password);
    if (!match) throw new UnauthorizedException('用户名或密码错误');

    // 防御：极少数情况下用户没有当前账本（比如被踢出唯一账本）
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
      } else {
        const ledger = await this.ledgers.createPersonalLedger(user.id);
        currentLedgerId = ledger.id;
      }
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
    // 把空字符串视为"清除昵称"
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
