import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { BillsService } from './bills.service';
import { CreateBillDto } from './dto/create-bill.dto';
import { UpdateBillDto } from './dto/update-bill.dto';
import { ConvertBillDto } from './dto/convert-bill.dto';
import { QueryBillDto } from './dto/query-bill.dto';

@Controller('bills')
@UseGuards(AuthGuard('jwt'))
export class BillsController {
  constructor(private billsService: BillsService) {}

  @Get()
  findAll(@Request() req, @Query() query: QueryBillDto) {
    return this.billsService.findAll(req.user.currentLedgerId, query);
  }

  @Get(':id')
  findOne(@Request() req, @Param('id') id: string) {
    return this.billsService.findOne(req.user.currentLedgerId, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Request() req, @Body() dto: CreateBillDto) {
    return this.billsService.create(
      req.user.currentLedgerId,
      req.user.id,
      dto,
    );
  }

  @Put(':id')
  update(@Request() req, @Param('id') id: string, @Body() dto: UpdateBillDto) {
    return this.billsService.update(
      req.user.currentLedgerId,
      req.user.id,
      id,
      dto,
    );
  }

  /** 把一条普通账单转为「借贷」或「账户间转账」 */
  @Post(':id/convert')
  convert(@Request() req, @Param('id') id: string, @Body() dto: ConvertBillDto) {
    return this.billsService.convert(
      req.user.currentLedgerId,
      req.user.id,
      id,
      dto,
    );
  }

  @Delete(':id')
  remove(@Request() req, @Param('id') id: string) {
    return this.billsService.remove(req.user.currentLedgerId, id);
  }
}
