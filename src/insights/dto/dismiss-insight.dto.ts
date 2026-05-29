import { IsString } from 'class-validator';

export class DismissInsightDto {
  @IsString()
  type!: string;

  @IsString()
  target!: string;
}
