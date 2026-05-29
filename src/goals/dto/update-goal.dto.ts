import { Type } from 'class-transformer';
import {
  IsString, IsNumber, IsOptional, Min, IsInt, IsDateString, IsBoolean,
} from 'class-validator';

export class UpdateGoalDto {
  @IsOptional() @IsString() nameCipher?: string;
  @IsOptional() @IsInt() nameDekVer?: number;
  @IsOptional() @IsNumber() @Min(0.01) targetAmount?: number;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsString() accountId?: string;
  @IsOptional() @IsBoolean() @Type(() => Boolean) useExistingBalance?: boolean;
  @IsOptional() @IsDateString() deadline?: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsBoolean() isCompleted?: boolean;
}
