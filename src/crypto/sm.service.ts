import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
// sm-crypto 是纯 JS 的国密实现（SM2/SM3/SM4），符合 GM/T 0003-0004 规范
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sm = require('sm-crypto');

/**
 * 国密算法工具：
 *  - SM2   非对称（包装 DEK、用户公私钥）
 *  - SM3   哈希（恢复码哈希、KDF 内部 PRF）
 *  - SM4   对称（业务数据 ECB→ 我们改用 CBC + HMAC，sm-crypto 提供 CBC）
 *
 * ⚠️ 重要：sm-crypto 的 SM4 不提供 GCM 模式，这里使用 CBC + SM3-HMAC 自封 AEAD 风格。
 *           密文格式 = iv(16) || ciphertext || mac(32)
 */
@Injectable()
export class SmService {
  private readonly logger = new Logger(SmService.name);

  // ── SM2 ──────────────────────────────────────────────────────
  /** 生成 SM2 密钥对，返回十六进制字符串 */
  generateKeyPair(): { publicKey: string; privateKey: string } {
    return sm.sm2.generateKeyPairHex();
  }

  /** SM2 加密。
   *  ⚠️ 重要：跟客户端（dart_sm_new）保持同一线上协议：
   *    传入明文 = 字节流的"十六进制 ASCII 字符串"（例如 b"\xde\xad" → "dead"）
   *    服务端这里就把这个 hex 字符串当 UTF-8 文本喂给 SM2，
   *    客户端 SM2.encrypt(utf8String) 也按 UTF-8 处理，两边一致。
   *  cipherMode=1 = C1C3C2（国标标准） */
  sm2Encrypt(plain: Buffer, publicKeyHex: string): string {
    const hexAsText = plain.toString('hex');
    return sm.sm2.doEncrypt(hexAsText, publicKeyHex, 1);
  }

  /** SM2 解密。明文是"十六进制 ASCII 字符串"，需 hex-decode 回 Buffer */
  sm2Decrypt(cipherHex: string, privateKeyHex: string): Buffer {
    const hexAsText = sm.sm2.doDecrypt(cipherHex, privateKeyHex, 1);
    if (typeof hexAsText !== 'string') {
      throw new Error('SM2 解密失败');
    }
    return Buffer.from(hexAsText, 'hex');
  }

  // ── SM3 ──────────────────────────────────────────────────────
  /** SM3 哈希 */
  sm3(data: Buffer | string): Buffer {
    const inp = typeof data === 'string' ? data : data.toString('hex');
    return Buffer.from(sm.sm3(inp), 'hex');
  }

  /** SM3 HMAC（自封：HMAC = SM3(opad ‖ SM3(ipad ‖ msg)))） */
  sm3Hmac(key: Buffer, msg: Buffer): Buffer {
    const blockSize = 64;
    let k = key;
    if (k.length > blockSize) k = this.sm3(k);
    if (k.length < blockSize) {
      const padded = Buffer.alloc(blockSize);
      k.copy(padded);
      k = padded;
    }
    const ipad = Buffer.alloc(blockSize, 0x36);
    const opad = Buffer.alloc(blockSize, 0x5c);
    for (let i = 0; i < blockSize; i++) {
      ipad[i] ^= k[i];
      opad[i] ^= k[i];
    }
    const inner = this.sm3(Buffer.concat([ipad, msg]));
    return this.sm3(Buffer.concat([opad, inner]));
  }

  /** PBKDF2 但用 SM3 作 PRF；返回指定字节数的密钥 */
  pbkdf2Sm3(password: string, salt: Buffer, iterations: number, dkLen: number): Buffer {
    const pwd = Buffer.from(password, 'utf8');
    const blocks = Math.ceil(dkLen / 32);
    const out = Buffer.alloc(blocks * 32);
    for (let i = 1; i <= blocks; i++) {
      const blockIdx = Buffer.alloc(4);
      blockIdx.writeUInt32BE(i, 0);
      let u = this.sm3Hmac(pwd, Buffer.concat([salt, blockIdx]));
      const t = Buffer.from(u);
      for (let j = 1; j < iterations; j++) {
        u = this.sm3Hmac(pwd, u);
        for (let k = 0; k < 32; k++) t[k] ^= u[k];
      }
      t.copy(out, (i - 1) * 32);
    }
    return out.subarray(0, dkLen);
  }

  // ── SM4 (CBC + SM3-HMAC, AEAD 风格) ─────────────────────────
  /** 生成 SM4 密钥（16 字节） */
  generateSm4Key(): Buffer {
    return crypto.randomBytes(16);
  }

  /** SM4 加密：返回 iv(16) || ciphertext || mac(32) */
  sm4Encrypt(plain: Buffer, key: Buffer): Buffer {
    if (key.length !== 16) throw new Error('SM4 key 必须 16 字节');
    const iv = crypto.randomBytes(16);
    const cipherHex = sm.sm4.encrypt(
      Array.from(plain),
      key.toString('hex'),
      { mode: 'cbc', iv: iv.toString('hex'), output: 'string' },
    );
    const ciphertext = Buffer.from(cipherHex, 'hex');
    const mac = this.sm3Hmac(key, Buffer.concat([iv, ciphertext]));
    return Buffer.concat([iv, ciphertext, mac]);
  }

  /** SM4 解密：输入 iv(16) || ciphertext || mac(32) */
  sm4Decrypt(blob: Buffer, key: Buffer): Buffer {
    if (key.length !== 16) throw new Error('SM4 key 必须 16 字节');
    if (blob.length < 16 + 32) throw new Error('密文长度不合法');
    const iv = blob.subarray(0, 16);
    const ciphertext = blob.subarray(16, blob.length - 32);
    const mac = blob.subarray(blob.length - 32);
    const expected = this.sm3Hmac(key, Buffer.concat([iv, ciphertext]));
    if (!crypto.timingSafeEqual(mac, expected)) {
      throw new Error('SM4 完整性校验失败');
    }
    const plainHex = sm.sm4.decrypt(
      Array.from(ciphertext),
      key.toString('hex'),
      { mode: 'cbc', iv: iv.toString('hex'), output: 'string' },
    );
    return Buffer.from(plainHex, 'hex');
  }

  /** 随机字节工具 */
  random(n: number): Buffer {
    return crypto.randomBytes(n);
  }
}
