import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';
import { CfoService } from '../cfo/cfo.service';
import { LlmRegistry } from './llm/llm-registry';
import { ResolvedLlm } from './llm/llm-resolver';
import {
  ChatMessage,
  ChatResponse,
  ToolCall,
  ToolSpec,
} from './llm/chat-model';

/** 客户端可渲染的数据卡片（金额 / 趋势 / 预算）*/
export type ReplyCard =
  | {
      type: 'stat';
      data: {
        title: string;
        total: number;
        count?: number;
        period?: string;
        buckets?: { key: string; label: string; amount: number; count?: number }[];
      };
    }
  | {
      type: 'budget';
      data: {
        items: {
          categoryName: string;
          spent: number;
          limit: number;
          rate: number;
        }[];
      };
    }
  | {
      type: 'cfo_action';
      data: {
        proposalId: string;
        title: string;
        body: string;
        actionKind: string;
        requiresClient: boolean;
        actionParams: Record<string, unknown>;
      };
    }
  | {
      type: 'bill_draft';
      data: {
        amount: number;
        categoryId: string;
        categoryName: string;
        accountName?: string;
        note: string;
        billType: 'expense' | 'income';
      };
    };

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatReply {
  reply: string;
  cards: ReplyCard[];
  // 若服务器需要客户端做商户聚合（通路 B），返回需要解密的 billIds
  pendingClientAggregation?: { task: 'merchant'; billIds: string[]; period: string };
  // 完整的 messages 流（供 client 继续保留上下文）
  followupMessages: ChatTurn[];
  // 调试
  usage?: { prompt: number; completion: number; total: number };
  toolCallsTrace?: { name: string; args: any; result: any }[];
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private static readonly MAX_TOOL_LOOPS = 3;
  private static readonly MAX_HISTORY_TURNS = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgers: LedgersService,
    private readonly cfo: CfoService,
    private readonly llmRegistry: LlmRegistry,
  ) {}

  // ── 主入口 ───────────────────────────────────────────────

  async chat(
    userId: string,
    ledgerId: string,
    userMessage: string,
    history: ChatTurn[] = [],
    llm?: ResolvedLlm,
  ): Promise<ChatReply> {
    await this.ledgers.ensureMembership(userId, ledgerId);
    const trimmed = (userMessage || '').trim();
    if (!trimmed) {
      return {
        reply: '说点什么吧？比如"这个月外卖花了多少"',
        cards: [],
        followupMessages: history,
      };
    }

    const modelName = llm?.name ?? this.llmRegistry.defaultTextModelName();
    if (!modelName) {
      return {
        reply: '尚未配置 AI 模型：请到 我的→设置→AI 模型 填写',
        cards: [],
        followupMessages: history,
      };
    }
    const model = llm?.model ?? this.llmRegistry.get(modelName);

    // 控历史长度
    const recentHist = history.slice(-ChatService.MAX_HISTORY_TURNS * 2);

    // 构造 messages
    const sys: ChatMessage = { role: 'system', content: SYSTEM_PROMPT };
    const messages: ChatMessage[] = [
      sys,
      ...recentHist.map((t) => ({ role: t.role, content: t.content }) as ChatMessage),
      { role: 'user', content: trimmed },
    ];

    const cards: ReplyCard[] = [];
    const toolTrace: { name: string; args: any; result: any }[] = [];
    let pendingClientAggregation:
      | { task: 'merchant'; billIds: string[]; period: string }
      | undefined;
    let totalUsage = { prompt: 0, completion: 0, total: 0 };

    // 工具循环（多轮 tool_calls）
    let res: ChatResponse | null = null;
    for (let loop = 0; loop < ChatService.MAX_TOOL_LOOPS; loop++) {
      res = await model.chat(messages, {
        temperature: 0.3,
        maxTokens: 1024,
        tools: TOOLS,
      });
      if (res.usage) {
        totalUsage.prompt += res.usage.prompt;
        totalUsage.completion += res.usage.completion;
        totalUsage.total += res.usage.total;
      }
      if (!res.toolCalls || res.toolCalls.length === 0) {
        break; // 模型给出最终回复
      }

      // 把 assistant 的 tool_calls 消息也加进 messages（OpenAI 协议要求）
      messages.push({
        role: 'assistant',
        content: res.content || '',
        tool_calls: res.toolCalls,
      });

      // 逐个执行
      for (const call of res.toolCalls) {
        const args = safeParse(call.function.arguments);
        const { result, card, aggregation } = await this._runTool(
          ledgerId,
          userId,
          call.function.name,
          args,
        );
        toolTrace.push({ name: call.function.name, args, result });
        if (card) cards.push(card);
        if (aggregation) pendingClientAggregation = aggregation;

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(result),
        });
      }
    }

    const replyText =
      (res?.content ?? '').trim() ||
      (cards.length > 0 ? '看一下下面的数据 👇' : '我暂时没看到相关数据');

    // 更新对话历史 —— 只往外返 user/assistant，tool 消息不外泄
    const followupMessages: ChatTurn[] = [
      ...recentHist,
      { role: 'user', content: trimmed },
      { role: 'assistant', content: replyText },
    ];

    this.logger.log(
      `[chat ${ledgerId}] tools=${toolTrace.map((t) => t.name).join(',') || '-'} tokens=${totalUsage.total}`,
    );

    return {
      reply: replyText,
      cards,
      pendingClientAggregation,
      followupMessages,
      usage: totalUsage,
      toolCallsTrace: toolTrace,
    };
  }

  // ── 工具执行 ─────────────────────────────────────────────

  private async _runTool(
    ledgerId: string,
    userId: string,
    name: string,
    args: any,
  ): Promise<{
    result: any;
    card?: ReplyCard;
    aggregation?: { task: 'merchant'; billIds: string[]; period: string };
  }> {
    try {
      if (name === 'queryStats') {
        return await this._toolQueryStats(ledgerId, args);
      }
      if (name === 'manageBudget') {
        return await this._toolManageBudget(ledgerId, args);
      }
      if (name === 'adjustBudget') {
        return await this._toolAdjustBudget(ledgerId, args);
      }
      if (name === 'findBills') {
        return await this._toolFindBills(ledgerId, args);
      }
      if (name === 'recategorizeBill') {
        return await this._toolRecategorizeBill(ledgerId, args);
      }
      if (name === 'allocateToGoal') {
        return await this._toolAllocateToGoal(ledgerId, args);
      }
      if (name === 'recordBill') {
        return await this._toolRecordBill(ledgerId, args);
      }
      return { result: { error: `未知工具: ${name}` } };
    } catch (e: any) {
      this.logger.warn(`tool ${name} 失败: ${e?.message}`);
      return { result: { error: String(e?.message || e) } };
    }
  }

  /** queryStats：按账单聚合查询。groupBy=merchant 时返回 billIds 让客户端聚合 */
  private async _toolQueryStats(
    ledgerId: string,
    args: any,
  ): Promise<{
    result: any;
    card?: ReplyCard;
    aggregation?: { task: 'merchant'; billIds: string[]; period: string };
  }> {
    const [start, end] = parsePeriod(args?.period);
    const where: Prisma.BillWhereInput = {
      ledgerId,
      date: { gte: start, lte: end },
    };
    if (args?.type === 'expense' || args?.type === 'income') {
      where.type = args.type;
    }
    if (Array.isArray(args?.categoryIds) && args.categoryIds.length > 0) {
      where.categoryId = { in: args.categoryIds.map(String) };
    }

    const groupBy = String(args?.groupBy ?? '');
    const limit = Math.min(Number(args?.limit ?? 20), 50);

    // 总额 + 笔数
    const agg = await this.prisma.bill.aggregate({
      where,
      _sum: { amount: true },
      _count: { _all: true },
    });
    const total = Number(agg._sum.amount ?? 0);
    const count = agg._count._all;

    const periodLabel = args?.period
      ? String(args.period)
      : `${start.toISOString().slice(0, 10)} ~ ${end.toISOString().slice(0, 10)}`;

    // 商户聚合：服务器看不到 note → 通路 B
    if (groupBy === 'merchant') {
      const bills = await this.prisma.bill.findMany({
        where,
        select: { id: true },
        orderBy: { date: 'desc' },
        take: 200,
      });
      return {
        result: {
          total,
          count,
          period: periodLabel,
          needsClientAggregation: true,
          billIds: bills.map((b) => b.id),
          note: '商户名在客户端加密，服务器无法聚合；客户端会解密这些账单本地聚合后再展示。',
        },
        aggregation: {
          task: 'merchant',
          billIds: bills.map((b) => b.id),
          period: periodLabel,
        },
      };
    }

    let buckets: { key: string; label: string; amount: number; count: number }[] = [];

    if (groupBy === 'category') {
      const grouped = await this.prisma.bill.groupBy({
        by: ['categoryId'],
        where,
        _sum: { amount: true },
        _count: { _all: true },
      });
      const catIds = grouped.map((g) => g.categoryId);
      const cats = await this.prisma.category.findMany({
        where: { id: { in: catIds } },
        select: { id: true, name: true, parentId: true },
      });
      const parentIds = cats.map((c) => c.parentId).filter(Boolean) as string[];
      const parents = parentIds.length
        ? await this.prisma.category.findMany({
            where: { id: { in: parentIds } },
            select: { id: true, name: true },
          })
        : [];
      const parentMap = new Map(parents.map((p) => [p.id, p.name]));
      const catMap = new Map(
        cats.map((c) => [
          c.id,
          c.parentId ? `${parentMap.get(c.parentId) ?? ''}›${c.name}` : c.name,
        ]),
      );
      buckets = grouped
        .map((g) => ({
          key: g.categoryId,
          label: catMap.get(g.categoryId) ?? '未分类',
          amount: Number(g._sum.amount ?? 0),
          count: g._count._all,
        }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, limit);
    } else if (groupBy === 'account') {
      const grouped = await this.prisma.bill.groupBy({
        by: ['accountId'],
        where,
        _sum: { amount: true },
        _count: { _all: true },
      });
      buckets = grouped
        .map((g) => ({
          key: g.accountId,
          label: g.accountId,
          amount: Number(g._sum.amount ?? 0),
          count: g._count._all,
        }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, limit);
    } else if (groupBy === 'day' || groupBy === 'week' || groupBy === 'month') {
      // 简单实现：服务端 JS 分桶
      const bills = await this.prisma.bill.findMany({
        where,
        select: { date: true, amount: true },
        orderBy: { date: 'asc' },
      });
      const m = new Map<string, { amount: number; count: number }>();
      for (const b of bills) {
        const k = bucketKey(b.date, groupBy);
        const cur = m.get(k) ?? { amount: 0, count: 0 };
        cur.amount += Number(b.amount);
        cur.count++;
        m.set(k, cur);
      }
      buckets = Array.from(m.entries())
        .map(([k, v]) => ({ key: k, label: k, amount: v.amount, count: v.count }))
        .sort((a, b) => a.key.localeCompare(b.key));
    }

    const result = {
      total,
      count,
      period: periodLabel,
      buckets: buckets.length ? buckets : undefined,
    };

    const card: ReplyCard = {
      type: 'stat',
      data: {
        title: groupBy ? `${groupBy} 分组` : '账单汇总',
        total,
        count,
        period: periodLabel,
        buckets: buckets.length ? buckets : undefined,
      },
    };

    return { result, card };
  }

  /** manageBudget：查询/设置预算（v1 暂只支持 list；set 触发需要客户端确认，暂不开） */
  private async _toolManageBudget(
    ledgerId: string,
    args: any,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const action = String(args?.action ?? 'list');
    if (action !== 'list') {
      return {
        result: { error: '出于安全考虑，AI 暂不支持直接设置/修改预算，请在预算页操作' },
      };
    }
    const budgets = await this.prisma.budget.findMany({
      where: { ledgerId, categoryId: { not: null } },
      include: { category: { select: { name: true } } },
    });
    if (budgets.length === 0) {
      return { result: { items: [], note: '当前账本未设任何预算' } };
    }
    const now = new Date();
    const items: ReplyCard extends { type: 'budget'; data: { items: infer I } }
      ? I
      : any[] = [];
    for (const b of budgets) {
      const [start, end] = budgetPeriod(b.period, now);
      // 子分类支出聚合到父分类下
      const children = await this.prisma.category.findMany({
        where: { parentId: b.categoryId! },
        select: { id: true },
      });
      const ids = [b.categoryId!, ...children.map((c) => c.id)];
      const agg = await this.prisma.bill.aggregate({
        where: {
          ledgerId,
          type: 'expense',
          categoryId: { in: ids },
          date: { gte: start, lte: end },
        },
        _sum: { amount: true },
      });
      const spent = Number(agg._sum.amount ?? 0);
      const limit = Number(b.amount);
      items.push({
        categoryName: b.category?.name ?? '未分类',
        spent,
        limit,
        rate: limit > 0 ? spent / limit : 0,
      });
    }
    return {
      result: { items },
      card: { type: 'budget', data: { items } },
    };
  }

  /** adjustBudget：写操作 → 解析分类名 → 建 CFO 待确认动作 → 回 cfo_action 卡 */
  private async _toolAdjustBudget(
    ledgerId: string,
    args: any,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const name = String(args?.categoryName || '').trim();
    const amount = Number(args?.amount);
    const period = args?.period === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
    if (!name || !isFinite(amount) || amount <= 0) {
      return { result: { error: '缺少分类名或金额无效' } };
    }
    // 分类名是明文，服务端可解析。优先二级精确，再一级。
    const cats = await this.prisma.category.findMany({
      where: { type: 'expense', OR: [{ ledgerId }, { isSystem: true }] },
      select: { id: true, name: true, parentId: true },
    });
    const cat =
      cats.find((c) => c.name === name && c.parentId) ||
      cats.find((c) => c.name === name) ||
      cats.find((c) => c.name.includes(name));
    if (!cat) {
      return { result: { error: `没找到分类「${name}」，请换个说法` } };
    }
    const existing = await this.prisma.budget.findFirst({
      where: { ledgerId, categoryId: cat.id, period },
    });
    const proposal = await this.cfo.createChatAction(ledgerId, {
      actionKind: 'adjust_budget',
      actionParams: {
        budgetId: existing?.id,
        categoryId: cat.id,
        period,
        newLimit: amount,
      },
      title: `把『${cat.name}』${period === 'YEARLY' ? '年' : '月'}预算设为 ¥${amount}`,
      body: existing ? '将更新现有预算。' : '该分类还没有预算，将新建。',
      requiresClient: false,
    });
    return {
      result: { ok: true, message: '已生成待确认动作，等用户在卡片上确认' },
      card: {
        type: 'cfo_action',
        data: {
          proposalId: proposal.id,
          title: proposal.title,
          body: proposal.body,
          actionKind: proposal.actionKind,
          requiresClient: proposal.requiresClient,
          actionParams: proposal.actionParams,
        },
      },
    };
  }

  /** findBills：只读定位账单。只回明文字段，绝不读 noteCipher */
  private async _toolFindBills(
    ledgerId: string,
    args: any,
  ): Promise<{ result: any }> {
    const where: any = { ledgerId };
    if (args?.type === 'expense' || args?.type === 'income') {
      where.type = args.type;
    }
    if (args?.amountMin != null || args?.amountMax != null) {
      where.amount = {};
      if (args.amountMin != null) {
        where.amount.gte = new Prisma.Decimal(String(args.amountMin));
      }
      if (args.amountMax != null) {
        where.amount.lte = new Prisma.Decimal(String(args.amountMax));
      }
    }
    if (args?.dateFrom || args?.dateTo) {
      where.date = {};
      if (args.dateFrom) where.date.gte = new Date(args.dateFrom);
      if (args.dateTo) where.date.lte = new Date(`${args.dateTo}T23:59:59.999`);
    }
    const bills = await this.prisma.bill.findMany({
      where,
      take: 20,
      orderBy: { date: 'desc' },
      select: {
        id: true,
        amount: true,
        date: true,
        type: true,
        category: { select: { name: true } },
      },
    });
    return {
      result: {
        bills: bills.map((b) => ({
          id: b.id,
          amount: Number(b.amount),
          date: b.date.toISOString().slice(0, 10),
          type: b.type,
          categoryName: b.category?.name ?? '其他',
        })),
      },
    };
  }

  /** recategorizeBill：写操作 → 解析目标分类名 → 建 CFO 待确认动作 → 回 cfo_action 卡 */
  private async _toolRecategorizeBill(
    ledgerId: string,
    args: any,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const billId = String(args?.billId || '');
    const targetName = String(args?.targetCategoryName || '').trim();
    if (!billId || !targetName) {
      return { result: { error: '缺少 billId 或目标分类名' } };
    }
    const bill = await this.prisma.bill.findFirst({
      where: { id: billId, ledgerId },
      select: { id: true, type: true, amount: true, date: true },
    });
    if (!bill) return { result: { error: '账单不存在' } };
    const cats = await this.prisma.category.findMany({
      where: { type: bill.type, OR: [{ ledgerId }, { isSystem: true }] },
      select: { id: true, name: true, parentId: true },
    });
    const cat =
      cats.find((c) => c.name === targetName && c.parentId) ||
      cats.find((c) => c.name === targetName) ||
      cats.find((c) => c.name.includes(targetName));
    if (!cat) {
      return { result: { error: `没找到分类「${targetName}」` } };
    }
    const proposal = await this.cfo.createChatAction(ledgerId, {
      actionKind: 'recategorize_bill',
      actionParams: { billId: bill.id, categoryId: cat.id },
      title: `把 ${bill.date.toISOString().slice(0, 10)} 的 ¥${Number(bill.amount)} 改到『${cat.name}』`,
      body: '将只改这笔的分类。',
      requiresClient: false,
    });
    return {
      result: { ok: true, message: '已生成待确认动作' },
      card: {
        type: 'cfo_action',
        data: {
          proposalId: proposal.id,
          title: proposal.title,
          body: proposal.body,
          actionKind: proposal.actionKind,
          requiresClient: proposal.requiresClient,
          actionParams: proposal.actionParams,
        },
      },
    };
  }

  /** allocateToGoal：写操作 → 账户/目标名是密文，服务端不解析 → 存名字，建 CFO 待确认动作 → 回 cfo_action 卡（客户端解析名字+执行） */
  private async _toolAllocateToGoal(
    ledgerId: string,
    args: any,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const fromName = String(args?.fromAccountName || '').trim();
    const goalName = String(args?.goalName || '').trim();
    const amount = Number(args?.amount);
    if (!fromName || !isFinite(amount) || amount <= 0) {
      return { result: { error: '缺少账户名或金额无效' } };
    }
    // 账户名/目标名是密文，服务端不解析 → 存名字，确认时客户端解析
    const proposal = await this.cfo.createChatAction(ledgerId, {
      actionKind: 'allocate_to_goal_byname',
      actionParams: { fromAccountName: fromName, goalName, amount },
      title: `从『${fromName}』转 ¥${amount} 去${goalName ? `『${goalName}』目标` : '储蓄目标'}`,
      body: '确认后由你的设备完成带备注的转账。',
      requiresClient: true,
    });
    return {
      result: { ok: true, message: '已生成待确认动作' },
      card: {
        type: 'cfo_action',
        data: {
          proposalId: proposal.id,
          title: proposal.title,
          body: proposal.body,
          actionKind: proposal.actionKind,
          requiresClient: proposal.requiresClient,
          actionParams: proposal.actionParams,
        },
      },
    };
  }

  /** recordBill：对话记账。绝不建 Proposal、绝不落库（备注明文只随回复卡片传给客户端，
   *  客户端加密后自行 createBill）。这里只解析明文分类名→id，生成临时草稿卡。*/
  private async _toolRecordBill(
    ledgerId: string,
    args: any,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const amount = Number(args?.amount);
    const name = String(args?.categoryName || '').trim();
    const billType: 'expense' | 'income' =
      args?.type === 'income' ? 'income' : 'expense';
    if (!isFinite(amount) || amount <= 0) {
      return { result: { error: '金额无效（需为正数）' } };
    }
    if (!name) {
      return { result: { error: '缺少分类名' } };
    }
    // 分类名是明文，服务端可解析。优先二级精确，再一级，再模糊。
    const cats = await this.prisma.category.findMany({
      where: { type: billType, OR: [{ ledgerId }, { isSystem: true }] },
      select: { id: true, name: true, parentId: true },
    });
    const cat =
      cats.find((c) => c.name === name && c.parentId) ||
      cats.find((c) => c.name === name) ||
      cats.find((c) => c.name.includes(name));
    if (!cat) {
      return { result: { error: `没找到分类「${name}」，请换个说法` } };
    }
    return {
      result: { ok: true, message: '已生成账单草稿，等用户确认' },
      card: {
        type: 'bill_draft',
        data: {
          amount,
          categoryId: cat.id,
          categoryName: cat.name,
          accountName: args?.accountName,
          note: String(args?.note || ''),
          billType,
        },
      },
    };
  }
}

// ── 工具规格 (function calling) ─────────────────────────

const TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'queryStats',
      description:
        '查询账单聚合统计。可按时间段、分类、账户、商户、日/周/月分组。返回 total 总额、count 笔数和可选 buckets 分组明细。',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description:
              "时间段。固定值: today / thisWeek / lastWeek / thisMonth / lastMonth / last30d / thisYear / lastYear；或 'YYYY-MM-DD~YYYY-MM-DD' 格式自定义区间",
          },
          type: {
            type: 'string',
            enum: ['expense', 'income'],
            description: '账单类型，不传则收支都包含',
          },
          categoryIds: {
            type: 'array',
            items: { type: 'string' },
            description: '限定到指定分类 id 列表',
          },
          groupBy: {
            type: 'string',
            enum: ['category', 'account', 'merchant', 'day', 'week', 'month'],
            description: '分组维度。merchant=按商户分组（数据需客户端解密后聚合）',
          },
          limit: {
            type: 'number',
            description: '分组结果最多返回多少条（默认 20，上限 50）',
          },
        },
        required: ['period'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manageBudget',
      description:
        '查询当前账本的预算使用情况（v1 暂只支持只读 list；不要用它来设置/修改预算）',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list'], description: '操作' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adjustBudget',
      description:
        '设置/调整某个分类的预算金额。这是写操作——不会立即生效，会生成一张待用户确认的卡片。用户明确说要"设/调/改预算到某金额"时才用。',
      parameters: {
        type: 'object',
        properties: {
          categoryName: { type: 'string', description: '分类名，如"餐饮""外卖"' },
          period: { type: 'string', enum: ['MONTHLY', 'YEARLY'], description: '周期，默认 MONTHLY' },
          amount: { type: 'number', description: '预算金额（正数，元）' },
        },
        required: ['categoryName', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'findBills',
      description:
        '按金额/日期/类型查找具体账单（返回 id、金额、日期、分类名；看不到加密备注）。用于在"改某笔分类"前先定位账单。',
      parameters: {
        type: 'object',
        properties: {
          amountMin: { type: 'number' },
          amountMax: { type: 'number' },
          dateFrom: { type: 'string', description: 'YYYY-MM-DD' },
          dateTo: { type: 'string', description: 'YYYY-MM-DD' },
          type: { type: 'string', enum: ['expense', 'income'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recategorizeBill',
      description:
        '把某条账单改到另一个分类（写操作，生成待确认卡）。billId 必须来自 findBills。',
      parameters: {
        type: 'object',
        properties: {
          billId: { type: 'string' },
          targetCategoryName: { type: 'string' },
        },
        required: ['billId', 'targetCategoryName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'allocateToGoal',
      description:
        '把某账户的闲钱转到某个储蓄目标（写操作，生成待确认卡；实际转账在用户确认时由客户端完成）。',
      parameters: {
        type: 'object',
        properties: {
          fromAccountName: { type: 'string', description: '转出账户名，如"招商卡"' },
          goalName: { type: 'string', description: '目标名，如"旅游"' },
          amount: { type: 'number', description: '金额（元）' },
        },
        required: ['fromAccountName', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recordBill',
      description:
        '从自然语言记一笔账（如"记一笔 午饭35""中午湘菜馆180"）。把金额、分类、备注抽出来。这只会生成一张待用户确认的账单草稿卡，不会立即记账保存——确认与否、最终加密入账由用户在客户端完成。',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: '金额（正数，元）' },
          categoryName: { type: 'string', description: '分类名，如"餐饮""午饭""交通"' },
          accountName: {
            type: 'string',
            description: '账户名（如"招商卡""微信"）。不清楚就别填，客户端会用默认账户',
          },
          note: { type: 'string', description: '备注，如商户名/事由；可空' },
          type: {
            type: 'string',
            enum: ['expense', 'income'],
            description: '账单类型，默认 expense',
          },
        },
        required: ['amount', 'categoryName'],
      },
    },
  },
];

const SYSTEM_PROMPT = `你是「司库」app 内的财务助手。用户用中文问你账目相关问题，你的工作是：
1. 把模糊的中文问句转成结构化查询，调用 queryStats / manageBudget 工具
2. 拿到工具结果后，用 1-3 句中文做归纳总结回复，不要重复全部数字
3. 涉及金额时单位是人民币(¥)
4. 涉及"上月""本月"等相对时间，自己换算成 queryStats 的 period 参数
5. 用户问"美团/瑞幸/某商户花了多少" → groupBy=merchant
6. 用户问"哪个分类花得多" → groupBy=category
7. 数据缺失或全是 0 时坦率说"这段时间没找到相关账单"，不要编造
8. 不要泄露内部工具调用过程，回答里只出现自然语言结果
9. 写操作（如调预算）只能"提议"：调用对应工具会生成一张待用户确认的卡片，你绝不能声称"已经改好了"；确认与否由用户点卡片决定。回复里说"给你生成了一张确认卡，确认后即生效"之类即可。
10. 调预算前若分类/金额不清楚，先追问，不要乱猜。
11. 用户要"改某笔的分类"时，先用 findBills（按金额/日期）定位；若命中多笔，列出来让用户说清是哪笔，再用 recategorizeBill。
12. 用户说"记一笔/我花了X买了Y"时用 recordBill，把金额/分类/备注抽出来；它只生成待确认草稿卡，不是立即记账；账户不清楚就别填（留空，客户端用默认账户）。

记住：你看不到任何账单备注的明文（端到端加密），所以涉及商户分析时一定要走 groupBy=merchant 让客户端帮你聚合。`;

// ── 工具辅助 ──────────────────────────────────────────

function safeParse(s: string): any {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function parsePeriod(p: string | undefined): [Date, Date] {
  const now = new Date();
  const tag = (p || 'thisMonth').trim();

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
  const endOfMonth = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);

  switch (tag) {
    case 'today':
      return [startOfDay(now), endOfDay(now)];
    case 'thisWeek': {
      const dow = now.getDay() || 7; // 周日=0→7
      const monday = new Date(now);
      monday.setDate(now.getDate() - (dow - 1));
      return [startOfDay(monday), endOfDay(now)];
    }
    case 'lastWeek': {
      const dow = now.getDay() || 7;
      const lastSun = new Date(now);
      lastSun.setDate(now.getDate() - dow);
      const lastMon = new Date(lastSun);
      lastMon.setDate(lastSun.getDate() - 6);
      return [startOfDay(lastMon), endOfDay(lastSun)];
    }
    case 'thisMonth':
      return [startOfMonth(now), endOfMonth(now)];
    case 'lastMonth': {
      const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return [lm, endOfMonth(lm)];
    }
    case 'last30d': {
      const s = new Date(now);
      s.setDate(now.getDate() - 30);
      return [startOfDay(s), endOfDay(now)];
    }
    case 'thisYear':
      return [
        new Date(now.getFullYear(), 0, 1),
        new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
      ];
    case 'lastYear':
      return [
        new Date(now.getFullYear() - 1, 0, 1),
        new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999),
      ];
  }

  // 自定义 YYYY-MM-DD~YYYY-MM-DD
  const m = tag.match(/^(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})$/);
  if (m) {
    const s = new Date(m[1]);
    const e = new Date(m[2]);
    return [startOfDay(s), endOfDay(e)];
  }

  // 兜底当本月
  return [startOfMonth(now), endOfMonth(now)];
}

function bucketKey(date: Date, by: 'day' | 'week' | 'month'): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  if (by === 'day') return `${y}-${m}-${d}`;
  if (by === 'month') return `${y}-${m}`;
  // week: ISO 周编号近似（本周一）
  const dow = date.getDay() || 7;
  const monday = new Date(date);
  monday.setDate(date.getDate() - (dow - 1));
  const ym = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  return `周@${ym}`;
}

function budgetPeriod(p: string, now: Date): [Date, Date] {
  if (p === 'YEARLY') {
    return [
      new Date(now.getFullYear(), 0, 1),
      new Date(now.getFullYear(), 11, 31, 23, 59, 59),
    ];
  }
  return [
    new Date(now.getFullYear(), now.getMonth(), 1),
    new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59),
  ];
}
