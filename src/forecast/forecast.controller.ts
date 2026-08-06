import { Controller, Get, UseGuards, Request } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ForecastService } from './forecast.service';

@Controller('forecast')
@UseGuards(AuthGuard('jwt'))
export class ForecastController {
  constructor(private svc: ForecastService) {}

  /** 现金流预测：月末净资产 / 未来30天扣款 / 支出速率 / 目标达成 */
  @Get()
  get(@Request() req) {
    return this.svc.getForecast(req.user.id, req.user.currentLedgerId);
  }
}
