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
import { LlmResolver, headerLlmCfg } from './llm/llm-resolver';
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
    private readonly llmResolver: LlmResolver,
  ) {}

  /** 三层解析当前请求可用的文本模型（①请求头 ②账本共享 ③服务端白名单） */
  private resolveText(req: any, ledgerId?: string | null) {
    return this.llmResolver.resolveText({
      userId: req.user?.id,
      username: req.user?.username,
      ledgerId: ledgerId ?? req.user?.currentLedgerId ?? null,
      header: headerLlmCfg(req),
    });
  }

  /** 列出可用模型的能力（不对外暴露具体模型名，只给出数量与是否支持视觉） */
  @Get('models')
  listModels() {
    return {
      models: this.llmRegistry
        .list()
        .map((m, i) => ({ id: i + 1, supportsVision: m.supportsVision })),
    };
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
    // BYOK：三层解析（文本必须有，视觉可为空——没有就不支持图片导入）
    const llmText = await this.llmResolver.resolveText({
      userId: req.user?.id,
      username: req.user?.username,
      ledgerId: body.ledgerId,
      header: headerLlmCfg(req),
    });
    const llmVision = await this.llmResolver.resolveVision({
      userId: req.user?.id,
      username: req.user?.username,
      ledgerId: body.ledgerId,
      header: headerLlmCfg(req),
    });
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
      { text: llmText, vision: llmVision },
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
  async parseText(@Req() req: any, @Body() dto: ParseTextDto) {
    const llm = await this.resolveText(req, dto.ledgerId);
    return this.ai.parseText(
      req.user.id,
      dto.ledgerId,
      dto.text,
      dto.accountId,
      dto.prevDraft,
      llm,
    );
  }

  /** 对话式财务查询（多轮 + function calling）*/
  @Post('chat')
  async chat(@Req() req: any, @Body() dto: ChatDto) {
    const llm = await this.resolveText(req, dto.ledgerId);
    return this.chatSvc.chat(
      req.user.id,
      dto.ledgerId,
      dto.message,
      dto.history ?? [],
      llm,
    );
  }

  /** 月报：客户端已聚合数据 → AI 生成中文叙事 */
  @Post('monthly-report')
  async monthlyReport(@Req() req: any, @Body() dto: MonthlyReportDto) {
    const llm = await this.resolveText(req, dto.ledgerId);
    return this.ai.monthlyReport(
      req.user.id,
      dto.ledgerId,
      dto.period,
      dto.aggregates,
      llm,
    );
  }

  // ── BYOK：账本共享 LLM 配置 ───────────────────────────────

  /** 当前账本的共享配置视图（不含 Key）+ 是否允许用服务端默认 */
  @Get('llm-config')
  getLlmConfig(@Req() req: any, @Query('ledgerId') ledgerId?: string) {
    const lid = ledgerId || req.user?.currentLedgerId;
    if (!lid) throw new BadRequestException('缺少 ledgerId');
    return this.llmResolver.getConfigView(lid, req.user.id, req.user?.username);
  }

  /** 保存/更新账本共享配置（Key 加密落库；仅配置者可改） */
  @Post('llm-config')
  putLlmConfig(
    @Req() req: any,
    @Body()
    body: {
      ledgerId?: string;
      provider?: string;
      baseUrl?: string;
      modelId?: string;
      visionModelId?: string | null;
      apiKey?: string;
    },
  ) {
    const lid = body.ledgerId || req.user?.currentLedgerId;
    if (!lid) throw new BadRequestException('缺少 ledgerId');
    if (!body.baseUrl?.trim() || !body.modelId?.trim()) {
      throw new BadRequestException('baseUrl 和 modelId 必填');
    }
    return this.llmResolver.upsertLedgerConfig(lid, req.user.id, {
      provider: body.provider,
      baseUrl: body.baseUrl.trim(),
      modelId: body.modelId.trim(),
      visionModelId: body.visionModelId?.trim() || null,
      apiKey: body.apiKey,
    });
  }

  /** 关闭共享并删除服务器上的 Key（仅配置者） */
  @Delete('llm-config')
  deleteLlmConfig(@Req() req: any, @Query('ledgerId') ledgerId?: string) {
    const lid = ledgerId || req.user?.currentLedgerId;
    if (!lid) throw new BadRequestException('缺少 ledgerId');
    return this.llmResolver.deleteLedgerConfig(lid, req.user.id);
  }

  /** 测试当前配置能否调通（按 ①personal ②ledger ③server 顺序解析后发 1 条微请求） */
  @Post('llm-config/test')
  async testLlm(@Req() req: any, @Body() body: { ledgerId?: string }) {
    const llm = await this.resolveText(req, body?.ledgerId);
    try {
      await llm.model.chat(
        [{ role: 'user', content: '回复"OK"两个字母即可' }],
        { maxTokens: 8 },
      );
      return { ok: true, source: llm.source, model: llm.name };
    } catch (e: any) {
      return {
        ok: false,
        source: llm.source,
        model: llm.name,
        error: String(e?.message ?? e).slice(0, 300),
      };
    }
  }
}
