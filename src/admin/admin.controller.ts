import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(AuthGuard('jwt'), AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ── 平台概览 ──────────────────────────────────────────────

  @Get('stats/summary')
  summary() {
    return this.admin.getSummary();
  }

  // ── 用户列表（分页 + 搜索）────────────────────────────────

  @Get('users')
  listUsers(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('q') q?: string,
    @Query('vip') vip?: string,
  ) {
    return this.admin.listUsers({
      page: page ? parseInt(page) : undefined,
      pageSize: pageSize ? parseInt(pageSize) : undefined,
      q,
      vip,
    });
  }

  // ── 用户详情 ──────────────────────────────────────────────

  @Get('users/:id')
  getUser(@Param('id') id: string) {
    return this.admin.getUser(id);
  }

  // ── VIP 设置 ──────────────────────────────────────────────

  @Patch('users/:id/vip')
  @HttpCode(HttpStatus.OK)
  setVip(@Param('id') id: string, @Body() body: any) {
    return this.admin.setVip(id, {
      vipTier: body.vipTier ?? 'free',
      vipExpiresAt: body.vipExpiresAt,
      vipNote: body.vipNote,
    });
  }

  // ── 角色设置 ──────────────────────────────────────────────

  @Patch('users/:id/role')
  @HttpCode(HttpStatus.OK)
  setRole(@Param('id') id: string, @Body() body: { role: string }) {
    return this.admin.setRole(id, body.role);
  }

  // ── VIP 到期预警 ──────────────────────────────────────────

  @Get('vip/expiring')
  listExpiring(@Query('days') days?: string) {
    return this.admin.listExpiringVip(days ? parseInt(days) : 30);
  }
}
