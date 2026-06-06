import { Controller, Get, Post, Param, Body, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CfoService } from './cfo.service';
import { DecideDto } from './dto/decide.dto';

@Controller('cfo')
@UseGuards(AuthGuard('jwt'))
export class CfoController {
  constructor(private cfo: CfoService) {}

  @Get('proposals')
  list(@Request() req) {
    return this.cfo.listAndGenerate(req.user.currentLedgerId, req.user.id);
  }

  @Post('proposals/:id/decide')
  decide(@Request() req, @Param('id') id: string, @Body() dto: DecideDto) {
    return this.cfo.decide(req.user.currentLedgerId, req.user.id, id, dto.action);
  }
}
