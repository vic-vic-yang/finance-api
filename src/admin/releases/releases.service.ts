import { BadRequestException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadReleaseDto } from './dto/upload-release.dto';

@Injectable()
export class ReleasesService {
  constructor(private readonly prisma: PrismaService) {}

  private get releaseDir() {
    return process.env.APP_RELEASE_DIR || path.join(__dirname, '..', '..', '..', 'app-release');
  }

  private get testReleaseDir() {
    return process.env.APP_TEST_RELEASE_DIR || path.join(__dirname, '..', '..', '..', 'test-releases');
  }

  async upload(userId: string, file: Express.Multer.File | undefined, dto: UploadReleaseDto) {
    if (!file) throw new BadRequestException('请选择 APK 文件');
    try {
      this.assertApk(file.path);
      const current = this.current();
      if (dto.releaseType === 'production' && dto.buildNumber <= current.buildNumber) {
        throw new BadRequestException(`正式包构建号必须大于当前线上构建号 ${current.buildNumber}`);
      }

      const targetDir = dto.releaseType === 'production' ? this.releaseDir : this.testReleaseDir;
      fs.mkdirSync(targetDir, { recursive: true });
      const apkFile = `siku-${dto.buildNumber}.apk`;
      this.atomicCopy(file.path, path.join(targetDir, apkFile));

      const publishedAt = new Date();
      if (dto.releaseType === 'production') {
        this.atomicWriteJson(path.join(targetDir, 'version.json'), {
          version: dto.version,
          buildNumber: dto.buildNumber,
          apkFile,
          notes: dto.notes.trim(),
          publishedAt: publishedAt.toISOString(),
        });
      }
      this.cleanupOldApks(targetDir);

      const job = await this.prisma.releaseJob.create({
        data: {
          version: dto.version,
          buildNumber: dto.buildNumber,
          versionBump: 'upload',
          releaseType: dto.releaseType,
          notes: dto.notes.trim(),
          status: 'succeeded',
          apkFile,
          apkSize: file.size,
          downloadUrl: dto.releaseType === 'production' ? '/api/app/download' : null,
          createdById: userId,
          startedAt: publishedAt,
          completedAt: publishedAt,
        },
      });
      if (dto.releaseType === 'production') return job;
      return this.prisma.releaseJob.update({
        where: { id: job.id },
        data: { downloadUrl: `/api/admin/releases/${job.id}/download` },
      });
    } finally {
      if (file?.path) fs.rmSync(file.path, { force: true });
    }
  }

  async list(page = 1, pageSize = 20) {
    const skip = (Math.max(page, 1) - 1) * pageSize;
    const [items, total] = await Promise.all([
      this.prisma.releaseJob.findMany({
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { createdBy: { select: { id: true, username: true, nickname: true } } },
      }),
      this.prisma.releaseJob.count(),
    ]);
    return { items, total, page: Math.max(page, 1), pageSize };
  }

  current() {
    const file = path.join(this.releaseDir, 'version.json');
    if (!fs.existsSync(file)) return { version: '0.0.0', buildNumber: 0, apkFile: null };
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...value, version: String(value.version || '0.0.0'), buildNumber: Number(value.buildNumber) || 0 };
    } catch {
      return { version: '0.0.0', buildNumber: 0, apkFile: null };
    }
  }

  async get(id: string) {
    const job = await this.prisma.releaseJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('发版记录不存在');
    return job;
  }

  async download(id: string, res: Response) {
    const job = await this.get(id);
    if (!job.apkFile) throw new NotFoundException('安装包不存在');
    const dir = job.releaseType === 'production' ? this.releaseDir : this.testReleaseDir;
    const file = path.join(dir, path.basename(job.apkFile));
    if (!fs.existsSync(file)) throw new NotFoundException('安装包文件不存在');
    res.set({
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="${path.basename(job.apkFile)}"`,
    });
    return new StreamableFile(fs.createReadStream(file));
  }

  private assertApk(file: string) {
    const fd = fs.openSync(file, 'r');
    try {
      const header = Buffer.alloc(4);
      fs.readSync(fd, header, 0, 4, 0);
      if (!header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        throw new BadRequestException('文件不是有效的 APK');
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private atomicCopy(source: string, target: string) {
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.copyFileSync(source, temp);
    fs.renameSync(temp, target);
  }

  private atomicWriteJson(target: string, value: unknown) {
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2));
    fs.renameSync(temp, target);
  }

  private cleanupOldApks(dir: string) {
    const files = fs.readdirSync(dir)
      .filter((name) => /^siku-\d+\.apk$/.test(name))
      .map((name) => ({ name, modifiedAt: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
    for (const file of files.slice(5)) fs.rmSync(path.join(dir, file.name), { force: true });
  }
}
