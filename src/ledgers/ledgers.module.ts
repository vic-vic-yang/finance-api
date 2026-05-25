import { Module } from '@nestjs/common';
import { LedgersService } from './ledgers.service';
import { LedgersController } from './ledgers.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [LedgersController],
  providers: [LedgersService],
  exports: [LedgersService],
})
export class LedgersModule {}
