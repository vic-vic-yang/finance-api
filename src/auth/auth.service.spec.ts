import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

describe('AuthService.deleteAccount', () => {
  it('rejects an incorrect password before checking ledgers or deleting data', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-1',
          password: await bcrypt.hash('correct-password', 4),
        }),
      },
      ledger: { findFirst: jest.fn() },
      ledgerMember: { findFirst: jest.fn() },
      $transaction: jest.fn(),
    };
    const service = new AuthService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.deleteAccount('user-1', 'wrong-password'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.ledger.findFirst).not.toHaveBeenCalled();
    expect(prisma.ledgerMember.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
