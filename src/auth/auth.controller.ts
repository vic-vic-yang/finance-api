import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { BriefingEnabledDto } from './dto/briefing-enabled.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RecoverStartDto } from './dto/recover-start.dto';
import { RecoverFinishDto } from './dto/recover-finish.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  // 注册：每 IP 每小时 5 次（防批量开号）
  @Post('register')
  @Throttle({ default: { ttl: 3600_000, limit: 5 } })
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  // 登录：每 IP 每分钟 10 次（防爆破密码）
  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // 查看当前用户资料（含昵称）
  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  me(@Req() req: any) {
    return this.authService.getProfile(req.user.id);
  }

  // 修改昵称
  @UseGuards(AuthGuard('jwt'))
  @Patch('me')
  updateMe(@Req() req: any, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(req.user.id, dto);
  }

  // 每周管家简报开关
  @UseGuards(AuthGuard('jwt'))
  @Patch('me/briefing-enabled')
  setBriefingEnabled(@Req() req: any, @Body() dto: BriefingEnabledDto) {
    return this.authService.setBriefingEnabled(req.user.id, dto.enabled);
  }

  // 修改密码：登录态；客户端已经用新密码 KDF 重新加密了 privKey
  // 每 IP 每分钟 5 次（密码相关操作收紧）
  @UseGuards(AuthGuard('jwt'))
  @Post('change-password')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(req.user.id, dto);
  }

  // 忘密码 第一步：不需要登录，返回 salt + 恢复码密文
  // 每 IP 每分钟 10 次（防扫用户名 + 防 DoS）
  @Post('recover/start')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  recoverStart(@Body() dto: RecoverStartDto) {
    return this.authService.recoverStart(dto);
  }

  // 忘密码 第二步：服务端验恢复码 + 重置 bcrypt + 发 keyBundle
  // 每 IP 每分钟 5 次（更严，防爆破恢复码）
  @Post('recover/finish')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  recoverFinish(@Body() dto: RecoverFinishDto) {
    return this.authService.recoverFinish(dto);
  }

  // VIP 状态查询
  @UseGuards(AuthGuard('jwt'))
  @Get('vip-status')
  vipStatus(@Req() req: any) {
    return this.authService.getVipStatus(req.user.id);
  }
}
