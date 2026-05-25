import { IsString, IsEnum, IsOptional } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  name: string;

  @IsEnum(['income', 'expense'], { message: '类型只能是 income 或 expense' })
  type: 'income' | 'expense';

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  color?: string;

  /** 父分类 id（可选）—— 不填即为一级分类 */
  @IsOptional()
  @IsString()
  parentId?: string;
}
