import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppUpdateService } from './app-update.service';

/** 公开接口（无需登录）：App 启动时查版本 / 下载安装包。 */
@Controller('app')
export class AppUpdateController {
  constructor(private svc: AppUpdateService) {}

  /** GET /api/app/version —— 最新版本信息 */
  @Get('version')
  version() {
    return this.svc.getVersion();
  }

  /** GET /api/app/download —— 下载最新 APK */
  @Get('download')
  download(@Res({ passthrough: true }) res: Response) {
    return this.svc.getApk(res);
  }
}
