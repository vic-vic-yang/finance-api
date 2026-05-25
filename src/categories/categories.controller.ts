import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, UseGuards, Request, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

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

  @Patch(':id')
  update(@Request() req, @Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(req.user.currentLedgerId, id, dto);
  }

  @Delete(':id')
  remove(@Request() req, @Param('id') id: string) {
    return this.categoriesService.remove(req.user.currentLedgerId, id);
  }
}
