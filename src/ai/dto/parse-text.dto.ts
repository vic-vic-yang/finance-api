import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';

export class ParseTextDto {
  @IsString()
  ledgerId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  text!: string;

  /** 用户当前默认账户 id；可空，AI 解析时会回填到草稿里 */
  @IsOptional()
  @IsString()
  accountId?: string;

  /** 上一笔的草稿（会话上下文）：accountId / type / date 可继承 */
  @IsOptional()
  prevDraft?: {
    accountId?: string;
    type?: string;
    date?: string;
  };
}
