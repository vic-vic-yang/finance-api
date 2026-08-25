import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgersService } from '../ledgers/ledgers.service';
import { CfoService } from '../cfo/cfo.service';
import { ForecastService } from '../forecast/forecast.service';
import { HealthService } from '../health/health.service';
import { InsightsService } from '../insights/insights.service';
import { RecurringService } from '../recurring/recurring.service';
import { ReconcileService } from '../reconcile/reconcile.service';
import { LoansService } from '../loans/loans.service';
import { LlmRegistry } from './llm/llm-registry';
import { ResolvedLlm } from './llm/llm-resolver';
import {
  ChatMessage,
  ChatResponse,
  ToolSpec,
} from './llm/chat-model';
import {
  buildDigestSlices,
  buildKnowledgeText,
  DigestEnrichment,
} from './knowledge-digest';
import {
  ClientTask,
  fetchBillIdsInPeriod,
  formatPeriodLabel,
} from './chat-client-tasks';
import { buildPlan } from './chat-planner';

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
    }
  | {
      type: 'recurring_draft';
      data: {
        amount: number;
        categoryId: string;
        categoryName: string;
        accountName?: string;
        note: string;
        billType: 'expense' | 'income';
        cycleType: 'monthly' | 'weekly' | 'yearly';
        cycleDay: number;
      };
    }
  | {
      type: 'bill_list';
      data: {
        title: string;
        items: {
          id: string;
          amount: number;
          date: string;
          type: string;
          categoryName: string;
        }[];
      };
    }
  | {
      type: 'forecast';
      data: {
        currentNetWorth: number;
        projectedMonthEnd: number;
        remainingDays: number;
        mtdExpense: number;
        projectedMonthExpense?: number;
        monthlyBudget?: number | null;
      };
    }
  | {
      type: 'health';
      data: {
        score: number;
        grade: string;
        dimensions: {
          label: string;
          score: number;
          advice: string;
        }[];
      };
    }
  | {
      type: 'insight_list';
      data: {
        items: { title: string; body: string; severity: string }[];
      };
    }
  | {
      type: 'recurring';
      data: {
        monthlyFixedExpense: number;
        items: {
          categoryName: string;
          amount: number;
          nextDate: string;
          daysUntil: number;
        }[];
      };
    }
  | {
      type: 'reconcile';
      data: {
        month: string;
        totalIssues: number;
        sections: { title: string; count: number; severity: string }[];
      };
    }
  | {
      type: 'goal';
      data: {
        name: string;
        saved: number;
        target: number;
        progress: number;
        isCompleted: boolean;
        remaining: number;
      };
    }
  | {
      type: 'loans';
      data: {
        receivable: number;
        payable: number;
        items: {
          direction: string;
          outstanding: number;
          date: string;
        }[];
      };
    }
  | {
      type: 'comparison';
      data: {
        title: string;
        current: { label: string; amount: number; count: number };
        baseline: { label: string; amount: number; count: number };
        changeRate: number;
        buckets?: {
          label: string;
          current: number;
          baseline: number;
        }[];
      };
    }
  | {
      type: 'holdings';
      data: {
        totalCost: number;
        totalMarket: number;
        totalPnl: number;
        items: {
          symbol: string;
          shares: number;
          cost: number;
          marketValue: number;
          pnl: number;
          pnlRate: number;
        }[];
      };
    };

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatReply {
  reply: string;
  cards: ReplyCard[];
  // 若服务器需要客户端做商户聚合（通路 B），返回需要解密的 billIds（兼容旧客户端）
  pendingClientAggregation?: { task: 'merchant'; billIds: string[]; period: string };
  /** 端侧任务队列：备注搜索 / 按账户名查账 / 按目标名查进度 */
  pendingClientTasks?: ClientTask[];
  /** Plan 模式：建议的工具调用顺序（供客户端展示） */
  plan?: { steps: string[] };
  // 完整的 messages 流（供 client 继续保留上下文）
  followupMessages: ChatTurn[];
  // 调试
  usage?: { prompt: number; completion: number; total: number };
  toolCallsTrace?: { name: string; args: any; result: any }[];
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private static readonly MAX_TOOL_LOOPS = 5;
  private static readonly MAX_HISTORY_TURNS = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgers: LedgersService,
    private readonly cfo: CfoService,
    private readonly llmRegistry: LlmRegistry,
    private readonly forecast: ForecastService,
    private readonly health: HealthService,
    private readonly insights: InsightsService,
    private readonly recurring: RecurringService,
    private readonly reconcile: ReconcileService,
    private readonly loans: LoansService,
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

    // 财务知识库摘要：按用户消息关键词路由出相关切片（本月/上月收支、预算、
    // 目标、借贷、账户），文本化后注入 system 上下文。只聚合明文字段，
    // 摘要构建失败不阻断对话（降级为无摘要）。
    let knowledge = '';
    try {
      const [digestSlices, enrichment] = await Promise.all([
        buildDigestSlices(this.prisma, ledgerId, userId, new Date()),
        this._buildEnrichment(userId, ledgerId),
      ]);
      knowledge = buildKnowledgeText(trimmed, digestSlices, enrichment);
    } catch (e: any) {
      this.logger.warn(`knowledge digest 构建失败: ${e?.message}`);
    }

    const plan = buildPlan(trimmed);

    // 构造 messages
    const sysContent = [
      knowledge ? `${SYSTEM_PROMPT}\n\n${knowledge}` : SYSTEM_PROMPT,
      plan?.hint,
    ]
      .filter(Boolean)
      .join('\n\n');
    const sys: ChatMessage = {
      role: 'system',
      content: sysContent,
    };
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
    const pendingClientTasks: ClientTask[] = [];
    let totalUsage = { prompt: 0, completion: 0, total: 0 };

    // 工具循环（多轮 tool_calls）
    let res: ChatResponse | null = null;
    try {
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
          const { result, card, aggregation, clientTask } = await this._runTool(
            ledgerId,
            userId,
            call.function.name,
            args,
          );
          toolTrace.push({ name: call.function.name, args, result });
          if (card) cards.push(card);
          if (aggregation) {
            pendingClientAggregation = aggregation;
            pendingClientTasks.push(aggregation);
          }
          if (clientTask) pendingClientTasks.push(clientTask);

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: JSON.stringify(result),
          });
        }
      }
    } catch (e: any) {
      this.logger.error(`chat LLM 失败: ${e?.message ?? e}`);
      const hint = String(e?.message ?? '请稍后重试').replace(/^LLM\[[^\]]+\]\s*/, '');
      return {
        reply: `AI 暂时不可用：${hint}`,
        cards: [],
        followupMessages: [
          ...recentHist,
          { role: 'user', content: trimmed },
        ],
      };
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
      pendingClientTasks: pendingClientTasks.length ? pendingClientTasks : undefined,
      plan: plan ? { steps: plan.steps } : undefined,
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
    clientTask?: ClientTask;
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
      if (name === 'createRecurring') {
        return await this._toolCreateRecurring(ledgerId, args);
      }
      if (name === 'getForecast') {
        return await this._toolGetForecast(userId, ledgerId);
      }
      if (name === 'getHealthScore') {
        return await this._toolGetHealthScore(userId, ledgerId);
      }
      if (name === 'listInsights') {
        return await this._toolListInsights(userId, ledgerId, args);
      }
      if (name === 'listRecurring') {
        return await this._toolListRecurring(userId, ledgerId);
      }
      if (name === 'getReconcileSummary') {
        return await this._toolGetReconcileSummary(userId, ledgerId, args);
      }
      if (name === 'listLoans') {
        return await this._toolListLoans(ledgerId, args);
      }
      if (name === 'searchByNote') {
        return await this._toolSearchByNote(ledgerId, args);
      }
      if (name === 'queryAccountByName') {
        return await this._toolQueryAccountByName(args);
      }
      if (name === 'getGoalByName') {
        return await this._toolGetGoalByName(args);
      }
      if (name === 'comparePeriods') {
        return await this._toolComparePeriods(ledgerId, args);
      }
      if (name === 'queryTransfers') {
        return await this._toolQueryTransfers(ledgerId, args);
      }
      if (name === 'listStockHoldings') {
        return await this._toolListStockHoldings(userId, ledgerId);
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
    // 收支口径：转账腿与股票纸面盈亏都不算收支（与统计/预算一致）
    const where: Prisma.BillWhereInput = {
      ledgerId,
      isTransfer: false,
      source: { not: 'stock' },
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

    const periodLabel = formatPeriodLabel(args?.period, start, end);

    // 商户聚合：服务器看不到 note → 通路 B
    if (groupBy === 'merchant') {
      const billType =
        args?.type === 'expense' || args?.type === 'income'
          ? args.type
          : undefined;
      const meta = await fetchBillIdsInPeriod(
        this.prisma,
        ledgerId,
        start,
        end,
        periodLabel,
        billType,
        200,
      );
      return {
        result: {
          total,
          count,
          period: periodLabel,
          needsClientAggregation: true,
          billIds: meta.billIds,
          note: '商户名在客户端加密，服务器无法聚合；客户端会解密这些账单本地聚合后再展示。',
        },
        aggregation: {
          task: 'merchant',
          billIds: meta.billIds,
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
          isTransfer: false,
          source: { not: 'stock' },
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
  ): Promise<{ result: any; card?: ReplyCard }> {
    const where: any = { ledgerId, isTransfer: false };
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
    const items = bills.map((b) => ({
      id: b.id,
      amount: Number(b.amount),
      date: b.date.toISOString().slice(0, 10),
      type: b.type,
      categoryName: b.category?.name ?? '其他',
    }));
    return {
      result: { bills: items, count: items.length },
      card:
        items.length > 0
          ? {
              type: 'bill_list',
              data: { title: '找到的账单', items },
            }
          : undefined,
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

  /** createRecurring：添加周期账单。备注/账户名明文只随卡片传给客户端，确认后加密入库。 */
  private async _toolCreateRecurring(
    ledgerId: string,
    args: any,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const amount = Number(args?.amount);
    const name = String(args?.categoryName || '').trim();
    const billType: 'expense' | 'income' =
      args?.type === 'income' ? 'income' : 'expense';
    const cycleTypeRaw = String(args?.cycleType || 'monthly').toLowerCase();
    const cycleType: 'monthly' | 'weekly' | 'yearly' =
      cycleTypeRaw === 'weekly'
        ? 'weekly'
        : cycleTypeRaw === 'yearly'
          ? 'yearly'
          : 'monthly';
    const cycleDay = Math.round(Number(args?.cycleDay ?? 1));

    if (!isFinite(amount) || amount <= 0) {
      return { result: { error: '金额无效（需为正数）' } };
    }
    if (!name) {
      return { result: { error: '缺少分类名' } };
    }
    if (!Number.isFinite(cycleDay) || cycleDay < 1) {
      return { result: { error: '扣款日无效' } };
    }
    if (cycleType === 'monthly' && cycleDay > 31) {
      return { result: { error: '每月扣款日需在 1-31 之间' } };
    }
    if (cycleType === 'weekly' && (cycleDay < 1 || cycleDay > 7)) {
      return { result: { error: '每周扣款日需在 1(周一)-7(周日) 之间' } };
    }

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
      result: { ok: true, message: '已生成周期账单草稿，等用户在卡片上确认' },
      card: {
        type: 'recurring_draft',
        data: {
          amount,
          categoryId: cat.id,
          categoryName: cat.name,
          accountName: args?.accountName,
          note: String(args?.note || ''),
          billType,
          cycleType,
          cycleDay,
        },
      },
    };
  }

  // ── 只读扩展工具（复用各业务 Service）────────────────────

  private async _buildEnrichment(
    userId: string,
    ledgerId: string,
  ): Promise<DigestEnrichment> {
    const [fc, hl, ins, rec] = await Promise.all([
      this.forecast.getForecast(userId, ledgerId).catch(() => null),
      this.health.score(userId, ledgerId).catch(() => null),
      this.insights.list(userId, ledgerId).catch(() => null),
      this.recurring.findAll(userId, ledgerId).catch(() => null),
    ]);
    const enrichment: DigestEnrichment = {};
    if (fc?.monthEndNetWorth) {
      enrichment.forecast = {
        currentNetWorth: fc.monthEndNetWorth.current,
        projectedMonthEnd: fc.monthEndNetWorth.projected,
        remainingDays: fc.monthEndNetWorth.remainingDays,
        mtdExpense: fc.monthEndNetWorth.mtdExpense,
      };
    }
    if (hl) {
      const dims = hl.dimensions ?? [];
      const weakest = dims.reduce(
        (a, b) => (a.score <= b.score ? a : b),
        dims[0] ?? { label: '—', advice: '—', score: 0 },
      );
      enrichment.health = {
        score: hl.score,
        grade: hl.grade,
        weakestLabel: weakest.label,
        weakestAdvice: weakest.advice,
      };
    }
    if (ins?.insights) {
      const list = ins.insights;
      enrichment.insights = {
        total: list.length,
        critical: list.filter((i) => i.severity === 'critical').length,
        titles: list.slice(0, 3).map((i) => i.title),
      };
    }
    if (rec?.recurring) {
      const items = rec.recurring as Array<{
        type: string;
        amount: number;
        nextDate: string | Date;
        cycleType: string;
      }>;
      let monthlyFixed = 0;
      const now = Date.now();
      let nextDue: number | null = null;
      for (const r of items) {
        if (r.type === 'expense' && r.cycleType === 'monthly') {
          monthlyFixed += Number(r.amount);
        }
        const nd = new Date(r.nextDate).getTime();
        const days = Math.ceil((nd - now) / 86_400_000);
        if (days >= 0 && (nextDue === null || days < nextDue)) nextDue = days;
      }
      enrichment.recurring = {
        activeCount: items.length,
        monthlyFixedExpense: monthlyFixed,
        nextDueInDays: nextDue,
      };
    }
    return enrichment;
  }

  private async _toolGetForecast(
    userId: string,
    ledgerId: string,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const fc = await this.forecast.getForecast(userId, ledgerId);
    const m = fc.monthEndNetWorth;
    const pace = fc.expensePace;
    const result = {
      currentNetWorth: m.current,
      projectedMonthEnd: m.projected,
      method: m.method,
      remainingDays: m.remainingDays,
      mtdIncome: m.mtdIncome,
      mtdExpense: m.mtdExpense,
      remainingIncome: m.remainingIncome,
      remainingExpense: m.remainingExpense,
      upcoming30Count: (fc.upcoming30 as unknown[])?.length ?? 0,
      projectedMonthExpense: pace?.projectedMonthExpense,
      monthlyBudget: pace?.monthlyBudget,
    };
    return {
      result,
      card: {
        type: 'forecast',
        data: {
          currentNetWorth: m.current,
          projectedMonthEnd: m.projected,
          remainingDays: m.remainingDays,
          mtdExpense: m.mtdExpense,
          projectedMonthExpense: pace?.projectedMonthExpense,
          monthlyBudget: pace?.monthlyBudget ?? null,
        },
      },
    };
  }

  private async _toolGetHealthScore(
    userId: string,
    ledgerId: string,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const hl = await this.health.score(userId, ledgerId);
    const dimensions = (hl.dimensions ?? []).map((d) => ({
      label: d.label,
      score: d.score,
      advice: d.advice,
    }));
    return {
      result: { score: hl.score, grade: hl.grade, dimensions },
      card: {
        type: 'health',
        data: { score: hl.score, grade: hl.grade, dimensions },
      },
    };
  }

  private async _toolListInsights(
    userId: string,
    ledgerId: string,
    args: any,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const { insights } = await this.insights.list(userId, ledgerId);
    const limit = Math.min(Number(args?.limit ?? 5), 10);
    const severity = args?.severity as string | undefined;
    let list = insights;
    if (severity === 'critical' || severity === 'warning') {
      list = list.filter((i) => i.severity === severity);
    }
    const top = list.slice(0, limit);
    const items = top.map((i) => ({
      title: i.title,
      body: i.body,
      severity: i.severity,
    }));
    return {
      result: { count: insights.length, shown: items },
      card: items.length ? { type: 'insight_list', data: { items } } : undefined,
    };
  }

  private async _toolListRecurring(
    userId: string,
    ledgerId: string,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const { recurring: rows } = await this.recurring.findAll(userId, ledgerId);
    const catIds = [...new Set(rows.map((r) => r.categoryId))];
    const cats = catIds.length
      ? await this.prisma.category.findMany({
          where: { id: { in: catIds } },
          select: { id: true, name: true, parentId: true },
        })
      : [];
    const parentIds = cats.map((c) => c.parentId).filter(Boolean) as string[];
    const parents = parentIds.length
      ? await this.prisma.category.findMany({
          where: { id: { in: parentIds } },
          select: { id: true, name: true },
        })
      : [];
    const parentMap = new Map(parents.map((p) => [p.id, p.name]));
    const catLabel = (id: string) => {
      const c = cats.find((x) => x.id === id);
      if (!c) return '未分类';
      return c.parentId
        ? `${parentMap.get(c.parentId) ?? ''}›${c.name}`
        : c.name;
    };
    const now = Date.now();
    let monthlyFixed = 0;
    const items = rows.map((r) => {
      if (r.type === 'expense' && r.cycleType === 'monthly') {
        monthlyFixed += Number(r.amount);
      }
      const nd = new Date(r.nextDate);
      const daysUntil = Math.ceil((nd.getTime() - now) / 86_400_000);
      return {
        categoryName: catLabel(r.categoryId),
        amount: Number(r.amount),
        nextDate: nd.toISOString().slice(0, 10),
        daysUntil,
      };
    });
    items.sort((a, b) => a.daysUntil - b.daysUntil);
    return {
      result: { monthlyFixedExpense: monthlyFixed, items },
      card: {
        type: 'recurring',
        data: { monthlyFixedExpense: monthlyFixed, items: items.slice(0, 8) },
      },
    };
  }

  private async _toolGetReconcileSummary(
    userId: string,
    ledgerId: string,
    args: any,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const month = args?.month as string | undefined;
    const rep = await this.reconcile.report(userId, ledgerId, month);
    const sections = (rep.sections ?? []).map((s: any) => ({
      key: s.key,
      title: s.title,
      count: s.count,
      severity: s.severity,
    }));
    const totalIssues = sections.reduce((n: number, s: any) => n + s.count, 0);
    return {
      result: { month: rep.month, totalIssues, sections },
      card: {
        type: 'reconcile',
        data: {
          month: rep.month,
          totalIssues,
          sections: sections.map((s: any) => ({
            title: s.title,
            count: s.count,
            severity: s.severity,
          })),
        },
      },
    };
  }

  private async _toolListLoans(
    ledgerId: string,
    args: any,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const summary = await this.loans.summary(ledgerId);
    const all = await this.loans.list(ledgerId);
    const unsettledOnly = args?.unsettledOnly !== false;
    const items = (unsettledOnly ? all.filter((l) => !l.settled) : all)
      .slice(0, 15)
      .map((l) => ({
        direction: l.direction,
        outstanding: l.outstanding,
        date: l.date.slice(0, 10),
      }));
    return {
      result: {
        receivable: summary.receivable,
        payable: summary.payable,
        items,
      },
      card: {
        type: 'loans',
        data: {
          receivable: summary.receivable,
          payable: summary.payable,
          items,
        },
      },
    };
  }

  /** searchByNote：备注关键词搜索 → 客户端解密备注后过滤聚合 */
  private async _toolSearchByNote(
    ledgerId: string,
    args: any,
  ): Promise<{ result: any; clientTask?: ClientTask }> {
    const keyword = String(args?.keyword || '').trim();
    if (!keyword) {
      return { result: { error: '缺少搜索关键词' } };
    }
    const [start, end] = parsePeriod(args?.period);
    const periodLabel = formatPeriodLabel(args?.period, start, end);
    const billType =
      args?.type === 'expense' || args?.type === 'income'
        ? args.type
        : undefined;
    const meta = await fetchBillIdsInPeriod(
      this.prisma,
      ledgerId,
      start,
      end,
      periodLabel,
      billType,
    );
    return {
      result: {
        keyword,
        period: periodLabel,
        billCount: meta.billIds.length,
        needsClientResolution: true,
        note: '备注加密存于客户端，已下发账单 id 列表供本地搜索。',
      },
      clientTask: {
        task: 'note_search',
        keyword,
        billIds: meta.billIds,
        period: periodLabel,
        dateFrom: meta.dateFrom,
        dateTo: meta.dateTo,
      },
    };
  }

  /** queryAccountByName：账户名加密 → 客户端匹配账户后聚合流水 */
  private async _toolQueryAccountByName(
    args: any,
  ): Promise<{ result: any; clientTask?: ClientTask }> {
    const accountName = String(args?.accountName || '').trim();
    if (!accountName) {
      return { result: { error: '缺少账户名' } };
    }
    const [start, end] = parsePeriod(args?.period);
    const periodLabel = formatPeriodLabel(args?.period, start, end);
    const billType =
      args?.type === 'expense' || args?.type === 'income'
        ? args.type
        : undefined;
    return {
      result: {
        accountName,
        period: periodLabel,
        needsClientResolution: true,
        note: '账户名加密，已请求客户端按名称匹配账户并汇总流水。',
      },
      clientTask: {
        task: 'account_query',
        accountName,
        period: periodLabel,
        dateFrom: start.toISOString().slice(0, 10),
        dateTo: end.toISOString().slice(0, 10),
        billType,
      },
    };
  }

  /** getGoalByName：目标名加密 → 客户端匹配后展示进度 */
  private async _toolGetGoalByName(
    args: any,
  ): Promise<{ result: any; clientTask?: ClientTask }> {
    const goalName = String(args?.goalName || '').trim();
    if (!goalName) {
      return { result: { error: '缺少目标名' } };
    }
    return {
      result: {
        goalName,
        needsClientResolution: true,
        note: '目标名加密，已请求客户端按名称匹配并展示进度。',
      },
      clientTask: { task: 'goal_progress', goalName },
    };
  }

  /** comparePeriods：两段时间收支对比（环比/同比） */
  private async _toolComparePeriods(
    ledgerId: string,
    args: any,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const currentTag = String(args?.current ?? 'thisMonth');
    const baselineTag = String(args?.baseline ?? 'lastMonth');
    const billType =
      args?.type === 'expense' || args?.type === 'income' ? args.type : 'expense';
    const groupBy = args?.groupBy === 'category' ? 'category' : undefined;

    const [cStart, cEnd] = parsePeriod(currentTag);
    const [bStart, bEnd] = parsePeriod(baselineTag);
    const cLabel = formatPeriodLabel(currentTag, cStart, cEnd);
    const bLabel = formatPeriodLabel(baselineTag, bStart, bEnd);

    const flow = (start: Date, end: Date) => ({
      ledgerId,
      isTransfer: false,
      source: { not: 'stock' },
      type: billType as 'expense' | 'income',
      date: { gte: start, lte: end },
    });

    const [cAgg, bAgg] = await Promise.all([
      this.prisma.bill.aggregate({
        where: flow(cStart, cEnd),
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.bill.aggregate({
        where: flow(bStart, bEnd),
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

    const cAmount = Number(cAgg._sum.amount ?? 0);
    const bAmount = Number(bAgg._sum.amount ?? 0);
    const changeRate = bAmount > 0 ? cAmount / bAmount - 1 : cAmount > 0 ? 1 : 0;

    let buckets:
      | { label: string; current: number; baseline: number }[]
      | undefined;

    if (groupBy === 'category') {
      const [cGrp, bGrp] = await Promise.all([
        this.prisma.bill.groupBy({
          by: ['categoryId'],
          where: flow(cStart, cEnd),
          _sum: { amount: true },
        }),
        this.prisma.bill.groupBy({
          by: ['categoryId'],
          where: flow(bStart, bEnd),
          _sum: { amount: true },
        }),
      ]);
      const catIds = [
        ...new Set([
          ...cGrp.map((g) => g.categoryId),
          ...bGrp.map((g) => g.categoryId),
        ]),
      ];
      const cats = catIds.length
        ? await this.prisma.category.findMany({
            where: { id: { in: catIds } },
            select: { id: true, name: true },
          })
        : [];
      const catMap = new Map(cats.map((c) => [c.id, c.name]));
      const bMap = new Map(
        bGrp.map((g) => [g.categoryId, Number(g._sum.amount ?? 0)]),
      );
      buckets = cGrp
        .map((g) => ({
          label: catMap.get(g.categoryId) ?? '未分类',
          current: Number(g._sum.amount ?? 0),
          baseline: bMap.get(g.categoryId) ?? 0,
        }))
        .sort((a, b) => b.current - a.current)
        .slice(0, 5);
    }

    const typeLabel = billType === 'income' ? '收入' : '支出';
    const title = `${cLabel} vs ${bLabel}${typeLabel}`;

    return {
      result: {
        current: { label: cLabel, amount: cAmount, count: cAgg._count._all },
        baseline: { label: bLabel, amount: bAmount, count: bAgg._count._all },
        changeRate,
        buckets,
      },
      card: {
        type: 'comparison',
        data: {
          title,
          current: {
            label: cLabel,
            amount: cAmount,
            count: cAgg._count._all,
          },
          baseline: {
            label: bLabel,
            amount: bAmount,
            count: bAgg._count._all,
          },
          changeRate,
          buckets,
        },
      },
    };
  }

  /** queryTransfers：转账记录（账户名加密 → 客户端配对展示） */
  private async _toolQueryTransfers(
    ledgerId: string,
    args: any,
  ): Promise<{ result: any; clientTask?: ClientTask }> {
    const [start, end] = parsePeriod(args?.period);
    const periodLabel = formatPeriodLabel(args?.period, start, end);
    const limit = Math.min(Number(args?.limit ?? 15), 30);

    const bills = await this.prisma.bill.findMany({
      where: {
        ledgerId,
        isTransfer: true,
        date: { gte: start, lte: end },
      },
      select: {
        id: true,
        amount: true,
        date: true,
        type: true,
        accountId: true,
      },
      orderBy: { date: 'desc' },
      take: limit * 2,
    });

    const expenses = bills.filter((b) => b.type === 'expense');
    const incomes = bills.filter((b) => b.type === 'income');
    const usedIncome = new Set<string>();
    const pairs: {
      amount: number;
      date: string;
      fromAccountId: string;
      toAccountId: string;
    }[] = [];

    for (const e of expenses) {
      const amt = Number(e.amount);
      const match = incomes.find((i) => {
        if (usedIncome.has(i.id)) return false;
        if (Number(i.amount) !== amt) return false;
        const diff = Math.abs(i.date.getTime() - e.date.getTime());
        return diff <= 4 * 86_400_000;
      });
      if (match) {
        usedIncome.add(match.id);
        pairs.push({
          amount: amt,
          date: e.date.toISOString().slice(0, 10),
          fromAccountId: e.accountId,
          toAccountId: match.accountId,
        });
      }
      if (pairs.length >= limit) break;
    }

    return {
      result: {
        period: periodLabel,
        count: pairs.length,
        totalAmount: pairs.reduce((s, p) => s + p.amount, 0),
        needsClientResolution: true,
      },
      clientTask: {
        task: 'transfer_list',
        period: periodLabel,
        dateFrom: start.toISOString().slice(0, 10),
        dateTo: end.toISOString().slice(0, 10),
        pairs,
      },
    };
  }

  /** listStockHoldings：股票持仓摘要（symbol 明文） */
  private async _toolListStockHoldings(
    userId: string,
    ledgerId: string,
  ): Promise<{ result: any; card?: ReplyCard }> {
    const rows = await this.prisma.stockHolding.findMany({
      where: {
        userId,
        OR: [{ ledgerId }, { ledgerId: null }],
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (rows.length === 0) {
      return {
        result: { count: 0, note: '当前没有股票持仓' },
      };
    }

    let totalCost = 0;
    let totalMarket = 0;
    const items = rows.map((r) => {
      const shares = Number(r.shares);
      const buy = Number(r.buyPrice);
      const last = r.lastPrice != null ? Number(r.lastPrice) : buy;
      const cost = buy * shares;
      const market = last * shares;
      const pnl = market - cost;
      const pnlRate = cost > 0 ? pnl / cost : 0;
      totalCost += cost;
      totalMarket += market;
      return {
        symbol: r.symbol,
        shares,
        cost: Math.round(cost * 100) / 100,
        marketValue: Math.round(market * 100) / 100,
        pnl: Math.round(pnl * 100) / 100,
        pnlRate: Math.round(pnlRate * 1000) / 1000,
      };
    });

    const totalPnl = totalMarket - totalCost;

    return {
      result: {
        count: items.length,
        totalCost,
        totalMarket,
        totalPnl,
        items,
      },
      card: {
        type: 'holdings',
        data: {
          totalCost: Math.round(totalCost * 100) / 100,
          totalMarket: Math.round(totalMarket * 100) / 100,
          totalPnl: Math.round(totalPnl * 100) / 100,
          items: items.slice(0, 10),
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
        '按金额/日期/类型查找具体账单（返回 id、金额、日期、分类名；看不到加密备注）。用于定位账单或改分类前先 findBills；结果会生成 bill_list 明细卡。',
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
  {
    type: 'function',
    function: {
      name: 'createRecurring',
      description:
        '添加周期账单/固定支出（如"每月5号话费100""每月11号给爸1000"）。写操作——不会立即入库，会为每一项生成一张带「确认/取消」按钮的周期账单草稿卡；多项就调用多次。绝不要只文字问用户"是否确认"，必须调此工具出卡片。',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: '金额（正数，元）' },
          categoryName: { type: 'string', description: '分类名，如"通讯""人情往来"' },
          accountName: {
            type: 'string',
            description: '扣款账户名。不清楚可不填，客户端用默认账户',
          },
          note: { type: 'string', description: '备注/名称，如"话费""给爸"' },
          cycleType: {
            type: 'string',
            enum: ['monthly', 'weekly', 'yearly'],
            description: '周期类型，默认 monthly',
          },
          cycleDay: {
            type: 'number',
            description: '扣款日：monthly=1-31号；weekly=1周一~7周日；yearly=mmdd如815',
          },
          type: {
            type: 'string',
            enum: ['expense', 'income'],
            description: '类型，默认 expense',
          },
        },
        required: ['amount', 'categoryName', 'cycleDay'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getForecast',
      description:
        '现金流预测：当前净资产、预计月末结余、本月已支出、支出速率与预算对比、未来30天周期扣款数量。用户问"月末还能剩多少""预测结余""会不会超支"时用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getHealthScore',
      description:
        '财务健康评分（0-100）及五维短板与建议。用户问"财务健康怎么样""评分多少""哪里做得不好"时用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listInsights',
      description:
        'AI 消费洞察列表：大额异常、分类涨跌、预算预警、周期到期、信用卡还款提醒等。用户问"有什么风险/预警/异常"时用。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多返回几条，默认 5' },
          severity: {
            type: 'string',
            enum: ['critical', 'warning'],
            description: '只看待指定严重级别',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listRecurring',
      description:
        '周期账单/订阅列表：月固定支出合计、每项金额与下次扣款日。用户问"固定支出""订阅""房租什么时候扣"时用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getReconcileSummary',
      description:
        '对账中心摘要：余额漂移、疑似重复、周期缺记、转账缺腿等问题计数（只读，不自动修复）。用户问"有没有重复记账""对账有问题吗"时用。',
      parameters: {
        type: 'object',
        properties: {
          month: {
            type: 'string',
            description: 'YYYY-MM，默认当月',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listLoans',
      description:
        '借贷往来：别人欠我(应收)、我欠别人(应付)汇总与明细（对方名加密不可见）。用户问"借出去多少""欠多少""借贷"时用。',
      parameters: {
        type: 'object',
        properties: {
          unsettledOnly: {
            type: 'boolean',
            description: '只列未结清，默认 true',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchByNote',
      description:
        '按备注关键词搜索账单（备注端到端加密，需客户端解密）。用户问"备注里含XX""买菜/外卖/某店名"等无法用分类覆盖的搜索时用。与 queryStats groupBy=merchant 类似但支持任意关键词。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '备注中要搜的关键词，如"美团""买菜"' },
          period: {
            type: 'string',
            description:
              "时间段：today / thisMonth / lastMonth / last30d 等，或 YYYY-MM-DD~YYYY-MM-DD",
          },
          type: {
            type: 'string',
            enum: ['expense', 'income'],
            description: '可选，限定收支类型',
          },
        },
        required: ['keyword', 'period'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'queryAccountByName',
      description:
        '按账户名查某账户在时间段内的收支汇总（账户名加密，需客户端匹配）。用户问"招商卡/微信/支付宝花了多少""XX账户余额变动"时用。',
      parameters: {
        type: 'object',
        properties: {
          accountName: { type: 'string', description: '账户名或简称，如"招商""微信"' },
          period: {
            type: 'string',
            description:
              "时间段：today / thisMonth / lastMonth / last30d 等，或 YYYY-MM-DD~YYYY-MM-DD",
          },
          type: {
            type: 'string',
            enum: ['expense', 'income'],
            description: '可选，默认统计支出+收入',
          },
        },
        required: ['accountName', 'period'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getGoalByName',
      description:
        '按储蓄目标名称查进度（目标名加密，需客户端匹配）。用户问"旅游目标还差多少""XX目标进度"时用；不要用 digest 里的"目标1"序号。',
      parameters: {
        type: 'object',
        properties: {
          goalName: { type: 'string', description: '目标名称或关键词，如"旅游""买房"' },
        },
        required: ['goalName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'comparePeriods',
      description:
        '对比两段时间的收支（环比/同比）。用户问"比上月涨了多少""同比""对比上月/去年同期"时用。baseline 常用 lastMonth（环比）或 lastYearSameMonth（同比）。',
      parameters: {
        type: 'object',
        properties: {
          current: {
            type: 'string',
            description: '当前段 period，默认 thisMonth',
          },
          baseline: {
            type: 'string',
            description: '对比段：lastMonth / lastYearSameMonth / last30d 等',
          },
          type: {
            type: 'string',
            enum: ['expense', 'income'],
            description: '默认 expense',
          },
          groupBy: {
            type: 'string',
            enum: ['category'],
            description: '可选，返回 TOP 分类对比',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'queryTransfers',
      description:
        '查询转账记录（账户名加密，客户端展示）。用户问"最近转了多少钱""从哪转到哪"时用。',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: '时间段，默认 thisMonth',
          },
          limit: { type: 'number', description: '最多几条，默认 15' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listStockHoldings',
      description:
        '股票持仓摘要：代码、股数、成本、市值、浮盈亏。用户问"我的股票""持仓盈亏""买了什么票"时用。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const SYSTEM_PROMPT = `你是「司库」app 内的财务助手。用户用中文问你账目相关问题，你的工作是：
1. 把模糊的中文问句转成结构化查询，调用合适的只读工具或写操作工具
2. 拿到工具结果后，用 1-3 句中文做归纳总结回复，不要重复全部数字
3. 涉及金额时单位是人民币(¥)
4. 涉及"上月""本月"等相对时间，自己换算成 queryStats 的 period 参数
5. 用户问"美团/瑞幸/某商户花了多少" → queryStats groupBy=merchant
6. 用户问"哪个分类花得多" → queryStats groupBy=category
7. 用户问"月末还能剩多少/预测结余" → getForecast
8. 用户问"财务健康/评分" → getHealthScore
9. 用户问"有什么风险/预警/异常" → listInsights
10. 用户问"固定支出/订阅/周期账单" → listRecurring
11. 用户问"重复记账/对账" → getReconcileSummary
12. 用户问"借贷/欠多少/借出去" → listLoans（广义负债还可结合摘要里的账户与借贷切片）
13. 用户问备注/商户/店名关键词（如"买菜""美团"）→ searchByNote；整商户排行仍用 queryStats groupBy=merchant
14. 用户问某账户名流水（如"招商卡花了多少"）→ queryAccountByName
15. 用户问具名储蓄目标（如"旅游目标进度"）→ getGoalByName
16. searchByNote / queryAccountByName / getGoalByName 会触发客户端解密，回复时说"下方卡片是本地解密后的结果"
17. 用户问"比上月/同比涨了多少" → comparePeriods（baseline=lastMonth 或 lastYearSameMonth）
18. 用户问转账记录 → queryTransfers
19. 用户问股票持仓/盈亏 → listStockHoldings
20. 用户要添加/设置周期账单、固定支出、订阅 → createRecurring（多项就多次调用，每项一张待确认卡）
21. 数据缺失或全是 0 时坦率说"这段时间没找到相关账单"，不要编造
22. 不要泄露内部工具调用过程，回答里只出现自然语言结果
23. 写操作（调预算/改分类/记账/转储蓄/加周期账单）只能"提议"：必须调对应工具生成待确认卡片，让用户点按钮确认；绝不要文字问"是否确认/请回复是的"，也绝不能声称"已经改好了"
24. 上下文中若附带「用户账本的真实数据摘要」，优先基于摘要直接回答；摘要没覆盖到的再调工具，不要重复调工具拿摘要里已有的数字

记住：你看不到账单备注/账户名/目标名的明文（端到端加密）。商户排行走 groupBy=merchant；备注关键词走 searchByNote；账户名走 queryAccountByName；目标名走 getGoalByName。`;

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
    case 'lastYearSameMonth': {
      const ly = new Date(now.getFullYear() - 1, now.getMonth(), 1);
      return [ly, endOfMonth(ly)];
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
