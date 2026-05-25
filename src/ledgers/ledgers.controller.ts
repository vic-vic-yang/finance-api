import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { LedgersService } from './ledgers.service';
import { CreateLedgerDto } from './dto/create-ledger.dto';
import { UpdateLedgerDto } from './dto/update-ledger.dto';
import { JoinLedgerDto } from './dto/join-ledger.dto';

@Controller('ledgers')
@UseGuards(AuthGuard('jwt'))
export class LedgersController {
  constructor(private ledgers: LedgersService) {}

  @Get()
  findAll(@Request() req) {
    return this.ledgers.findAll(req.user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Request() req, @Body() dto: CreateLedgerDto) {
    return this.ledgers.create(req.user.id, dto);
  }

  @Post('switch/:id')
  @HttpCode(HttpStatus.OK)
  switchTo(@Request() req, @Param('id') id: string) {
    return this.ledgers.switchTo(req.user.id, id);
  }

  @Patch(':id')
  update(@Request() req, @Param('id') id: string, @Body() dto: UpdateLedgerDto) {
    return this.ledgers.update(req.user.id, id, dto);
  }

  @Delete(':id')
  remove(@Request() req, @Param('id') id: string) {
    return this.ledgers.remove(req.user.id, id);
  }

  @Post(':id/invite')
  @HttpCode(HttpStatus.CREATED)
  createInvite(@Request() req, @Param('id') id: string) {
    return this.ledgers.createInvite(req.user.id, id);
  }

  @Post('join')
  @HttpCode(HttpStatus.OK)
  join(@Request() req, @Body() dto: JoinLedgerDto) {
    return this.ledgers.join(req.user.id, dto);
  }

  @Get(':id/members')
  listMembers(@Request() req, @Param('id') id: string) {
    return this.ledgers.listMembers(req.user.id, id);
  }

  @Delete(':id/members/:userId')
  removeMember(
    @Request() req,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.ledgers.removeMember(req.user.id, id, userId);
  }
}
