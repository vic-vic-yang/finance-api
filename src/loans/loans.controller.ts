import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { LoansService } from './loans.service';
import { CreateLoanDto, RepayLoanDto, UpdateLoanDto } from './loans.dto';

@Controller('loans')
@UseGuards(AuthGuard('jwt'))
export class LoansController {
  constructor(private loans: LoansService) {}

  /** GET /api/loans —— 当前账本所有借贷记录 */
  @Get()
  list(@Request() req) {
    return this.loans.list(req.user.currentLedgerId);
  }

  /** GET /api/loans/summary —— 总应收 / 总应付 */
  @Get('summary')
  summary(@Request() req) {
    return this.loans.summary(req.user.currentLedgerId);
  }

  /** POST /api/loans —— 新建借出/借入 */
  @Post()
  create(@Request() req, @Body() dto: CreateLoanDto) {
    return this.loans.create(req.user.currentLedgerId, req.user.id, dto);
  }

  /** POST /api/loans/:id/repay —— 记还款/收款 */
  @Post(':id/repay')
  repay(@Request() req, @Param('id') id: string, @Body() dto: RepayLoanDto) {
    return this.loans.repay(req.user.currentLedgerId, req.user.id, id, dto);
  }

  /** PATCH /api/loans/:id —— 编辑金额/备注/日期/凭证 */
  @Patch(':id')
  update(@Request() req, @Param('id') id: string, @Body() dto: UpdateLoanDto) {
    return this.loans.update(req.user.currentLedgerId, id, dto);
  }

  /** DELETE /api/loans/:id */
  @Delete(':id')
  remove(@Request() req, @Param('id') id: string) {
    return this.loans.remove(req.user.currentLedgerId, id);
  }
}
