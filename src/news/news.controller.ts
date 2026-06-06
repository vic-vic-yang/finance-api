import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { NewsService } from './news.service';

@Controller('news')
@UseGuards(AuthGuard('jwt'))
export class NewsController {
  constructor(private news: NewsService) {}

  /** GET /api/news?limit=50 —— 返回最新财经新闻；顺手按需补抓（不阻塞响应） */
  @Get()
  async list(@Query('limit') limit?: string) {
    // 后台按需补抓：若数据陈旧则抓一次，但不让本次请求干等
    this.news.ensureFresh().catch(() => {});
    const n = limit ? parseInt(limit, 10) : 50;
    const articles = await this.news.list(Number.isNaN(n) ? 50 : n);
    return { articles };
  }

  /** POST /api/news/refresh —— 强制立即抓取（下拉刷新用） */
  @Post('refresh')
  async refresh() {
    const inserted = await this.news.refresh();
    const articles = await this.news.list(100);
    return { inserted, articles };
  }

  /** GET /api/news/:id —— 详情：抓正文 + LLM 要点分析（懒加载缓存） */
  @Get(':id')
  async detail(@Param('id') id: string) {
    const article = await this.news.detail(id);
    if (!article) throw new NotFoundException('新闻不存在');
    return { article };
  }
}
