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
import { LlmResolver, headerLlmCfg } from '../ai/llm/llm-resolver';
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
    private llmResolver: LlmResolver,
  ) {}

  /** BYOK 三层解析；股票场景 LLM 是增强项，解析失败返回 undefined（功能降级不报错） */
  private async tryLlm(req: any) {
    try {
      return await this.llmResolver.resolveText({
        userId: req.user?.id,
        ledgerId: req.user?.currentLedgerId ?? null,
        header: headerLlmCfg(req),
      });
    } catch {
      return undefined;
    }
  }

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

  /** GET /api/tools/holdings/insight —— AI 持仓解读（数据解读+风险提示，无操作建议） */
  @Get('holdings/insight')
  async holdingsInsight(@Request() req, @Query('force') force?: string) {
    const llm = await this.tryLlm(req);
    return this.stock.portfolioInsight(req.user.id, force === '1', llm);
  }

  /** GET /api/tools/holdings/pnl-daily?days=30 —— 组合每日总盈亏 */
  @Get('holdings/pnl-daily')
  pnlDaily(@Request() req, @Query('days') days?: string) {
    return this.holdings.dailyPnl(
      req.user.id,
      days ? parseInt(days, 10) : 30,
    );
  }

  /** GET /api/tools/stocks/:symbol —— 某股票保存的完整分析 + 历史 */
  @Get('stocks/:symbol')
  stockSaved(@Request() req, @Param('symbol') symbol: string) {
    return this.stock.getSaved(req.user.id, symbol);
  }

  /** GET /api/tools/stock?q=AAPL —— 查询/更新：取最新数据 + 分析，存快照 */
  @Get('stock')
  async stockLookup(@Request() req, @Query('q') q?: string) {
    const llm = await this.tryLlm(req);
    return this.stock.lookup(req.user.id, q ?? '', llm);
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
