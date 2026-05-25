import { IsString, MaxLength, IsOptional } from 'class-validator';

export class UpdateLedgerDto {
  @IsString()
  @IsOptional()
  @MaxLength(20)
  name?: string;

  @IsString()
  @IsOptional()
  icon?: string;
}
