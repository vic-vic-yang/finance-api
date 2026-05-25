import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { BudgetsService } from './budgets.service';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';

@Controller('budgets')
@UseGuards(AuthGuard('jwt'))
export class BudgetsController {
  constructor(private budgetsService: BudgetsService) {}

  @Get()
  findAll(@Request() req) {
    return this.budgetsService.findAll(req.user.currentLedgerId);
  }

  /**
   * 历史执行：返回最近 N 个周期（默认 12 个月）每个周期的预算/实际/超支项。
   * Query:
   *  - period: MONTHLY | YEARLY，默认 MONTHLY
   *  - count: 1~36，默认 12
   */
  @Get('history')
  findHistory(
    @Request() req,
    @Query('period') period?: string,
    @Query('count') count?: string,
  ) {
    const p = period === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
    const n = count ? parseInt(count, 10) : 12;
    return this.budgetsService.findHistory(req.user.currentLedgerId, p, n);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Request() req, @Body() dto: CreateBudgetDto) {
    return this.budgetsService.create(req.user.currentLedgerId, dto);
  }

  @Patch(':id')
  update(@Request() req, @Param('id') id: string, @Body() dto: UpdateBudgetDto) {
    return this.budgetsService.update(req.user.currentLedgerId, id, dto);
  }

  @Delete(':id')
  remove(@Request() req, @Param('id') id: string) {
    return this.budgetsService.remove(req.user.currentLedgerId, id);
  }
}
