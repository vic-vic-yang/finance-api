import { IsString, IsNotEmpty, Length } from 'class-validator';

export class JoinLedgerDto {
  @IsString()
  @IsNotEmpty({ message: '请输入邀请码' })
  @Length(6, 6, { message: '邀请码应为 6 位' })
  code: string;
}
