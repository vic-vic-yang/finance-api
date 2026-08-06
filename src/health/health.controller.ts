import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { HealthService } from './health.service';

/**
 * 财务健康评分（只读）
 *  - GET /api/health/score   当前账本的健康分（五维度加权）
 */
@Controller('health')
@UseGuards(AuthGuard('jwt'))
export class HealthController {
  constructor(private svc: HealthService) {}

  @Get('score')
  score(@Request() req) {
    return this.svc.score(req.user.id, req.user.currentLedgerId);
  }
}
