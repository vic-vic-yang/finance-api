import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TimelineService } from './timeline.service';

/**
 * 财务事件时间线（只读）
 *  - GET /api/timeline?limit=50   合并账单/余额变化/提案/通知/目标进展
 */
@Controller('timeline')
@UseGuards(AuthGuard('jwt'))
export class TimelineController {
  constructor(private svc: TimelineService) {}

  @Get()
  list(@Request() req, @Query('limit') limit?: string) {
    return this.svc.getTimeline(req.user.id, req.user.currentLedgerId, Number(limit));
  }
}
