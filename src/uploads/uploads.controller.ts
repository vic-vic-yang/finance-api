import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { UploadsService } from './uploads.service';

@Controller('uploads')
@UseGuards(AuthGuard('jwt'))
export class UploadsController {
  constructor(private svc: UploadsService) {}

  /** POST /api/uploads/voucher (form field: file) → { key } */
  @Post('voucher')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 12 * 1024 * 1024 } }),
  )
  upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('请上传图片 (form field: file)');
    return this.svc.saveVoucher(file);
  }

  /** GET /api/uploads/voucher/:key → 图片 */
  @Get('voucher/:key')
  serve(@Param('key') key: string, @Res({ passthrough: true }) res: Response) {
    return this.svc.serveVoucher(key, res);
  }
}
