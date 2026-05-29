import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RecurringService } from './recurring.service';
import { CreateRecurringDto } from './dto/create-recurring.dto';
import { UpdateRecurringDto } from './dto/update-recurring.dto';

@Controller('recurring')
@UseGuards(AuthGuard('jwt'))
export class RecurringController {
  constructor(private svc: RecurringService) {}

  /** AI 检测出的候选（不入库，前端展示供用户确认） */
  @Get('candidates')
  candidates(@Request() req) {
    return this.svc.candidates(req.user.id, req.user.currentLedgerId);
  }

  /** 当前账本已确认的周期账单 */
  @Get()
  findAll(@Request() req) {
    return this.svc.findAll(req.user.id, req.user.currentLedgerId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Request() req, @Body() dto: CreateRecurringDto) {
    return this.svc.create(req.user.id, req.user.currentLedgerId, dto);
  }

  @Patch(':id')
  update(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: UpdateRecurringDto,
  ) {
    return this.svc.update(req.user.id, req.user.currentLedgerId, id, dto);
  }

  @Delete(':id')
  remove(@Request() req, @Param('id') id: string) {
    return this.svc.remove(req.user.id, req.user.currentLedgerId, id);
  }
}
