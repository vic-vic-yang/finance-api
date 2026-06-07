import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ExchangeService } from './exchange.service';
import { StockService } from './stock.service';
import { StockHoldingService } from './stock-holding.service';

@Controller('tools')
@UseGuards(AuthGuard('jwt'))
export class ToolsController {
  constructor(
    private exchange: ExchangeService,
    private stock: StockService,
    private holdings: StockHoldingService,
  ) {}

  /** GET /api/tools/exchange-rates?base=CNY */
  @Get('exchange-rates')
  exchangeRates(@Query('base') base?: string) {
    return this.exchange.getRates(base ?? 'CNY');
  }

  /** GET /api/tools/stocks —— 我查询过的股票（按 symbol 最新一条） */
  @Get('stocks')
  stockList(@Request() req) {
    // 进入程序时懒补算：15:00 没结算成功的持仓在此自愈（不阻塞返回）
    void this.holdings.settleForUser(req.user.id);
    return this.stock.list(req.user.id);
  }

  /** GET /api/tools/stocks/:symbol —— 某股票保存的完整分析 + 历史 */
  @Get('stocks/:symbol')
  stockSaved(@Request() req, @Param('symbol') symbol: string) {
    return this.stock.getSaved(req.user.id, symbol);
  }

  /** GET /api/tools/stock?q=AAPL —— 查询/更新：取最新数据 + 分析，存快照 */
  @Get('stock')
  stockLookup(@Request() req, @Query('q') q?: string) {
    return this.stock.lookup(req.user.id, q ?? '');
  }

  /**
   * POST /api/tools/stocks/:symbol/holding —— 设置持仓
   * {buyPrice, shares, accountId?}（buyPrice/shares ≤0 清空持仓）。
   * 传 accountId 即关联账户，开启每日 15:00 自动结算当日盈亏。
   */
  @Post('stocks/:symbol/holding')
  setHolding(
    @Request() req,
    @Param('symbol') symbol: string,
    @Body()
    body: { buyPrice?: number; shares?: number; accountId?: string | null },
  ) {
    return this.stock.setHolding(
      req.user.id,
      symbol,
      Number(body?.buyPrice) || 0,
      Number(body?.shares) || 0,
      {
        ledgerId: req.user.currentLedgerId ?? null,
        accountId: body?.accountId || null,
      },
    );
  }
}
