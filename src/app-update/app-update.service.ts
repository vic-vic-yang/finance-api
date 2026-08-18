import { Injectable, Logger, NotFoundException, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

/**
 * App 自助升级：发布脚本把新 APK 拷到 backend/app-release/ 并写 version.json，
 * 这里对外提供「查最新版本」与「下载安装包」。基于自建服务器（Cloudflare Tunnel）。
 */
@Injectable()
export class AppUpdateService {
  private readonly logger = new Logger('AppUpdateService');
  // backend/dist/app-update -> ../../app-release = backend/app-release（dev 同理）
  private readonly dir = path.join(__dirname, '..', '..', 'app-release');

  getVersion() {
    const f = path.join(this.dir, 'version.json');
    if (!fs.existsSync(f)) {
      return { buildNumber: 0, version: '0.0.0', notes: '', apkFile: null };
    }
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      return {
        buildNumber: Number(j.buildNumber) || 0,
        version: String(j.version || '0.0.0'),
        notes: String(j.notes || ''),
        apkFile: j.apkFile || null,
        publishedAt: j.publishedAt || null,
      };
    } catch (e) {
      this.logger.warn(`读取 version.json 失败：${(e as Error).message}`);
      return { buildNumber: 0, version: '0.0.0', notes: '', apkFile: null };
    }
  }

  getApk(res: Response): StreamableFile {
    const info = this.getVersion();
    if (!info.apkFile) throw new NotFoundException('暂无可下载的安装包');
    const apk = path.join(this.dir, info.apkFile);
    if (!fs.existsSync(apk)) throw new NotFoundException('安装包文件不存在');
    setApkDownloadHeaders(res, apk, info.apkFile);
    const file = new StreamableFile(fs.createReadStream(apk));
    // 大包走隧道，客户端中途断开很常见——静默处理，别当 ERROR 刷屏
    file.setErrorHandler((err: any, response: any) => {
      if (isClientAbort(err)) {
        response.end();
        return;
      }
      this.logger.warn(`APK 下载流错误：${err?.message}`);
      if (!response.headersSent) response.statusCode = 500;
      response.end();
    });
    return file;
  }
}

export function setApkDownloadHeaders(res: Response, apk: string, apkFile: string) {
  res.set({
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Disposition': `attachment; filename="${apkFile}"`,
    'Content-Length': String(fs.statSync(apk).size),
  });
}

/** 客户端主动断开（下载中断/取消），属正常现象，不该记 ERROR */
export function isClientAbort(err: any): boolean {
  const code = err?.code;
  return (
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ERR_STREAM_DESTROYED'
  );
}
