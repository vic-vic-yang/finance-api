import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateProfileDto {
  /// 昵称：1~20 字符；传空字符串表示清除昵称（回退到 username）
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: '昵称最多20个字符' })
  nickname?: string;
}
