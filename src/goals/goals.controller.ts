import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GoalsService } from './goals.service';
import { CreateGoalDto } from './dto/create-goal.dto';
import { UpdateGoalDto } from './dto/update-goal.dto';

@Controller('goals')
@UseGuards(AuthGuard('jwt'))
export class GoalsController {
  constructor(private svc: GoalsService) {}

  @Get()
  findAll(@Request() req) {
    return this.svc.findAll(req.user.id, req.user.currentLedgerId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Request() req, @Body() dto: CreateGoalDto) {
    return this.svc.create(req.user.id, req.user.currentLedgerId, dto);
  }

  @Patch(':id')
  update(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: UpdateGoalDto,
  ) {
    return this.svc.update(req.user.id, id, dto);
  }

  @Delete(':id')
  remove(@Request() req, @Param('id') id: string) {
    return this.svc.remove(req.user.id, id);
  }
}
