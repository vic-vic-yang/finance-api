import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateReleaseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  notes!: string;

  @IsIn(['patch', 'minor', 'major'])
  versionBump!: 'patch' | 'minor' | 'major';

  @IsIn(['ip_test', 'production'])
  releaseType!: 'ip_test' | 'production';
}
