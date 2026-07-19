import { PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsString } from 'class-validator';
import { CreateBillDto } from './create-bill.dto';

export class UpdateBillDto extends PartialType(CreateBillDto) {
  /**
   * 仅编辑转账账单(isTransfer)时使用：配对腿的目标账户 id。
   * dto.accountId = 被编辑这条腿的账户；toAccountId = 另一条腿的账户。
   */
  @IsOptional()
  @IsString()
  toAccountId?: string;
}
