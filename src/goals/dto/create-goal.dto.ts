import { Type } from 'class-transformer';
import {
  IsString, IsNumber, IsOptional, Min, IsInt, IsDateString, IsBoolean,
} from 'class-validator';

export class CreateGoalDto {
  /** 目标名密文 base64（客户端 SM4 加密）*/
  @IsString()
  nameCipher!: string;

  @IsInt()
  nameDekVer!: number;

  @IsNumber()
  @Min(0.01)
  targetAmount!: number;

  /** 起算日，ISO；不传默认今天（未绑定账户时使用） */
  @IsOptional()
  @IsDateString()
  startDate?: string;

  /** 绑定账户 ID。设置后用账户余额自动计算进度 */
  @IsOptional()
  @IsString()
  accountId?: string;

  /** 绑定账户后是否计入现有余额。true=现有余额算进度，false=从零开始 */
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  useExistingBalance?: boolean;

  @IsOptional()
  @IsDateString()
  deadline?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  color?: string;
}
