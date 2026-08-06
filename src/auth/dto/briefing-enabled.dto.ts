import { IsBoolean } from 'class-validator';

export class BriefingEnabledDto {
  @IsBoolean()
  enabled: boolean;
}
