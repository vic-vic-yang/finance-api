import { ConflictException } from '@nestjs/common';
import { ReleasesService } from './releases.service';

describe('ReleasesService', () => {
  const prisma: any = {
    releaseJob: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  };
  const github: any = { dispatch: jest.fn() };
  const service = new ReleasesService(prisma, github);

  beforeEach(() => jest.clearAllMocks());

  it('rejects a second active release', async () => {
    prisma.releaseJob.findFirst.mockResolvedValue({ id: 'active' });
    await expect(
      service.create('admin-1', { notes: '修复问题', versionBump: 'patch', releaseType: 'ip_test' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('marks a job failed when GitHub dispatch fails', async () => {
    prisma.releaseJob.findFirst.mockResolvedValue(null);
    prisma.releaseJob.create.mockResolvedValue({ id: 'job-1', version: '1.0.1', buildNumber: 2 });
    github.dispatch.mockRejectedValue(new Error('github unavailable'));
    prisma.releaseJob.update.mockResolvedValue({ id: 'job-1', status: 'failed' });

    const result = await service.create('admin-1', {
      notes: '修复问题',
      versionBump: 'patch',
      releaseType: 'ip_test',
    });

    expect(result.status).toBe('failed');
    expect(prisma.releaseJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'job-1' }, data: expect.objectContaining({ status: 'failed' }) }),
    );
  });
});
