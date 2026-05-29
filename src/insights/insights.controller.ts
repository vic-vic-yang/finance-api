import {
  Controller, Get, Post, Body, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InsightsService } from './insights.service';
import { DismissInsightDto } from './dto/dismiss-insight.dto';

/** AI 洞察接口
 *  - GET  /api/ai/insights        实时算（带 5 分钟缓存的话另说，目前不缓存）
 *  - POST /api/ai/insights/dismiss 忽略某条洞察，30 天/15 天内不再出现
 */
@Controller('ai/insights')
@UseGuards(AuthGuard('jwt'))
export class InsightsController {
  constructor(private svc: InsightsService) {}

  @Get()
  list(@Request() req) {
    return this.svc.list(req.user.id, req.user.currentLedgerId);
  }

  @Post('dismiss')
  @HttpCode(HttpStatus.OK)
  dismiss(@Request() req, @Body() dto: DismissInsightDto) {
    return this.svc.dismiss(
      req.user.id,
      req.user.currentLedgerId,
      dto.type,
      dto.target,
    );
  }
}
