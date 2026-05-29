import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';
import { LlmRegistry } from './llm/llm-registry';
import {
  ChatMessage,
  ChatModel,
  MessagePart,
} from './llm/chat-model';
import {
  Extractor,
  ExtractedInput,
  detectFileType,
  MAX_LLM_INPUT_CHARS,
} from './extractors/extractor';
import { ImageExtractor } from './extractors/image.extractor';
import { PdfExtractor } from './extractors/pdf.extractor';
import { CsvExtractor } from './extractors/csv.extractor';
import { XlsxExtractor } from './extractors/xlsx.extractor';
import { TextExtractor } from './extractors/text.extractor';

/** AI 返回的单条草稿（明文，等客户端加密入库）。
 *  categoryId / accountId 在 _process 阶段就解析好，
 *  客户端只需要本地加密 note 后 POST apply。 */
export interface AiDraft {
  type: 'expense' | 'income';
  amount: number;
  categoryName: string; // AI 原始返回（保留作 fallback / 显示）
  categoryId: string;   // 服务端解析好的，可能是二级或新建的"其他"
  accountId: string;    // 用户上传时选定，所有草稿共用
  note: string;
  date: string; // ISO 8601
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly extractors: Extractor[] = [
    new ImageExtractor(),
    new PdfExtractor(),
    new CsvExtractor(),
    new XlsxExtractor(),
    new TextExtractor(),
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgers: LedgersService,
    private readonly llmRegistry: LlmRegistry,
  ) {}

  // ── 列表 / 详情 / 删除 ──────────────────────────────────────

  async listImports(userId: string, ledgerId: string) {
    await this.ledgers.ensureMembership(userId, ledgerId);
    const items = await this.prisma.aiImport.findMany({
      where: { ledgerId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { imports: items.map(this.serialize) };
  }

  async getImport(userId: string, id: string, includeDrafts = true) {
    const item = await this.prisma.aiImport.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('导入记录不存在');
    await this.ledgers.ensureMembership(userId, item.ledgerId);
    if (item.userId !== userId) {
      // 同账本成员可以看到导入记录，但只有上传者能拉草稿（草稿是 ta 的明文）
      includeDrafts = false;
    }
    return {
      import: this.serialize(item),
      drafts: includeDrafts && item.draftsJson
        ? (JSON.parse(item.draftsJson) as AiDraft[])
        : undefined,
    };
  }

  // ── NL 文本解析（POST /api/ai/parse-text）─────────────────

  /**
   * 把用户输入的一句自然语言（如 "中午湘菜馆180"）解析为单条账单草稿。
   *
   * 返回 { draft: null, error } 表示 LLM 没听懂，前端引导用户改写或手动记。
   *
   * 上下文：客户端可传 prevDraft（上一笔的 accountId/type/date），
   *   缺字段时用它继承 —— "再来一笔 35" 这种 case 就能秒识别。
   */
  async parseText(
    userId: string,
    ledgerId: string,
    text: string,
    accountIdHint?: string,
    prevDraft?: { accountId?: string; type?: string; date?: string },
  ): Promise<{
    draft: {
      type: 'expense' | 'income';
      amount: number;
      categoryId: string;
      categoryName: string;
      accountId: string;
      note: string;
      date: string;
      merchant?: string;
      confidence: number;
    } | null;
    error?: string;
    usage?: { prompt: number; completion: number; total: number };
  }> {
    await this.ledgers.ensureMembership(userId, ledgerId);

    const trimmed = (text || '').trim();
    if (!trimmed) {
      return { draft: null, error: '没有输入内容' };
    }
    if (trimmed.length > 300) {
      return { draft: null, error: '输入过长（>300 字），建议拆成多条' };
    }

    // 1) 拿默认文本模型
    const modelName = this.llmRegistry.defaultTextModelName();
    if (!modelName) {
      return { draft: null, error: '没有可用的 AI 模型（请联系管理员配置）' };
    }
    const model = this.llmRegistry.get(modelName);

    // 2) 准备分类层级 + 默认账户（用于回退）
    const cats = await this.prisma.category.findMany({
      where: { OR: [{ ledgerId }, { isSystem: true }] },
      select: { id: true, name: true, type: true, parentId: true },
    });

    // 候选账户：用户可用的（共享 + 自己的私人）
    let fallbackAccountId = accountIdHint || prevDraft?.accountId;
    if (!fallbackAccountId) {
      const acc = await this.prisma.account.findFirst({
        where: {
          ledgerId,
          OR: [{ ownerId: null }, { ownerId: userId }],
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      fallbackAccountId = acc?.id;
    }
    if (!fallbackAccountId) {
      return { draft: null, error: '当前账本下没有可用账户' };
    }

    // 3) 构 prompt
    const compactHier = this._compactCategoryHier(cats);
    const todayIso = new Date().toISOString().slice(0, 10);
    const sys: ChatMessage = {
      role: 'system',
      content: [
        '你是中文记账助手。从一句话中抽取一笔账单。',
        '规则：',
        '1) 金额支持阿拉伯数字(38) / 中文(三十八) / 口语(三十八块五 → 38.5) / 大写(壹佰 → 100)',
        '2) 类型默认 expense；明确收入语义(工资/报销/红包/到账/收到)用 income',
        `3) 日期默认今天(${todayIso})；"昨天" "前天" "X月X日" "上周X" 自行换算成 ISO8601 (YYYY-MM-DDTHH:mm:ss)`,
        '4) categoryName 必须从下方候选精确选一个 "一级>二级"；找不到对应二级就只填一级名',
        '5) note 把商户/商品/摘要/事由合并，用 · 分隔；金额词和时间词去掉；无则空串',
        '6) merchant 如果识别出商户名（湘菜馆/瑞幸/滴滴），填进 merchant 字段',
        '7) 你对结果的把握用 confidence 表示 0-1；金额或日期不确定就给低分',
        '8) 严格 JSON，单条：{"type","amount","categoryName","note","date","merchant","confidence"}',
        '',
        `候选支出: ${compactHier.expense}`,
        `候选收入: ${compactHier.income}`,
      ].join('\n'),
    };

    // 4) 上下文提示（如果上一笔有，可以告诉 LLM）
    const userParts: string[] = [trimmed];
    if (prevDraft?.type) {
      userParts.push(`(上一笔是 ${prevDraft.type})`);
    }
    const userMsg: ChatMessage = { role: 'user', content: userParts.join(' ') };

    // 5) 调 LLM
    let res;
    try {
      res = await model.chat([sys, userMsg], {
        responseFormat: 'json_object',
        temperature: 0.1,
        maxTokens: 512,
      });
    } catch (e) {
      this.logger.error(`parseText LLM 失败: ${e}`);
      return { draft: null, error: 'AI 网络错误，请稍后再试' };
    }

    // 6) 解析 JSON
    const raw = res.content || '';
    const parsed = tryParseLooseJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      this.logger.warn(`parseText JSON 解析失败: ${raw.slice(0, 300)}`);
      return {
        draft: null,
        error: '没听懂这句话，请换种说法或手动记账',
        usage: res.usage,
      };
    }

    // 兼容包了一层 {bill: {...}} 的返回
    const o = parsed.bill ?? parsed;
    const amount = Number(o?.amount);
    if (!isFinite(amount) || amount <= 0) {
      return {
        draft: null,
        error: '没识别出金额，请明确说出多少钱',
        usage: res.usage,
      };
    }
    const type: 'expense' | 'income' =
      o?.type === 'income' ? 'income' : 'expense';
    const date = parseDate(o?.date) ?? new Date().toISOString();
    const categoryName = String(o?.categoryName || '').trim() || '其他';
    const note = String(o?.note || '').trim();
    const merchant = String(o?.merchant || '').trim();
    const confidence = Math.max(
      0,
      Math.min(1, Number(o?.confidence) || 0.5),
    );

    // 7) 解析 categoryId（含 note 关键词兜底）
    const categoryId = await this._resolveCategoryId(
      ledgerId,
      categoryName,
      type,
      note + ' ' + merchant,
    );

    return {
      draft: {
        type,
        amount,
        categoryId,
        categoryName,
        accountId: fallbackAccountId,
        note,
        date,
        merchant: merchant || undefined,
        confidence,
      },
      usage: res.usage,
    };
  }

  /** 把分类列表压缩成 "餐饮[早餐,午餐] 交通[打车,公交]" 的短文本，供 NL prompt 用 */
  private _compactCategoryHier(
    cats: { id: string; name: string; type: string; parentId: string | null }[],
  ): { expense: string; income: string } {
    const build = (t: string) => {
      const l1s = cats.filter((c) => c.type === t && !c.parentId);
      const out: string[] = [];
      for (const l1 of l1s) {
        const children = cats.filter(
          (c) => c.type === t && c.parentId === l1.id,
        );
        if (children.length === 0) {
          out.push(l1.name);
        } else {
          out.push(`${l1.name}[${children.map((c) => c.name).join(',')}]`);
        }
      }
      return out.join(' ');
    };
    return { expense: build('expense'), income: build('income') };
  }

  // ── 月报生成（通路 B：客户端聚合，服务端只生成文案）────

  /**
   * 客户端把上月所有账单解密 + 本地聚合后送上来；服务端调 LLM 生成自然语言报告。
   * 服务端不存任何明细聚合，流过即焚。
   */
  async monthlyReport(
    userId: string,
    ledgerId: string,
    period: { year: number; month: number },
    aggregates: {
      income: number;
      expense: number;
      byCategory: { categoryId: string; name: string; amount: number; count?: number }[];
      byMerchant?: { merchant: string; amount: number; count?: number }[];
      byWeek?: { week: string; amount: number }[];
      budgetExec?: { categoryName: string; used: number; limit: number }[];
    },
  ): Promise<{
    narrative: string;
    highlights: { icon: string; text: string }[];
    usage?: { prompt: number; completion: number; total: number };
    error?: string;
  }> {
    await this.ledgers.ensureMembership(userId, ledgerId);

    // 规则层：先算几条关键 highlights（无 LLM）
    const highlights: { icon: string; text: string }[] = [];
    const savingRate =
      aggregates.income > 0
        ? (aggregates.income - aggregates.expense) / aggregates.income
        : 0;
    highlights.push({
      icon: '💰',
      text: `结余 ¥${(aggregates.income - aggregates.expense).toFixed(0)}（结余率 ${(savingRate * 100).toFixed(0)}%）`,
    });
    if (aggregates.byCategory.length > 0) {
      const top = [...aggregates.byCategory].sort((a, b) => b.amount - a.amount)[0];
      const pct =
        aggregates.expense > 0
          ? (top.amount / aggregates.expense) * 100
          : 0;
      highlights.push({
        icon: '🏆',
        text: `花最多的：${top.name} ¥${top.amount.toFixed(0)}（占 ${pct.toFixed(0)}%）`,
      });
    }
    if (aggregates.budgetExec && aggregates.budgetExec.length > 0) {
      const over = aggregates.budgetExec.filter((b) => b.used > b.limit);
      if (over.length > 0) {
        highlights.push({
          icon: '⚠️',
          text: `${over.length} 个分类超预算`,
        });
      } else {
        highlights.push({ icon: '✅', text: '所有预算都在执行范围内' });
      }
    }

    // 生成层：交给 LLM 写叙事文案
    const modelName = this.llmRegistry.defaultTextModelName();
    if (!modelName) {
      return {
        narrative: '（未配置 AI 模型，仅显示数据）',
        highlights,
        error: 'no_model',
      };
    }
    const model = this.llmRegistry.get(modelName);

    // 把聚合压成短文本送给 LLM
    const topCats = [...aggregates.byCategory]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 8)
      .map(
        (c) =>
          `${c.name}=${c.amount.toFixed(0)}${c.count ? `(${c.count}笔)` : ''}`,
      )
      .join(' ');
    const topMerchants =
      aggregates.byMerchant && aggregates.byMerchant.length > 0
        ? aggregates.byMerchant
            .slice(0, 5)
            .map((m) => `${m.merchant}=${m.amount.toFixed(0)}`)
            .join(' ')
        : '';
    const budgetText =
      aggregates.budgetExec && aggregates.budgetExec.length > 0
        ? aggregates.budgetExec
            .map((b) => `${b.categoryName}=${b.used.toFixed(0)}/${b.limit.toFixed(0)}`)
            .join(' ')
        : '';

    const sys: ChatMessage = {
      role: 'system',
      content: [
        '你是中文财务报告写手。根据用户上月的聚合数据写一份 4-6 句中文小结。',
        '要求：',
        '- 语气像朋友聊天，避免说教，避免 emoji 滥用（最多 2-3 个）',
        '- 突出"和上月对比"暂无数据时不要瞎编',
        '- 看到超预算分类必须指出',
        '- 看到 top 商户或 top 分类时点出来',
        '- 最后给 1 条具体可操作的建议',
        '- 不要重复列举所有数字，挑代表性的',
      ].join('\n'),
    };
    const user: ChatMessage = {
      role: 'user',
      content: [
        `周期：${period.year}年${period.month}月`,
        `收入：¥${aggregates.income.toFixed(2)}`,
        `支出：¥${aggregates.expense.toFixed(2)}`,
        `结余率：${(savingRate * 100).toFixed(0)}%`,
        `分类 top：${topCats}`,
        topMerchants ? `商户 top：${topMerchants}` : '',
        budgetText ? `预算：${budgetText}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };

    let res;
    try {
      res = await model.chat([sys, user], {
        temperature: 0.7,
        maxTokens: 800,
      });
    } catch (e) {
      this.logger.warn(`monthlyReport LLM 失败: ${e}`);
      return {
        narrative: '（AI 文案生成失败，请稍后再试）',
        highlights,
        error: String(e),
      };
    }

    return {
      narrative: (res.content || '').trim(),
      highlights,
      usage: res.usage,
    };
  }

  async deleteImport(userId: string, id: string) {
    const item = await this.prisma.aiImport.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('导入记录不存在');
    if (item.userId !== userId) {
      throw new ForbiddenException('只能删除自己发起的导入');
    }
    await this.prisma.aiImport.delete({ where: { id } });
    return { message: '已删除' };
  }

  // ── 创建：上传文件 → 立刻返回 id，后台处理 ────────────────

  async createImport(
    userId: string,
    ledgerId: string,
    accountId: string,
    file: { originalname: string; size: number; buffer: Buffer; mimetype: string },
    modelName?: string,
  ) {
    await this.ledgers.ensureMembership(userId, ledgerId);

    // 校验账户：必须是该账本里 + 用户能用的（共享或自己的私人）
    const account = await this.prisma.account.findFirst({
      where: {
        id: accountId,
        ledgerId,
        OR: [{ ownerId: null }, { ownerId: userId }],
      },
    });
    if (!account) throw new BadRequestException('账户不存在或无权使用');

    const fileType = detectFileType(file.originalname, file.mimetype);
    const finalModel =
      modelName ||
      (fileType === 'image'
        ? this.llmRegistry.defaultVisionModelName()
        : this.llmRegistry.defaultTextModelName());
    if (!finalModel) {
      throw new BadRequestException(
        fileType === 'image'
          ? '没有可用的视觉模型，请在 .env 配置一个支持图片的模型'
          : '没有可用的 AI 模型，请在 .env 配置 DEEPSEEK_API_KEY 或 MIMO_API_KEY',
      );
    }

    const rec = await this.prisma.aiImport.create({
      data: {
        ledgerId,
        userId,
        accountId,
        filename: file.originalname,
        fileType,
        fileSize: file.size,
        modelName: finalModel,
        status: 'pending',
        progress: 0,
      },
    });

    // fire-and-forget 异步处理；任何异常都被 _process 自己捕获写入 errorTrace
    setImmediate(() => {
      this._process(rec.id, file.buffer).catch((e) =>
        this.logger.error(`process ${rec.id} crashed: ${e?.stack || e}`),
      );
    });

    return { import: this.serialize(rec) };
  }

  // ── apply：客户端把加密好的 bills 回填 ────────────────────

  async applyImport(
    userId: string,
    id: string,
    bills: ApplyBill[],
  ) {
    const item = await this.prisma.aiImport.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('导入记录不存在');
    if (item.userId !== userId) {
      throw new ForbiddenException('只能应用自己发起的导入');
    }
    if (item.status !== 'review_ready' && item.status !== 'partial') {
      throw new BadRequestException(
        `当前状态 ${item.status} 不允许应用，需要 review_ready / partial`,
      );
    }

    await this.prisma.aiImport.update({
      where: { id },
      data: { status: 'applying', message: '正在写入数据库…' },
    });

    let inserted = 0;
    for (const b of bills) {
      try {
        const amount = new Prisma.Decimal(b.amount);
        await this.prisma.$transaction([
          this.prisma.bill.create({
            data: {
              ledgerId: item.ledgerId,
              userId,
              accountId: b.accountId,
              categoryId: b.categoryId,
              type: b.type,
              amount,
              noteCipher: Buffer.from(b.noteCipher, 'base64'),
              noteDekVer: b.noteDekVer,
              date: new Date(b.date),
            },
          }),
          this.prisma.account.update({
            where: { id: b.accountId },
            data: {
              balance:
                b.type === 'income'
                  ? { increment: amount }
                  : { decrement: amount },
            },
          }),
        ]);
        inserted++;
      } catch (e) {
        this.logger.warn(`bill apply 失败 (跳过): ${e}`);
      }
    }

    const after = await this.prisma.aiImport.update({
      where: { id },
      data: {
        status: 'done',
        progress: 100,
        message: `已入库 ${inserted}/${bills.length} 条`,
        insertedCount: inserted,
        // 应用后清掉明文草稿（保留 rawOutput 方便排查）
        draftsJson: null,
      },
    });
    return { import: this.serialize(after), insertedCount: inserted };
  }

  // ── 主流程 ────────────────────────────────────────────────

  private async _process(id: string, buf: Buffer) {
    try {
      // 1) 提取文件内容
      await this._update(id, {
        status: 'extracting',
        progress: 10,
        message: '提取文件内容…',
      });
      const rec0 = await this.prisma.aiImport.findUnique({ where: { id } });
      if (!rec0) return;
      const extractor = this.extractors.find((e) => e.supports(rec0.fileType));
      if (!extractor) {
        throw new Error(`不支持的文件类型 ${rec0.fileType}`);
      }
      const extracted = await extractor.extract(buf, rec0.filename);

      // 2) 拉本账本的分类列表，给 LLM 当 enum
      const cats = await this.prisma.category.findMany({
        where: { OR: [{ ledgerId: rec0.ledgerId }, { isSystem: true }] },
        select: { id: true, name: true, type: true, parentId: true },
      });

      // 3) 调 LLM 解析
      await this._update(id, {
        status: 'parsing',
        progress: 35,
        message: `调 ${rec0.modelName} 解析中…`,
      });
      const model = this.llmRegistry.get(rec0.modelName);
      if (extracted.kind === 'image' && !model.supportsVision) {
        throw new Error(
          `图片需要视觉模型，但选了 ${rec0.modelName}（不支持视觉）。请换一个 VL 模型重传。`,
        );
      }

      const drafts = await this._askLlm(model, extracted, cats);
      const usageMsg = drafts.usage
        ? `tokens in=${drafts.usage.prompt} out=${drafts.usage.completion}`
        : 'tokens n/a';
      const warnings: string[] = [];
      if (drafts.inputCapped) {
        warnings.push(`⚠️输入被截到 ${MAX_LLM_INPUT_CHARS} 字符（文件过长，部分流水未送 AI）`);
      }
      if (drafts.finishReason === 'length') {
        warnings.push('⚠️输出被 maxTokens 截断（流水太多，AI 没吐完）');
      } else if (drafts.finishReason && drafts.finishReason !== 'stop') {
        warnings.push(`⚠️finish=${drafts.finishReason}`);
      }
      const fullMsg = [usageMsg, ...warnings].join(' | ');
      this.logger.log(`[${id}] ${rec0.modelName} ${fullMsg}`);
      await this.prisma.aiImport.update({
        where: { id },
        data: {
          rawOutput: drafts.raw.slice(0, 50000),
          parsedCount: drafts.list.length,
          message: fullMsg, // 暂存，下面 review_ready 会覆盖；失败/空时保留
        },
      });

      if (drafts.list.length === 0) {
        await this._update(id, {
          status: 'failed',
          progress: 100,
          message: 'AI 没解析出任何账单，请检查文件内容',
        });
        return;
      }

      // 4) 按"L2 优先 → L1 → L1 下 其他（没有就建）"解析每条草稿的 categoryId
      //    同时填上用户上传时选的 accountId
      await this._update(id, {
        status: 'dedupping',
        progress: 60,
        message: '匹配分类…',
      });
      const resolved: AiDraft[] = [];
      for (const d of drafts.list) {
        const categoryId = await this._resolveCategoryId(
          rec0.ledgerId,
          d.categoryName,
          d.type,
          d.note,
        );
        resolved.push({ ...d, categoryId, accountId: rec0.accountId });
      }

      // 5) 去重 —— 同账本 + 同 date(秒精度) + 同 amount
      await this._update(id, {
        status: 'dedupping',
        progress: 80,
        message: '检查重复…',
      });
      const dedupResult = await this._dedup(rec0.ledgerId, resolved);

      // 6) 草稿就绪 —— 客户端轮询到此状态会自动加密 note 并 POST apply
      await this._update(id, {
        status: 'review_ready',
        progress: 95,
        message:
          `解析 ${drafts.list.length} 条，去重后 ${dedupResult.kept.length} 条，准备入库…`,
        parsedCount: drafts.list.length,
        dupCount: dedupResult.skipped,
        draftsJson: JSON.stringify(dedupResult.kept),
      });
    } catch (e) {
      this.logger.error(`process ${id} 失败: ${e}`);
      await this._update(id, {
        status: 'failed',
        progress: 100,
        message: `失败：${String(e).slice(0, 300)}`,
        errorTrace: (e as Error)?.stack?.slice(0, 5000),
      });
    }
  }

  /** 单段文本超过此值就分块（每块约 80-120 条流水，LLM 输出压力小） */
  private static readonly CHUNK_CHARS = 20_000;
  /** 分块时相邻两块重叠的行数（防止一笔流水被拦腰截断） */
  private static readonly CHUNK_OVERLAP_LINES = 4;

  private async _askLlm(
    model: ChatModel,
    extracted: ExtractedInput,
    categories: { id: string; name: string; type: string; parentId: string | null }[],
  ): Promise<{
    list: AiDraft[];
    raw: string;
    usage?: { prompt: number; completion: number; total: number };
    finishReason?: string;
    inputCapped?: boolean;
  }> {
    // 图片不能分块
    if (extracted.kind === 'image') {
      return this._callLlmOnce(model, extracted, categories);
    }

    const text = extracted.content;
    if (text.length <= AiService.CHUNK_CHARS) {
      return this._callLlmOnce(model, extracted, categories);
    }

    // ── 长文本分块 ──
    const lines = text.split('\n');
    const chunks: string[] = [];
    let i = 0;
    while (i < lines.length) {
      let chunk = '';
      let start = i;
      while (i < lines.length && chunk.length + lines[i].length < AiService.CHUNK_CHARS) {
        chunk += lines[i] + '\n';
        i++;
      }
      if (chunk.trim().length === 0) { i++; continue; }
      chunks.push(`[第${chunks.length + 1}/${'?'}段，此段第${start + 1}-${i}行]\n${chunk.trimEnd()}`);
    }
    // 回填总段数
    const total = chunks.length;
    const labeled = chunks.map((c) => c.replace('/?', `/${total}`));

    this.logger.log(
      `长文本 ${text.length} 字符 / ${lines.length} 行 → 分 ${total} 块并行解析`,
    );

    // 并行调 LLM（带小重叠：当前块末尾几行 = 下一块开头）
    const tasks = labeled.map(async (label, idx) => {
      // 重叠：把上一块的末尾几行加到本块开头（仅第 2 块起）
      let content = label;
      if (idx > 0 && chunks[idx - 1]) {
        const prevLines = chunks[idx - 1].split('\n');
        // 跳过第一行（段标记）取最后 N 行有效内容
        const overlap = prevLines.slice(1).slice(-AiService.CHUNK_OVERLAP_LINES).join('\n');
        if (overlap.trim()) {
          content = `[上文末尾]\n${overlap}\n---\n${label}`;
        }
      }
      const chunkInput: ExtractedInput = { kind: 'text', content };
      return this._callLlmOnce(model, chunkInput, categories);
    });

    const results = await Promise.all(tasks);

    // 合并 + 跨块去重（按 date+amount 指纹）
    const seen = new Set<string>();
    const merged: AiDraft[] = [];
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalTokens = 0;
    const allRaws: string[] = [];
    let anyInputCapped = false;
    let firstFinishReason: string | undefined;

    for (const r of results) {
      if (r.usage) {
        totalPrompt += r.usage.prompt;
        totalCompletion += r.usage.completion;
        totalTokens += r.usage.total;
      }
      if (r.inputCapped) anyInputCapped = true;
      if (r.finishReason && !firstFinishReason) firstFinishReason = r.finishReason;
      allRaws.push(r.raw);
      for (const d of r.list) {
        const fp = `${d.date}|${d.amount.toFixed(2)}`;
        if (!seen.has(fp)) {
          seen.add(fp);
          merged.push(d);
        }
      }
    }

    return {
      list: merged,
      raw: allRaws.join('\n\n--- chunk ---\n\n'),
      usage: { prompt: totalPrompt, completion: totalCompletion, total: totalTokens },
      finishReason: firstFinishReason,
      inputCapped: anyInputCapped || text.includes('[…内容过长已截断'),
    };
  }

  /** 单次 LLM 调用（不分块） */
  private async _callLlmOnce(
    model: ChatModel,
    extracted: ExtractedInput,
    categories: { id: string; name: string; type: string; parentId: string | null }[],
  ): Promise<{
    list: AiDraft[];
    raw: string;
    usage?: { prompt: number; completion: number; total: number };
    finishReason?: string;
    inputCapped?: boolean;
  }> {
    const buildHierarchy = (type: string): string => {
      const l1s = categories.filter((c) => c.type === type && !c.parentId);
      const lines: string[] = [];
      for (const l1 of l1s) {
        const children = categories.filter(
          (c) => c.type === type && c.parentId === l1.id,
        );
        if (children.length === 0) {
          lines.push(`${l1.name}`);
        } else {
          for (const child of children) {
            lines.push(`${l1.name} > ${child.name}`);
          }
        }
      }
      return lines.join('\n');
    };
    const expenseHier = buildHierarchy('expense');
    const incomeHier = buildHierarchy('income');

    const sys: ChatMessage = {
      role: 'system',
      content: [
        '从银行/支付账单中抽取每一笔交易，严格按 JSON 返回。',
        '',
        '【分类规则】',
        '你必须从下面的候选分类中选择一个。优先选最精确的二级分类（"一级>二级"），',
        '实在找不到对应二级时才只填一级名。不要编造分类名，不要填"其他"除非真的无法归类。',
        '',
        '【支出分类】',
        expenseHier || '（无）',
        '',
        '【收入分类】',
        incomeHier || '（无）',
        '',
        '【分类示例】',
        '美团外卖/饿了么/点评团购 → 餐饮>外卖',
        '超市/沃尔玛/盒马/便利店 → 购物>超市',
        '滴滴/地铁/公交/火车票/机票 → 交通>打车 或 交通>公共交通',
        '房租/物业费/水电费 → 住房>房租 或 住房>水电',
        '医院/药房/诊所 → 医疗>门诊 或 医疗>药品',
        '工资/奖金/报销 → 收入>工资 或 收入>报销',
        '理发/美甲/健身房 → 生活>美容美发 或 生活>健身',
        '手机充值/宽带缴费 → 通讯>话费 或 通讯>网费',
        '淘宝/京东/拼多多 → 购物>网购',
        '转账/红包/零钱通 → 转账>转入 或 转账>转出',
        '',
        '【输出格式】',
        '{"bills":[{"type":"expense"|"income","amount":正数,"categoryName":"一级>二级或一级","note":"商户·商品·摘要（·分隔）","date":"ISO8601"}]}',
        '',
        '【注意事项】',
        '- 同一笔交易只出一条，不要拆成支出+收入',
        '- 缺金额或缺日期就跳过',
        '- 注意识别退款（商户名含"退款"且金额与消费相反的通常是退款，归入原分类）',
        '- note 写商户名/商品/备注，不要写日期或金额',
      ].join('\n'),
    };

    const userMsg: ChatMessage =
      extracted.kind === 'image'
        ? { role: 'user', content: extracted.parts as MessagePart[] }
        : { role: 'user', content: extracted.content };

    const res = await model.chat([sys, userMsg], {
      responseFormat: 'json_object',
      temperature: 0.1,
      maxTokens: 32768,
    });

    const raw = res.content;
    const parsed = tryParseLooseJson(raw);
    if (parsed == null) {
      this.logger.error(
        `AI 返回不是合法 JSON。前 500 字符：${raw.slice(0, 500)}`,
      );
      throw new Error(
        `AI 返回不是合法 JSON（${raw.length} 字符）。已记录到日志，请查 logcat。`,
      );
    }

    const arr: any[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.bills)
        ? parsed.bills
        : Array.isArray(parsed?.data)
          ? parsed.data
          : [];

    const list: AiDraft[] = [];
    for (const o of arr) {
      const amount = Number(o?.amount);
      if (!isFinite(amount) || amount <= 0) continue;
      const type = o?.type === 'income' ? 'income' : 'expense';
      const date = parseDate(o?.date) ?? new Date().toISOString();
      list.push({
        type,
        amount,
        categoryName: String(o?.categoryName || '').trim() || '其他',
        categoryId: '',
        accountId: '',
        note: String(o?.note || '').trim(),
        date,
      });
    }
    const inputCapped =
      extracted.kind === 'text' && extracted.content.includes('[…内容过长已截断');

    return {
      list,
      raw,
      usage: res.usage,
      finishReason: res.finishReason,
      inputCapped,
    };
  }

  private async _dedup(
    ledgerId: string,
    drafts: AiDraft[],
  ): Promise<{ kept: AiDraft[]; skipped: number }> {
    // 同账本下，按 (date 精确到秒, amount) 查现有 bills
    // 用户说"日期精确到秒已经够"，所以 fingerprint = ledger + date(second) + amount
    if (drafts.length === 0) return { kept: [], skipped: 0 };
    const ors: Prisma.BillWhereInput[] = drafts.map((d) => ({
      date: new Date(d.date),
      amount: new Prisma.Decimal(d.amount),
    }));
    const existing = await this.prisma.bill.findMany({
      where: { ledgerId, OR: ors },
      select: { date: true, amount: true },
    });
    const existingSet = new Set(
      existing.map((b) => `${b.date.getTime()}|${b.amount.toString()}`),
    );
    let skipped = 0;
    const kept: AiDraft[] = [];
    for (const d of drafts) {
      const key = `${new Date(d.date).getTime()}|${new Prisma.Decimal(
        d.amount,
      ).toString()}`;
      if (existingSet.has(key)) {
        skipped++;
        continue;
      }
      kept.push(d);
    }
    return { kept, skipped };
  }

  /**
   * 按"L2 优先 → L1 → 关键词 →'其他'"解析 AI 返回的 categoryName → 真实 categoryId。
   *
   * 优先级：
   *   1. 二级分类（parentId 非空）名字精确匹配（L1+L2 双精确）
   *   2. L2 名字精确匹配（不管 L1）
   *   3. L1 名字精确匹配 → 其下 L2 名字精确匹配（如有 hint）
   *   4. L1 名字精确匹配 → 其下"其他"二级（没有则建）
   *   5. L2 模糊匹配（包含/被包含）
   *   6. L1 模糊匹配 → 其下"其他"二级（没有则建）
   *   7. 关键词兜底：用 note 中的商户名/关键词匹配预置映射表
   *   8. 实在没有就拿同 type 第一个一级 → 其下"其他"二级（没有则建）
   */
  private async _resolveCategoryId(
    ledgerId: string,
    aiName: string,
    type: 'expense' | 'income',
    note?: string,
  ): Promise<string> {
    const all = await this.prisma.category.findMany({
      where: {
        type,
        OR: [{ ledgerId }, { isSystem: true }],
      },
    });
    if (all.length === 0) {
      throw new Error(`账本下没有 ${type} 类型的分类`);
    }

    const lvl1 = all.filter((c) => !c.parentId);
    const lvl2 = all.filter((c) => c.parentId);
    const l1ById = new Map(lvl1.map((c) => [c.id, c]));

    // AI 现在按提示返回 "一级 > 二级" 格式，先按 > 拆开
    const raw = (aiName || '').trim();
    const parts = raw.split(/\s*[>>›/／]\s*/); // 兼容多种箭头/斜杠分隔
    const l1Hint = (parts[0] || '').toLowerCase();
    const l2Hint = (parts[1] || parts[0] || '').toLowerCase();

    // 1. 完美匹配：(L1 hint, L2 hint) 双精确 —— 最准
    if (parts.length >= 2 && l1Hint && l2Hint) {
      const l2 = lvl2.find((c) => {
        if (c.name.toLowerCase() !== l2Hint) return false;
        const parent = l1ById.get(c.parentId!);
        return parent && parent.name.toLowerCase() === l1Hint;
      });
      if (l2) return l2.id;
    }

    // 2. L2 名字精确匹配（不管 L1 hint）
    if (l2Hint) {
      const l2 = lvl2.find((c) => c.name.toLowerCase() === l2Hint);
      if (l2) return l2.id;
    }

    // 3. L1 精确 → 其下 L2 精确（AI 没按 > 格式但提供了两级信息）
    if (l1Hint && l2Hint && l1Hint !== l2Hint) {
      const l1 = lvl1.find((c) => c.name.toLowerCase() === l1Hint);
      if (l1) {
        const l2 = lvl2.find(
          (c) => c.parentId === l1.id && c.name.toLowerCase() === l2Hint,
        );
        if (l2) return l2.id;
      }
    }

    // 4. L1 名字精确匹配 → 其下"其他"
    if (l1Hint) {
      const l1 = lvl1.find((c) => c.name.toLowerCase() === l1Hint);
      if (l1) return this._getOrCreateOther(l1.id, type, ledgerId);
    }

    // 5. L2 模糊（包含/被包含）
    const needle = l2Hint || raw.toLowerCase();
    if (needle) {
      const l2 = lvl2.find((c) => {
        const n = c.name.toLowerCase();
        return n.includes(needle) || needle.includes(n);
      });
      if (l2) return l2.id;
    }

    // 6. L1 模糊 → 其下"其他"
    if (needle) {
      const l1 = lvl1.find((c) => {
        const n = c.name.toLowerCase();
        return n.includes(needle) || needle.includes(n);
      });
      if (l1) return this._getOrCreateOther(l1.id, type, ledgerId);
    }

    // 7. 关键词兜底：用 note + aiName 推断分类
    const kwCat = this._keywordMatch(all, l1ById, raw, note || '', type);
    if (kwCat) return kwCat;

    // 8. 最终兜底：第一个 L1 → 其他
    if (lvl1.length > 0) {
      return this._getOrCreateOther(lvl1[0].id, type, ledgerId);
    }
    return all[0].id;
  }

  /** 用商户名/备注中的关键词推断分类 */
  private _keywordMatch(
    all: { id: string; name: string; parentId: string | null }[],
    l1ById: Map<string, { id: string; name: string }>,
    aiName: string,
    note: string,
    type: 'expense' | 'income',
  ): string | null {
    const text = (aiName + ' ' + note).toLowerCase();
    const lvl1 = all.filter((c) => !c.parentId);
    const lvl2 = all.filter((c) => c.parentId);

    // 关键词 → (L1名, L2名) 映射表
    const map: [string[], string, string?][] = [
      // ── 餐饮 ──
      [['美团', '外卖', '饿了么', '点评', '团购', '麦当劳', '肯德基', '必胜客',
        '星巴克', '瑞幸', '喜茶', '奈雪', '海底捞', '烧烤', '火锅', '奶茶',
        '咖啡', '快餐', '小吃', '烘焙', '蛋糕', '饭店', '餐厅', '食堂', '饭馆',
        '大排档', '面馆', '拉面', '麻辣烫', '串串', '炸鸡', '汉堡', '披萨'], '餐饮', '外卖'],
      [['早餐', '早点', '包子', '油条', '豆浆', '豆腐脑', '肠粉', '煎饼果子',
        '馒头', '粥', '鸡蛋灌饼'], '餐饮', '早餐'],
      [['午餐', '午饭'], '餐饮', '午餐'],
      [['晚餐', '晚饭'], '餐饮', '晚餐'],
      [['买菜', '食材', '蔬菜', '生鲜', '菜市场', '盒马鲜生', '叮咚', '朴朴',
        '每日优鲜', '钱大妈', '肉', '鸡蛋', '米', '面', '油', '调料'], '餐饮', '买菜食材'],
      [['水果', '草莓', '西瓜', '苹果', '香蕉', '橙子', '葡萄', '芒果', '榴莲',
        '车厘子', '蓝莓', '橘子', '桃子', '梨'], '餐饮', '零食水果'],
      [['零食', '薯片', '饼干', '坚果', '果冻', '辣条', '巧克力', '糖果',
        '冰淇淋', '雪糕', '瓜子'], '餐饮', '零食水果'],
      [['请客', '聚餐', '聚会', '宴请', '饭局', 'AA'], '餐饮', '聚餐请客'],

      // ── 购物 ──
      [['超市', '沃尔玛', '盒马', '山姆', '永辉', '华润', '联华', '大润发',
        '便利店', '全家', '罗森', '7-11', '711', '好德', '美宜佳',
        '屈臣氏', '名创优品', '无印良品', '杂物'], '购物', '日用品'],
      [['淘宝', '天猫', '京东', '拼多多', '抖音', '快手', '唯品会', '得物',
        '闲鱼', '小红书', '网易严选', '当当', '苏宁', '国美'], '购物', '数码电子'],
      [['数码', '电子', '手机', '电脑', '平板', '耳机', '音箱', '相机',
        '华为', '小米', '苹果', 'vivo', 'oppo', '荣耀', '三星'], '购物', '数码电子'],
      [['家电', '冰箱', '洗衣机', '空调', '电视', '扫地', '吸尘', '风扇', '取暖',
        '净水', '空气炸锅', '烤箱', '微波炉', '电磁炉', '电饭煲', '热水器'], '购物', '家电家居'],
      [['家具', '床垫', '沙发', '桌椅', '灯具', '窗帘', '收纳', '碗', '盘',
        '杯', '锅', '刀具', '菜板', '厨房', '卫浴'], '购物', '家电家居'],
      [['衣服', '服装', '裤子', '鞋', '帽子', '围巾', '袜子', '内衣', '包',
        '背包', '箱包', '皮带', '眼镜', '手表'], '购物', '服饰鞋包'],
      [['美妆', '护肤', '面膜', '口红', '粉底', '眼影', '防晒', '洗面奶',
        '化妆', '香水', '精华', '乳液', '面霜', '卸妆', 'BB霜', 'CC霜',
        '眉笔', '睫毛', '腮红', '散粉', '隔离', '气垫'], '购物', '美妆个护'],
      [['洗发', '沐浴', '牙膏', '牙刷', '纸巾', '洗衣', '肥皂', '洗手液',
        '卫生巾', '湿巾', '毛巾', '浴巾', '垃圾袋', '拖把', '扫把'], '购物', '日用品'],
      [['书籍', '书', '文具', '笔', '本', '打印', '复印', '杂志', '报刊',
        'kindle', '电子书', '文具店', '晨光', '无印'], '购物', '书籍文具'],

      // ── 交通 ──
      [['滴滴', '打车', '出租车', '曹操', '首汽', '花小猪', 'T3', '嘀嗒',
        '顺风车', '快车', '专车'], '交通', '打车'],
      [['地铁', '公交', '巴士', 'BRT', '一卡通', '乘车码', 'NFC',
        '共享单车', '哈啰', '美团单车', '青桔', '摩拜', '骑行'], '交通', '公交地铁'],
      [['火车', '普速', '绿皮', '硬座', '硬卧', '软卧', '12306', '铁路'], '交通', '火车'],
      [['高铁', '动车', '城际', '复兴号'], '交通', '高铁'],
      [['机票', '航空', '航班', '飞猪', '携程', '去哪儿', '春秋', '南航',
        '国航', '东航', '海航', '深航', '厦航'], '交通', '飞机'],
      [['加油', '石化', '石油', '充电', '加油站', '充电桩', '特来电',
        '国家电网', '中石化', '中石油', '壳牌'], '交通', '加油充电'],
      [['停车', '泊车', 'ETC', '车库'], '交通', '停车'],
      [['高速', '过路费', '收费站'], '交通', '过路费'],

      // ── 住房 ──
      [['房租', '租金', '自如', '贝壳', '链家', '房东', '租房'], '住房', '房租'],
      [['房贷', '按揭', '公积金贷款', '商业贷款', '住房贷款'], '住房', '房贷'],
      [['水费', '自来水', '水务', '用水'], '住房', '水费'],
      [['电费', '电力', '电网', '用电', '国网'], '住房', '电费'],
      [['燃气', '煤气', '天然气', '液化气', '燃气费', '燃气公司'], '住房', '燃气费'],
      [['物业', '物管', '管理费', '物业费'], '住房', '物业'],
      [['装修', '维修', '疏通', '补漏', '粉刷', '换锁', '开锁', '装修公司',
        '建材', '水泥', '瓷砖', '地板', '油漆', '涂料'], '住房', '维修装修'],
      [['保洁', '家政', '钟点工', '保姆', '月嫂', '育儿嫂', '清洁',
        '打扫', '擦窗', '开荒'], '住房', '家政保洁'],

      // ── 娱乐 ──
      [['电影', '影院', '演出', '演唱会', '话剧', '音乐会', '歌剧', 'livehouse',
        '脱口秀', '相声', '展览', '博物馆'], '娱乐', '电影演出'],
      [['游戏', 'steam', 'Switch', 'playstation', 'xbox', 'NS',
        '王者荣耀', '原神', '充值', '皮肤', '网游', '手游', '端游'], '娱乐', '游戏'],
      [['KTV', '唱歌', '量贩', '酒吧', '夜店', 'club', 'live house'], '娱乐', 'KTV'],
      [['会员', '订阅', '视频', '音乐', '网盘', 'VPN', '加速器',
        '腾讯视频', '爱奇艺', '优酷', 'B站', 'QQ音乐', '网易云', 'Apple'], '娱乐', '会员订阅'],
      [['旅游', '酒店', '民宿', '度假', '跟团', '自由行', '邮轮',
        '携程旅行', '美团酒店', '途牛', '马蜂窝', '穷游'], '娱乐', '旅游度假'],
      [['门票', '景点', '景区', '游乐园', '主题公园', '水上乐园', '动物园',
        '海洋馆', '植物园', '博物馆门票', '迪士尼', '环球影城', '长隆'], '娱乐', '景点门票'],

      // ── 医疗健康 ──
      [['医院', '诊所', '门诊', '挂号', '就医', '看病', '急诊', '住院',
        '手术', '化验', '检查', '拍片', 'CT', 'B超', '核磁'], '医疗健康', '门诊挂号'],
      [['药房', '药店', '药品', '买药', '中药', '西药', '处方',
        '感冒药', '退烧药', '止疼药', '消炎药', '医保药'], '医疗健康', '药品'],
      [['体检', '体检中心', '体检套餐', '入职体检'], '医疗健康', '体检'],
      [['牙科', '牙医', '口腔', '拔牙', '补牙', '洗牙', '矫正', '种植牙',
        '根管', '牙齿', '牙套'], '医疗健康', '牙科'],
      [['保健', '养生', '理疗', '针灸', '推拿', '拔罐', '刮痧', '艾灸',
        '保健品', '维生素', '蛋白粉', '鱼油', '钙片'], '医疗健康', '保健养生'],

      // ── 教育 ──
      [['学费', '培训', '课程', '补习', '家教', '网课', '线上课', '培训班',
        '学而思', '新东方', '猿辅导', '作业帮', '英语', '日语', '韩语'], '教育', '学费培训'],
      [['教材', '文具', '书本', '课本', '教辅', '练习册', '试卷', '书包',
        '笔', '橡皮', '尺子', '文具盒'], '教育', '教材文具'],
      [['考试', '报名', '报名费', '考试费', '考级', '考证', '雅思', '托福',
        '四六级', '考研', '考公', '教资', 'CPA', '司法考试'], '教育', '考试报名'],

      // ── 通讯 ──
      [['话费', '充值', '中国移动', '中国联通', '中国电信', '手机费',
        '流量', '套餐', '漫游'], '通讯', '话费'],
      [['宽带', '网费', '光纤', '互联网', 'WIFI', '路由器'], '通讯', '宽带'],
      [['订阅', '会员费', 'iCloud', 'Google', 'Office', 'Notion',
        'GitHub', '域名', '服务器', '云服务'], '通讯', '数字订阅'],

      // ── 人情社交 ──
      [['红包', '发红包', '微信红包', '支付宝红包', '过年红包', '春节红包',
        '压岁钱'], '人情社交', '红包礼金'],
      [['份子钱', '婚礼红包', '结婚红包', '随礼', '随份子', '白事',
        '喜事', '满月', '乔迁', '升学宴'], '人情社交', '份子钱'],
      [['送礼', '礼物', '礼品', '送人', '过节送礼', '伴手礼',
        '花束', '鲜花', '蛋糕'], '人情社交', '请客送礼'],

      // ── 育儿亲子 ──
      [['奶粉', '尿布', '纸尿裤', '拉拉裤', '湿纸巾', '奶瓶', '奶嘴',
        '吸奶器', '储奶袋', '辅食', '米粉', '果泥', '宝宝零食'], '育儿亲子', '奶粉尿布'],
      [['玩具', '童装', '童鞋', '婴儿车', '安全座椅', '爬行垫',
        '围栏', '婴儿床', '书包', '文具盒'], '育儿亲子', '玩具童装'],
      [['早教', '幼儿园', '托班', '亲子', '育儿', '启蒙',
        '兴趣班', '特长班', '游泳课', '钢琴', '画画', '舞蹈'], '育儿亲子', '早教'],

      // ── 汽车 ──
      [['车贷', '汽车贷款', '购车贷款', '按揭买车'], '汽车', '车贷'],
      [['车险', '交强险', '三者险', '车损险', '商业车险', '汽车保险'], '汽车', '保险'],
      [['保养', '汽车维修', '修车', '4S店', '换机油', '机滤',
        '空滤', '轮胎', '电瓶', '刹车片', '火花塞'], '汽车', '保养维修'],
      [['洗车', '年检', '审车', '验车', '车管所', '行驶证',
        '驾照', '驾校', '学车', '科目'], '汽车', '洗车年检'],

      // ── 宠物 ──
      [['宠物粮', '猫粮', '狗粮', '猫罐头', '狗零食', '猫条', '化毛膏',
        '宠物零食', '猫砂', '狗厕所'], '宠物', '粮食零食'],
      [['宠物医院', '兽药', '疫苗', '驱虫', '绝育', '宠物医保',
        '洗澡', '美容', '寄养'], '宠物', '医疗保健'],
      [['宠物玩具', '猫抓板', '逗猫棒', '狗绳', '猫窝', '狗窝',
        '宠物衣服', '猫笼', '狗笼', '宠物项圈'], '宠物', '用品玩具'],

      // ── 运动健身 ──
      [['健身', '健身房', '私教', '瑜伽', '普拉提', 'CrossFit',
        'Keep', '超级猩猩', '乐刻', '威尔仕', '一兆韦德'], '运动健身', '健身瑜伽'],
      [['运动装备', '跑鞋', '运动服', '球拍', '球鞋', '运动手表',
        '护膝', '护腕', '跳绳', '哑铃', '杠铃', '弹力带'], '运动健身', '器材装备'],
      [['球类', '游泳', '篮球', '足球', '羽毛球', '乒乓球', '网球',
        '高尔夫', '台球', '保龄球', '滑雪', '滑冰', '溜冰',
        '游泳馆', '泳池', '泳衣', '泳镜', '泳帽'], '运动健身', '球类游泳'],

      // ── 美容美发 ──
      [['理发', '剪发', '烫发', '染发', '发型', '发廊', '美发店',
        '洗头', '护理', '发膜', '发蜡'], '美容美发', '理发造型'],
      [['美容', '护肤', '美容院', '皮肤管理', '水光针', '光子嫩肤',
        '热玛吉', '超声刀', '皮秒', '祛痘', '祛斑', '脱毛'], '美容美发', '美容护肤'],
      [['美甲', '美睫', '纹眉', '纹身', '纹绣', '半永久', '接睫毛'], '美容美发', '美甲美睫'],
      [['按摩', 'SPA', '足浴', '足疗', '泡脚', '采耳', '汗蒸',
        '桑拿', '泡汤', '温泉'], '美容美发', '按摩SPA'],

      // ── 保险 ──
      [['社保', '医保', '养老保险', '失业保险', '工伤保险', '生育保险',
        '公积金', '五险一金', '灵活就业', '城乡居民医保'], '保险', '社保医保'],
      [['商业保险', '重疾险', '医疗险', '寿险', '意外险', '年金险',
        '万能险', '投连险', '香港保险', '平安', '人寿', '太平洋'], '保险', '商业保险'],

      // ── 收入 ──
      [['工资', '薪资', '薪酬', '基本工资', '绩效', '岗位工资',
        '税后', '税前', '发薪', '薪金'], '工资'],
      [['奖金', '年终奖', '项目奖', '季度奖', '绩效奖金', '双薪',
        '十三薪', '十四薪', '加薪'], '奖金'],
      [['兼职', '副业', '稿费', '佣金', '提成', '咨询费', '服务费',
        '外包', '接私活', '自媒体', '直播', '带货', '公众号', '版税'], '兼职副业'],
      [['理财', '基金', '股票', '分红', '利息', '余额宝', '零钱通',
        '收益', '赎回', '股息', '债基', '货基', '指数基金', 'ETF',
        'A股', '港股', '美股', '打新', '可转债', 'REITs'], '投资理财'],
      [['报销', '差旅', '补贴', '补助', '津贴', '交通补贴', '餐补',
        '话补', '房补', '高温补贴', '取暖补贴'], '报销'],
      [['收到红包', '收红包', '份子钱收入', '礼金', '压岁钱',
        '转账', '家人给', '父母给', '老公转', '老婆转', '亲属给'], '红包礼金'],
    ];

    for (const [keywords, l1Name, l2Name] of map) {
      if (!keywords.some((kw) => text.includes(kw))) continue;

      // 找 L1
      const l1 = lvl1.find((c) => c.name === l1Name || c.name.toLowerCase() === l1Name.toLowerCase());
      if (!l1) continue;

      if (l2Name) {
        // 找 L1 下的 L2
        const l2 = lvl2.find(
          (c) => c.parentId === l1.id &&
            (c.name === l2Name || c.name.toLowerCase() === l2Name.toLowerCase()),
        );
        if (l2) return l2.id;
        // L2 不存在 → 用 L1 下的"其他"
        continue; // fall through to next match or final fallback
      }
      return l1.id;
    }

    return null;
  }

  /** 找/建 parent 下的"其他"二级分类 */
  private async _getOrCreateOther(
    parentId: string,
    type: 'expense' | 'income',
    ledgerId: string,
  ): Promise<string> {
    const exist = await this.prisma.category.findFirst({
      where: {
        parentId,
        type,
        name: { in: ['其他', '其它'] },
      },
    });
    if (exist) return exist.id;
    const created = await this.prisma.category.create({
      data: {
        name: '其他',
        type,
        parentId,
        ledgerId,
        icon: '📌',
        isSystem: false,
      },
    });
    return created.id;
  }

  private async _update(id: string, data: Prisma.AiImportUpdateInput) {
    try {
      await this.prisma.aiImport.update({ where: { id }, data });
    } catch (e) {
      // 即使记录被删了也别让流程抛出来
      this.logger.warn(`update ${id} 失败: ${e}`);
    }
  }

  private serialize = (r: any) => ({
    id: r.id,
    ledgerId: r.ledgerId,
    userId: r.userId,
    accountId: r.accountId,
    filename: r.filename,
    fileType: r.fileType,
    fileSize: r.fileSize,
    modelName: r.modelName,
    status: r.status,
    progress: r.progress,
    message: r.message,
    parsedCount: r.parsedCount,
    dupCount: r.dupCount,
    insertedCount: r.insertedCount,
    hasDrafts: !!r.draftsJson,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

/** apply 时客户端送上来的"已加密 bill" */
export interface ApplyBill {
  accountId: string;
  categoryId: string;
  type: 'expense' | 'income';
  amount: number;
  noteCipher: string; // base64
  noteDekVer: number;
  date: string; // ISO
}

function parseDate(s: any): string | null {
  if (typeof s !== 'string' || !s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * 容错 JSON 解析：
 *   1. 直接 JSON.parse
 *   2. 剥 ```json ... ``` 围栏
 *   3. 取第一个 { 到最后一个 }
 *   4. 修复"被截断"：补齐缺失的 ] 和 }
 *
 * 返回 null 表示完全没法救
 */
function tryParseLooseJson(raw: string): any | null {
  if (!raw || !raw.trim()) return null;

  // 1. 直接 parse
  try {
    return JSON.parse(raw);
  } catch {}

  // 2. 剥 ```json … ``` 围栏
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }

  // 3. 取第一个 { 到最后一个 }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }

  // 4. 输出被截断时尝试修复
  //    思路：找最后一个完整结束的 array 元素（也就是 `},` 后面就是下一个元素），
  //    截到那个 `}` 后再补 `]}` 闭合外层。即使最后一个 bill 在字符串中间被切，
  //    也能把前面已经完整的 N-1 条救回来。
  if (start >= 0) {
    // 找最后一个 "},\n" 或 "}," 形式（说明这条 bill 已写完进入下一条）
    const lastBoundary = raw.lastIndexOf('},');
    if (lastBoundary > start) {
      const truncated = raw.slice(start, lastBoundary + 1); // +1 包含那个 }
      // 已含开头 `{"bills":[` … 直接补 `]}`
      const candidates = [
        truncated + ']}',
        truncated + ']}}', // 万一最外层还差一层
      ];
      for (const c of candidates) {
        try {
          return JSON.parse(c);
        } catch {}
      }
    }
    // 兜底：截到最后一个完整 `}`（适用于截在数组末尾、整体只差几个收尾括号的情况）
    const lastObjEnd = raw.lastIndexOf('}');
    if (lastObjEnd > start) {
      const truncated = raw.slice(start, lastObjEnd + 1);
      const candidates = [
        truncated + ']}',
        truncated + '}',
        truncated + ']',
        '{"bills":[' + truncated + ']}',
      ];
      for (const c of candidates) {
        try {
          return JSON.parse(c);
        } catch {}
      }
    }
  }
  return null;
}
