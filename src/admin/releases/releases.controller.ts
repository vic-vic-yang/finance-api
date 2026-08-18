import {
  BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { randomUUID } from 'crypto';
import { diskStorage } from 'multer';
import * as os from 'os';
import * as path from 'path';
import { AdminGuard } from '../admin.guard';
import { UploadReleaseDto } from './dto/upload-release.dto';
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

  @Get(':id/download')
  download(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    return this.releases.download(id, res);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.releases.get(id);
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('apk', {
    storage: diskStorage({
      destination: os.tmpdir(),
      filename: (_req, _file, callback) => callback(null, `siku-upload-${randomUUID()}.apk`),
    }),
    limits: { fileSize: 200 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
      const valid = path.extname(file.originalname).toLowerCase() === '.apk';
      callback(valid ? null : new BadRequestException('只能上传 APK 文件'), valid);
    },
  }))
  upload(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadReleaseDto,
  ) {
    return this.releases.upload(req.user.id, file, dto);
  }
}
