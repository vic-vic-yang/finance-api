import { Controller, Get, Post, Query, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ReconcileService } from './reconcile.service';

/**
 * 对账中心（只读报告）
 *  - GET /api/reconcile/report?month=YYYY-MM   四项一致性检查（缺省当前月）
 */
@Controller('reconcile')
@UseGuards(AuthGuard('jwt'))
export class ReconcileController {
  constructor(private svc: ReconcileService) {}

  @Get('report')
  report(@Request() req, @Query('month') month?: string) {
    return this.svc.report(req.user.id, req.user.currentLedgerId, month);
  }

  @Get('data-trust')
  dataTrust(@Request() req, @Query('month') month?: string) {
    return this.svc.trustScore(req.user.id, req.user.currentLedgerId, month);
  }

  @Post('proposals')
  generateProposals(@Request() req, @Query('month') month?: string) {
    return this.svc.generateProposals(req.user.id, req.user.currentLedgerId, month);
  }
}
