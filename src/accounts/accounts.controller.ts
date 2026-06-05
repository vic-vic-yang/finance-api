import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { TransferDto } from './dto/transfer.dto';
import { ReconcileDto } from './dto/reconcile.dto';

@Controller('accounts')
@UseGuards(AuthGuard('jwt'))
export class AccountsController {
  constructor(private accountsService: AccountsService) {}

  /**
   * 列出账户。
   * 默认（无 scope）：只返回当前用户可用的账户（共享 + 自己的私人）。
   * scope=all：返回当前账本下的所有账户（用于转账目的地选择），
   *           他人私人账户会返回但 balance 被隐藏（balanceVisible=false）。
   */
  @Get()
  findAll(@Request() req, @Query('scope') scope?: string) {
    return this.accountsService.findAll(
      req.user.currentLedgerId,
      req.user.id,
      scope === 'all' ? 'all' : 'mine',
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Request() req, @Body() dto: CreateAccountDto) {
    return this.accountsService.create(
      req.user.currentLedgerId,
      req.user.id,
      dto,
    );
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  transfer(@Request() req, @Body() dto: TransferDto) {
    return this.accountsService.transfer(
      req.user.currentLedgerId,
      req.user.id,
      dto,
    );
  }

  @Post(':id/reconcile')
  @HttpCode(HttpStatus.OK)
  reconcile(@Request() req, @Param('id') id: string, @Body() dto: ReconcileDto) {
    return this.accountsService.reconcile(
      req.user.currentLedgerId,
      req.user.id,
      id,
      dto,
    );
  }

  @Patch(':id')
  update(@Request() req, @Param('id') id: string, @Body() dto: UpdateAccountDto) {
    return this.accountsService.update(
      req.user.currentLedgerId,
      req.user.id,
      id,
      dto,
    );
  }

  @Delete(':id')
  remove(@Request() req, @Param('id') id: string) {
    return this.accountsService.remove(
      req.user.currentLedgerId,
      req.user.id,
      id,
    );
  }
}
