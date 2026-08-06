import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { MergeCategoryDto } from './dto/merge-category.dto';

@Controller('categories')
@UseGuards(AuthGuard('jwt'))
export class CategoriesController {
  constructor(private categoriesService: CategoriesService) {}

  @Get()
  findAll(@Request() req) {
    return this.categoriesService.findAll(req.user.currentLedgerId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Request() req, @Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(
      req.user.currentLedgerId,
      req.user.id,
      dto,
    );
  }

  /** 自定义排序：body.orderedIds 为某同级分组按展示顺序排好的分类 id 列表 */
  @Patch('reorder')
  reorder(@Request() req, @Body() body: { orderedIds: string[] }) {
    return this.categoriesService.reorder(
      req.user.currentLedgerId,
      body?.orderedIds ?? [],
    );
  }

  /** 合并自建分类到目标（改挂账单等引用后删除源） */
  @Post(':id/merge')
  merge(
    @Request() req,
    @Param('id') id: string,
    @Body() dto: MergeCategoryDto,
  ) {
    return this.categoriesService.merge(
      req.user.currentLedgerId,
      id,
      dto.targetId,
    );
  }

  @Patch(':id')
  update(@Request() req, @Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(req.user.currentLedgerId, id, dto);
  }

  @Delete(':id')
  remove(@Request() req, @Param('id') id: string) {
    return this.categoriesService.remove(req.user.currentLedgerId, id);
  }
}
