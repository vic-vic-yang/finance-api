import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';

@Module({
  imports: [PrismaModule],
  controllers: [LoansController],
  providers: [LoansService],
  exports: [LoansService], // 供 AI 导入复用（导入时归类为借贷的行）
})
export class LoansModule {}
