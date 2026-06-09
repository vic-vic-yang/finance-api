import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PicksService } from './picks.service';

@Controller('picks')
@UseGuards(AuthGuard('jwt'))
export class PicksController {
  constructor(private picks: PicksService) {}

  /** GET /api/picks/today —— 最新一期「每日机会股」+ 板块解读 */
  @Get('today')
  today() {
    return this.picks.getLatest();
  }

  /** POST /api/picks/run —— 手动触发生成（测试/补算用，幂等） */
  @Post('run')
  async run() {
    await this.picks.ensureToday();
    return this.picks.getLatest();
  }
}
