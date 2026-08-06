import {
  Controller, Get, Post, Patch, Param, Query,
  UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { NotificationsService } from './notifications.service';
import { QueryNotificationDto } from './dto/query-notification.dto';

/** 通知中心接口（全部 JWT 鉴权，作用域 = 当前用户）
 *  - GET    /api/notifications              分页列表，未读在前
 *  - GET    /api/notifications/unread-count 未读数
 *  - PATCH  /api/notifications/:id/read     标记单条已读
 *  - POST   /api/notifications/read-all     全部已读
 */
@Controller('notifications')
@UseGuards(AuthGuard('jwt'))
export class NotificationsController {
  constructor(private svc: NotificationsService) {}

  @Get()
  list(@Request() req, @Query() query: QueryNotificationDto) {
    return this.svc.list(req.user.id, query);
  }

  @Get('unread-count')
  unreadCount(@Request() req) {
    return this.svc.unreadCount(req.user.id);
  }

  @Patch(':id/read')
  markRead(@Request() req, @Param('id') id: string) {
    return this.svc.markRead(req.user.id, id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(@Request() req) {
    return this.svc.markAllRead(req.user.id);
  }
}
