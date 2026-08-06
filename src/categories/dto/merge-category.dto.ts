import { IsString } from 'class-validator';

export class MergeCategoryDto {
  /** 合并目标分类 id（系统或本账本自建均可） */
  @IsString()
  targetId: string;
}
