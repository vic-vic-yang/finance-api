import { IsNumber, IsBase64, IsInt, IsOptional } from 'class-validator';

export class ReconcileDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  actualBalance: number;

  @IsBase64()
  @IsOptional()
  noteCipher?: string;

  @IsInt()
  @IsOptional()
  noteDekVer?: number;
}
