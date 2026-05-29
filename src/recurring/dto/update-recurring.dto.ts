import {
  IsString, IsNumber, IsInt, IsOptional, IsIn, IsBoolean, Min, Max,
} from 'class-validator';

export class UpdateRecurringDto {
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() accountId?: string;
  @IsOptional() @IsIn(['expense', 'income']) type?: 'expense' | 'income';
  @IsOptional() @IsNumber() @Min(0.01) amount?: number;
  @IsOptional() @IsString() noteCipher?: string;
  @IsOptional() @IsInt() noteDekVer?: number;
  @IsOptional() @IsIn(['monthly', 'weekly', 'yearly']) cycleType?: 'monthly' | 'weekly' | 'yearly';
  @IsOptional() @IsInt() @Min(1) @Max(1231) cycleDay?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
