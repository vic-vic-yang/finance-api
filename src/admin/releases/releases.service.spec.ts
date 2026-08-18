import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReleasesService } from './releases.service';

describe('ReleasesService local APK upload', () => {
  let root: string;
  let uploadPath: string;
  const prisma: any = {
    releaseJob: {
      create: jest.fn(async ({ data }) => ({ id: 'job-1', ...data })),
      update: jest.fn(async ({ data }) => ({ id: 'job-1', status: 'succeeded', ...data })),
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'siku-release-test-'));
    uploadPath = path.join(root, 'upload.apk');
    fs.writeFileSync(uploadPath, Buffer.from('PK\x03\x04apk'));
    process.env.APP_RELEASE_DIR = path.join(root, 'production');
    process.env.APP_TEST_RELEASE_DIR = path.join(root, 'test');
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.APP_RELEASE_DIR;
    delete process.env.APP_TEST_RELEASE_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('publishes an uploaded production APK atomically', async () => {
    const service = new ReleasesService(prisma);

    const result = await service.upload(
      'admin-1',
      { path: uploadPath, size: fs.statSync(uploadPath).size } as Express.Multer.File,
      { version: '1.2.3', buildNumber: 45, notes: '修复日期问题', releaseType: 'production' },
    );

    const releaseDir = process.env.APP_RELEASE_DIR!;
    expect(fs.existsSync(path.join(releaseDir, 'siku-45.apk'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(releaseDir, 'version.json'), 'utf8'))).toMatchObject({
      version: '1.2.3', buildNumber: 45, apkFile: 'siku-45.apk',
    });
    expect(result).toMatchObject({ status: 'succeeded', downloadUrl: '/api/app/download' });
    expect(fs.existsSync(uploadPath)).toBe(false);
  });

  it('keeps an IP test APK outside the production release directory', async () => {
    const service = new ReleasesService(prisma);

    const result = await service.upload(
      'admin-1',
      { path: uploadPath, size: fs.statSync(uploadPath).size } as Express.Multer.File,
      { version: '1.2.3', buildNumber: 46, notes: '测试包', releaseType: 'ip_test' },
    );

    expect(fs.existsSync(path.join(process.env.APP_TEST_RELEASE_DIR!, 'siku-46.apk'))).toBe(true);
    expect(fs.existsSync(path.join(process.env.APP_RELEASE_DIR!, 'version.json'))).toBe(false);
    expect(result).toMatchObject({ status: 'succeeded', downloadUrl: '/api/admin/releases/job-1/download' });
  });
});
