import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsString, Matches, MaxLength, Min } from 'class-validator';

export class UploadReleaseDto {
  @IsString()
  @Matches(/^\d+\.\d+\.\d+$/)
  version!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  buildNumber!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  notes!: string;

  @IsIn(['ip_test', 'production'])
  releaseType!: 'ip_test' | 'production';
}
