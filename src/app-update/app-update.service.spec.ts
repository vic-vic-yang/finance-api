import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Response } from 'express';
import { setApkDownloadHeaders } from './app-update.service';

describe('setApkDownloadHeaders', () => {
  it('includes the APK byte size in Content-Length', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siku-apk-'));
    const apk = path.join(dir, 'siku-33.apk');
    fs.writeFileSync(apk, Buffer.alloc(1234));
    const set = jest.fn();

    try {
      setApkDownloadHeaders({ set } as unknown as Response, apk, 'siku-33.apk');

      expect(set).toHaveBeenCalledWith({
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': 'attachment; filename="siku-33.apk"',
        'Content-Length': '1234',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
