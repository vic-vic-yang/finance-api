import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FamilyReviewService } from './family-review.service';

/**
 * 月度家庭复盘（只读）
 *  - GET /api/family/review?month=YYYY-MM   全家收支/成员贡献/预算/目标（缺省当前月）
 */
@Controller('family')
@UseGuards(AuthGuard('jwt'))
export class FamilyReviewController {
  constructor(private svc: FamilyReviewService) {}

  @Get('review')
  review(@Request() req, @Query('month') month?: string) {
    return this.svc.review(req.user.id, req.user.currentLedgerId, month);
  }
}
