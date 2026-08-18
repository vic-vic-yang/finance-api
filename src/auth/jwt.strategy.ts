import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { shouldTouchLastActive } from './activity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET || 'fallback-secret',
    });
  }

  async validate(payload: { userId: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
    });
    if (!user) throw new UnauthorizedException('用户不存在');
    if (shouldTouchLastActive(user.lastActiveAt)) {
      const lastActiveAt = new Date();
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastActiveAt },
      });
      user.lastActiveAt = lastActiveAt;
    }
    return user;
  }
}
