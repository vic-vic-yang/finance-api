import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminGuard } from '../admin.guard';
import { CreateReleaseDto } from './dto/create-release.dto';
import { ReleasesService } from './releases.service';

@Controller('admin/releases')
@UseGuards(AuthGuard('jwt'), AdminGuard)
export class ReleasesController {
  constructor(private readonly releases: ReleasesService) {}

  @Get()
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.releases.list(page ? Number(page) : 1, pageSize ? Number(pageSize) : 20);
  }

  @Get('current')
  current() {
    return this.releases.current();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.releases.get(id);
  }

  @Post()
  create(@Req() req: any, @Body() dto: CreateReleaseDto) {
    return this.releases.create(req.user.id, dto);
  }

  @Post(':id/refresh')
  refresh(@Param('id') id: string) {
    return this.releases.get(id, true);
  }
}
