import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateReleaseDto } from './dto/create-release.dto';
import { GithubActionsClient } from './github-actions.client';
import { bumpVersion, mapGitHubStatus } from './release-state';

@Injectable()
export class ReleasesService {
  private readonly releaseDir = path.join(__dirname, '..', '..', '..', 'app-release');

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubActionsClient,
  ) {}

  async create(userId: string, dto: CreateReleaseDto) {
    const active = await this.prisma.releaseJob.findFirst({
      where: { status: { in: ['queued', 'building', 'uploading'] } },
    });
    if (active) throw new ConflictException('已有发版任务正在执行');

    const current = this.current();
    const job = await this.prisma.releaseJob.create({
      data: {
        version: bumpVersion(current.version, dto.versionBump),
        buildNumber: current.buildNumber + 1,
        versionBump: dto.versionBump,
        releaseType: dto.releaseType,
        notes: dto.notes.trim(),
        createdById: userId,
      },
    });
    try {
      await this.github.dispatch({
        jobId: job.id,
        ...dto,
        version: job.version,
        buildNumber: job.buildNumber,
      });
      return job;
    } catch (error) {
      return this.prisma.releaseJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'GitHub 发版触发失败',
          completedAt: new Date(),
        },
      });
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

  async get(id: string, refresh = true) {
    const job = await this.prisma.releaseJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('发版任务不存在');
    if (!refresh || ['succeeded', 'failed'].includes(job.status)) return job;
    const run = await this.github.findRun(job.id, job.createdAt);
    if (!run) return job;
    const status = mapGitHubStatus(run.status, run.conclusion);
    return this.prisma.releaseJob.update({
      where: { id },
      data: {
        status,
        githubRunId: String(run.id),
        startedAt: job.startedAt || new Date(run.created_at),
        completedAt: ['succeeded', 'failed'].includes(status) ? new Date() : null,
        errorMessage: status === 'failed' ? `GitHub Actions 失败：${run.html_url}` : null,
        downloadUrl:
          status === 'succeeded' && job.releaseType === 'production' ? '/api/app/download' : job.downloadUrl,
      },
    });
  }
}
