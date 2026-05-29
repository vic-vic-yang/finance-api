import {
  IsString, IsOptional, MinLength, MaxLength, IsArray, ValidateNested, IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

class ChatTurnDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(4000)
  content!: string;
}

export class ChatDto {
  @IsString()
  ledgerId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatTurnDto)
  history?: ChatTurnDto[];
}
