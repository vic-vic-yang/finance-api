import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { AiService } from './ai.service';
import { ChatService } from './chat.service';
import { LlmRegistry } from './llm/llm-registry';
import { ApplyImportDto } from './dto/apply-import.dto';
import { ParseTextDto } from './dto/parse-text.dto';
import { ChatDto } from './dto/chat.dto';
import { MonthlyReportDto } from './dto/monthly-report.dto';

@Controller('ai')
@UseGuards(AuthGuard('jwt'))
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly chatSvc: ChatService,
    private readonly llmRegistry: LlmRegistry,
  ) {}

  /** 列出所有可用模型（前端给用户选） */
  @Get('models')
  listModels() {
    return { models: this.llmRegistry.list() };
  }

  /** 列出账本下的导入记录 */
  @Get('imports')
  list(@Req() req: any, @Query('ledgerId') ledgerId?: string) {
    if (!ledgerId) {
      throw new BadRequestException('缺少 ledgerId 查询参数');
    }
    return this.ai.listImports(req.user.id, ledgerId);
  }

  /** 单条详情（含 drafts，可前端审查） */
  @Get('imports/:id')
  get(@Req() req: any, @Param('id') id: string) {
    return this.ai.getImport(req.user.id, id);
  }

  /** 上传文件 */
  @Post('imports')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
    }),
  )
  async create(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { ledgerId?: string; accountId?: string; modelName?: string },
  ) {
    if (!file) throw new BadRequestException('请上传文件 (form field: file)');
    if (!body.ledgerId) throw new BadRequestException('缺少 ledgerId');
    if (!body.accountId) throw new BadRequestException('缺少 accountId（请选目标账户）');
    // multer 默认按 latin1 解 originalname，中文文件名会变 "æµ‹è¯•.csv" 这种乱码。
    // 浏览器/Android 上传的 form-data 实际编码是 UTF-8，所以 latin1 → utf8 还原。
    const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return this.ai.createImport(
      req.user.id,
      body.ledgerId,
      body.accountId,
      {
        originalname: filename,
        size: file.size,
        buffer: file.buffer,
        mimetype: file.mimetype,
      },
      body.modelName,
    );
  }

  /** 客户端把加密好的 bills 提交回来入库 */
  @Post('imports/:id/apply')
  apply(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: ApplyImportDto,
  ) {
    return this.ai.applyImport(req.user.id, id, dto);
  }

  @Delete('imports/:id')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.ai.deleteImport(req.user.id, id);
  }

  /** NL 文本解析：一句话 → 单条草稿（前端再加密入库走普通 createBill）*/
  @Post('parse-text')
  parseText(@Req() req: any, @Body() dto: ParseTextDto) {
    return this.ai.parseText(
      req.user.id,
      dto.ledgerId,
      dto.text,
      dto.accountId,
      dto.prevDraft,
    );
  }

  /** 对话式财务查询（多轮 + function calling）*/
  @Post('chat')
  chat(@Req() req: any, @Body() dto: ChatDto) {
    return this.chatSvc.chat(
      req.user.id,
      dto.ledgerId,
      dto.message,
      dto.history ?? [],
    );
  }

  /** 月报：客户端已聚合数据 → AI 生成中文叙事 */
  @Post('monthly-report')
  monthlyReport(@Req() req: any, @Body() dto: MonthlyReportDto) {
    return this.ai.monthlyReport(
      req.user.id,
      dto.ledgerId,
      dto.period,
      dto.aggregates,
    );
  }
}
