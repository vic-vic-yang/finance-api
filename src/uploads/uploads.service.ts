import {
  Injectable,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { isClientAbort } from '../app-update/app-update.service';

/** 凭证图片：存自建服务器 uploads/vouchers/，随机文件名，登录才可读。 */
@Injectable()
export class UploadsService {
  private readonly dir = path.join(__dirname, '..', '..', 'uploads', 'vouchers');

  constructor() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  private static readonly ALLOWED = [
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.gif',
    '.heic',
  ];

  saveVoucher(file: Express.Multer.File): { key: string } {
    const raw = (path.extname(file.originalname || '') || '.jpg').toLowerCase();
    const ext = UploadsService.ALLOWED.includes(raw) ? raw : '.jpg';
    const key = randomUUID().replace(/-/g, '') + ext;
    fs.writeFileSync(path.join(this.dir, key), file.buffer);
    return { key };
  }

  serveVoucher(key: string, res: Response): StreamableFile {
    if (!/^[a-z0-9]+\.(jpg|jpeg|png|webp|gif|heic)$/i.test(key)) {
      throw new NotFoundException();
    }
    const f = path.join(this.dir, key);
    if (!fs.existsSync(f)) throw new NotFoundException('凭证不存在');
    const ext = path.extname(key).slice(1).toLowerCase();
    const mime =
      ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : 'image/jpeg';
    res.set({ 'Content-Type': mime, 'Cache-Control': 'private, max-age=86400' });
    const file = new StreamableFile(fs.createReadStream(f));
    // 客户端取消加载图片很常见，静默处理不刷 ERROR
    file.setErrorHandler((err: any, response: any) => {
      if (!isClientAbort(err) && !response.headersSent) response.statusCode = 500;
      response.end();
    });
    return file;
  }
}
