import { IsBoolean } from 'class-validator';

export class SetAutoRuleDto {
  @IsBoolean()
  enabled: boolean;
}
