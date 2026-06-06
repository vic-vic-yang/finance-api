import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ExchangeService } from './exchange.service';

@Controller('tools')
@UseGuards(AuthGuard('jwt'))
export class ToolsController {
  constructor(private exchange: ExchangeService) {}

  /** GET /api/tools/exchange-rates?base=CNY */
  @Get('exchange-rates')
  exchangeRates(@Query('base') base?: string) {
    return this.exchange.getRates(base ?? 'CNY');
  }
}
