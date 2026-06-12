import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LlmRegistry } from '../ai/llm/llm-registry';
import { MarketDataService, BoardRow, StockRow } from './market-data.service';

type Candidate = StockRow & { boardName: string };

/**
 * 每日选股 agent：板块轮动 → 主板选股 → AI 精析 → 每日 Top10。
 *  - 数据：新浪行业板块 + 成分股（免费）。
 *  - 量化预筛（0 token）：强势板块里挑主板、非 ST、有量、未涨停的候选；
 *    再交给 LLM 综合板块强度/估值/技术/风险，选出最多 10 只并打分。
 *  - 交易日 00:30 cron；周末跳过；幂等（同一交易日只生成一次）；
 *    启动/进入接口时按需补算（自愈）。
 *  - 合规：措辞用「重点关注/逢低关注/观望」，附免责声明，仅自用。
 */
@Injectable()
export class PicksService implements OnModuleInit {
  private readonly logger = new Logger('Picks');
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly market: MarketDataService,
    private readonly llms: LlmRegistry,
  ) {}

  onModuleInit() {
    this.ensureToday().catch((e) =>
      this.logger.warn(`启动补算失败：${e?.message}`),
    );
  }

  /** 每天 00:30 生成（用最近收盘数据，供当日参考） */
  @Cron('0 30 0 * * *')
  async scheduledRun() {
    this.logger.log('每日选股（00:30）…');
    await this.ensureToday().catch((e) =>
      this.logger.warn(`定时选股失败：${e?.message}`),
    );
  }

  /**
   * 早盘多次补算（自愈）：凌晨电脑没开 → 00:30 没跑成时，
   * 早上 7/8/9 点开机后任一时刻自动把今天补出来（幂等，已生成则秒跳过）。
   * 9:30 开盘前都用上一交易日收盘价，选股基准稳定。
   */
  @Cron('0 0 7,8,9 * * *')
  async morningCatchup() {
    await this.ensureToday().catch((e) =>
      this.logger.warn(`早盘补算失败：${e?.message}`),
    );
  }

  /** 幂等生成今日榜单（inflight 锁，避免并发重入） */
  async ensureToday(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this._run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private localDate(d = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  private async _run(): Promise<void> {
    const now = new Date();
    const dow = now.getDay();
    if (dow === 0 || dow === 6) return; // 周末不处理
    const today = this.localDate(now);

    const exist = await this.prisma.dailyPickRun.findUnique({
      where: { tradeDate: today },
    });
    if (exist) return; // 今天已生成

    // 0) 学习闭环：先给历史推荐打实际成绩 → 反思更新策略备忘（记忆）
    await this.evaluateOutcomes().catch((e) =>
      this.logger.warn(`复盘失败：${e?.message}`),
    );
    const stats = await this.computeStats().catch(() => null);
    const playbook = await this.reflect(stats).catch(() => '');

    // 1) 板块：过滤太小/不活跃，按涨幅取强势 Top6
    const boards = await this.market.fetchBoards();
    if (!boards.length) {
      this.logger.warn('未取到板块数据，跳过');
      return;
    }
    const topBoards = boards
      .filter((b) => b.count >= 8 && b.amount >= 2e9)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 6);
    if (!topBoards.length) return;

    // 2) 候选股：强势板块内的主板、非 ST、有量、未涨停、当日上涨
    const pool: Candidate[] = [];
    const seen = new Set<string>();
    for (const b of topBoards) {
      const stocks = await this.market
        .fetchBoardStocks(b.code, 60)
        .catch(() => [] as StockRow[]);
      const picked = stocks
        .filter((s) => this.market.isMainBoardNonST(s.code, s.name))
        .filter(
          (s) =>
            s.price >= 2 &&
            s.changePercent > 0 &&
            s.changePercent < 9.8 && // 排除已涨停（买不进）
            (s.turnover ?? 0) >= 1, // 有换手
        )
        .slice(0, 8);
      for (const s of picked) {
        if (seen.has(s.code)) continue;
        seen.add(s.code);
        pool.push({ ...s, boardName: b.name });
      }
    }
    if (!pool.length) {
      this.logger.warn('候选池为空，跳过');
      return;
    }
    const candidates = pool.slice(0, 36);

    // 3) LLM 精析 → Top10（带上记忆：策略备忘 + 近期战绩）
    const out = await this.analyze(topBoards, candidates, playbook, stats);
    if (!out.picks.length) {
      this.logger.warn('AI 未产出推荐，跳过');
      return;
    }

    // 4) 落库
    const run = await this.prisma.dailyPickRun.create({
      data: {
        tradeDate: today,
        boards: JSON.stringify(
          topBoards.map((b) => ({
            name: b.name,
            pct: b.pct,
            amount: b.amount,
            lead: b.lead,
          })),
        ),
        comment: out.comment || null,
      },
    });

    let rank = 0;
    for (const p of out.picks) {
      const s =
        candidates.find((c) => c.code === p.code) ||
        candidates.find((c) => c.name === p.name);
      if (!s) continue;
      rank += 1;
      await this.prisma.dailyPick
        .create({
          data: {
            tradeDate: today,
            runId: run.id,
            rank,
            code: s.code,
            symbol: s.symbol,
            name: s.name,
            boardName: s.boardName,
            price: s.price,
            changePercent: s.changePercent,
            pe: s.pe,
            pb: s.pb,
            score: Math.max(0, Math.min(100, Math.round(p.score || 0))),
            action: p.action || '观望',
            reason: p.reason || '',
            risk: p.risk || '',
          },
        })
        .catch(() => {});
      if (rank >= 10) break;
    }
    this.logger.log(`生成今日机会股 ${rank} 只（${today}）`);

    // 5) 清理 >30 天
    const cutoff = this.localDate(new Date(now.getTime() - 30 * 86400_000));
    await this.prisma.dailyPickRun
      .deleteMany({ where: { tradeDate: { lt: cutoff } } })
      .catch(() => {});
  }

  // ── 学习闭环 ──────────────────────────────────────────────
  /** 复盘：给最近 ~18 天的推荐用最新价打实际成绩 */
  private async evaluateOutcomes(): Promise<void> {
    const cutoff = this.localDate(new Date(Date.now() - 18 * 86400_000));
    const picks = await this.prisma.dailyPick.findMany({
      where: { tradeDate: { gte: cutoff } },
      select: { id: true, symbol: true, price: true },
    });
    if (!picks.length) return;
    const quotes = await this.market.fetchQuotes(
      picks.map((p) => p.symbol).filter(Boolean),
    );
    const now = new Date();
    for (const p of picks) {
      const cur = quotes.get(p.symbol);
      if (cur == null || !(p.price && p.price > 0)) continue;
      const pct = Math.round(((cur - p.price) / p.price) * 10000) / 100;
      await this.prisma.dailyPick
        .update({
          where: { id: p.id },
          data: { lastPrice: cur, outcomePct: pct, outcomeAt: now },
        })
        .catch(() => {});
    }
  }

  /** 战绩统计：胜率/平均收益/分动作命中（近 30 天有成绩的推荐） */
  private async computeStats(): Promise<any | null> {
    const cutoff = this.localDate(new Date(Date.now() - 30 * 86400_000));
    const rows = await this.prisma.dailyPick.findMany({
      where: { tradeDate: { gte: cutoff }, outcomePct: { not: null } },
      select: { action: true, outcomePct: true, name: true },
      orderBy: { tradeDate: 'desc' },
      take: 300,
    });
    const r1 = (n: number) => Math.round(n * 100) / 100;
    if (rows.length < 5) return { sample: rows.length };
    const vals = rows.map((r) => r.outcomePct as number);
    const pos = vals.filter((v) => v > 0).length;
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    const byAction: Record<string, { n: number; hit: number; sum: number }> = {};
    for (const r of rows) {
      const a = r.action || '观望';
      const o = r.outcomePct as number;
      const e = (byAction[a] ||= { n: 0, hit: 0, sum: 0 });
      e.n++;
      if (o > 0) e.hit++;
      e.sum += o;
    }
    const sorted = [...rows].sort(
      (a, b) => (b.outcomePct as number) - (a.outcomePct as number),
    );
    return {
      sample: rows.length,
      hitRate: r1((pos / rows.length) * 100),
      avgReturn: r1(avg),
      byAction: Object.fromEntries(
        Object.entries(byAction).map(([k, v]) => [
          k,
          { n: v.n, hitRate: r1((v.hit / v.n) * 100), avgReturn: r1(v.sum / v.n) },
        ]),
      ),
      best: sorted.slice(0, 3).map((r) => ({ name: r.name, pct: r.outcomePct })),
      worst: sorted.slice(-3).map((r) => ({ name: r.name, pct: r.outcomePct })),
    };
  }

  private async loadPlaybook(): Promise<string> {
    const m = await this.prisma.picksMemory
      .findUnique({ where: { id: 'default' } })
      .catch(() => null);
    return m?.playbook || '';
  }

  /** 反思：把战绩 + 现有策略备忘喂 LLM，产出更新版策略备忘（自我进化的记忆） */
  private async reflect(stats: any): Promise<string> {
    const current = await this.loadPlaybook();
    // 先持久化最新战绩快照（即使样本不足也记下来，供前端展示）
    if (stats) {
      await this.prisma.picksMemory
        .upsert({
          where: { id: 'default' },
          create: { id: 'default', playbook: current, stats: JSON.stringify(stats) },
          update: { stats: JSON.stringify(stats) },
        })
        .catch(() => {});
    }
    if (!stats || (stats.sample ?? 0) < 5) return current; // 样本太少，先不学
    const modelName = this.llms.defaultTextModelName();
    if (!modelName) return current;

    const cutoff = this.localDate(new Date(Date.now() - 30 * 86400_000));
    const rows = await this.prisma.dailyPick.findMany({
      where: { tradeDate: { gte: cutoff }, outcomePct: { not: null } },
      select: {
        tradeDate: true,
        name: true,
        boardName: true,
        score: true,
        action: true,
        outcomePct: true,
      },
      orderBy: { tradeDate: 'desc' },
      take: 40,
    });
    const record = rows
      .map(
        (r) =>
          `${r.tradeDate} ${r.name}(${r.boardName}) 评分${r.score} ${r.action} → 实际${(r.outcomePct as number) >= 0 ? '+' : ''}${r.outcomePct}%`,
      )
      .join('\n');

    const system =
      '你是一个不断自我精进的 A 股交易师。下面是你过去推荐的真实战绩，以及你现有的「策略备忘」。' +
      '请像专业交易员一样复盘反思：哪些板块/特征/评分区间真的赚钱、哪些常亏？你的评分是否系统性偏高？' +
      '更新并精炼你的策略备忘——要具体、可执行、能直接指导明天选股' +
      '(例如"高位放量加速的次日回落多，降权""低换手的板块真龙头胜率更高"等)，不超过 400 字。' +
      '严格只返回 JSON：{"playbook":"更新后的完整策略备忘(中文)","note":"本次主要调整，一句话"}。';
    const user = `【近期战绩明细】\n${record}\n\n【统计】${JSON.stringify(stats)}\n\n【现有策略备忘】\n${current || '(还没有，请从这批战绩里总结第一版)'}`;

    try {
      const res = await this.llms.get(modelName).chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { responseFormat: 'json_object', temperature: 0.4, maxTokens: 1500 },
      );
      const j = parseJsonLoose(res.content || '') || {};
      const playbook = String(j.playbook || '').trim() || current;
      await this.prisma.picksMemory
        .upsert({
          where: { id: 'default' },
          create: { id: 'default', playbook, stats: JSON.stringify(stats) },
          update: { playbook, stats: JSON.stringify(stats) },
        })
        .catch(() => {});
      if (j.note) this.logger.log(`策略进化：${String(j.note).slice(0, 80)}`);
      return playbook;
    } catch (e) {
      this.logger.warn(`反思失败：${(e as Error).message}`);
      return current;
    }
  }

  private async analyze(
    topBoards: BoardRow[],
    pool: Candidate[],
    playbook?: string,
    stats?: any,
  ): Promise<{
    comment: string;
    picks: {
      code: string;
      name: string;
      score: number;
      action: string;
      reason: string;
      risk: string;
    }[];
  }> {
    const modelName = this.llms.defaultTextModelName();
    if (!modelName) return { comment: '', picks: [] };

    // 记忆注入：把过往经验 + 近期战绩喂回去，让它带着教训选股
    const memLine =
      playbook && playbook.trim()
        ? `\n\n【你的交易策略备忘（过往复盘积累，务必参考并据此修正判断）】\n${playbook.trim()}`
        : '';
    const statLine =
      stats && stats.sample >= 5
        ? `\n【近期战绩】样本 ${stats.sample} 只，胜率 ${stats.hitRate}%，平均收益 ${stats.avgReturn}%。请据此校准你的评分（别高估）。`
        : '';

    const boardLine = topBoards
      .map(
        (b) =>
          `${b.name}(涨${b.pct.toFixed(2)}% 成交${(b.amount / 1e8).toFixed(0)}亿 领涨${b.lead})`,
      )
      .join('；');
    const table = pool
      .map(
        (s, i) =>
          `${i + 1}. ${s.name}(${s.code}) 板块:${s.boardName} 价:${s.price} 涨幅:${s.changePercent}% ` +
          `PE:${s.pe ?? '—'} PB:${s.pb ?? '—'} 换手:${s.turnover ?? '—'}% 成交额:${(s.amount / 1e8).toFixed(1)}亿`,
      )
      .join('\n');

    const system =
      '你是资深 A 股证券分析师。下面给出今日强势行业板块，以及这些板块里的主板候选股' +
      '(已排除 ST / 创业板 / 科创板 / 北交所)。请从候选里选出最有机会的【最多 10 只】，' +
      '综合考虑：所属板块的强度与持续性、个股相对板块的领涨与量能、估值是否合理、技术位置、主要风险。' +
      '严格只返回 JSON：' +
      '{"comment":"今日市场与板块解读，3-4 句","picks":[{"code":"6位代码","name":"股票名","score":0到100的机会评分,' +
      '"action":"从【重点关注/逢低关注/观望】里选一个(合规措辞，不要用买入/卖出/必涨等字样)",' +
      '"reason":"入选理由，80字内","risk":"主要风险，40字内"}]}。' +
      'picks 按机会从高到低排序，最多 10 只，只能从候选里选，code/name 必须与候选完全一致。' +
      '客观、只依据所给数据，不编造数字。';
    const user =
      `【今日强势板块】\n${boardLine}\n\n【候选股(${pool.length}只)】\n${table}` +
      memLine +
      statLine;

    try {
      const res = await this.llms.get(modelName).chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { responseFormat: 'json_object', temperature: 0.3, maxTokens: 3000 },
      );
      const j = parseJsonLoose(res.content || '') || {};
      const picks = Array.isArray(j.picks) ? j.picks : [];
      return {
        comment: String(j.comment || ''),
        picks: picks.slice(0, 10).map((p: any) => ({
          code: String(p.code || '').replace(/\D/g, ''),
          name: String(p.name || ''),
          score: Number(p.score) || 0,
          action: String(p.action || '观望').slice(0, 6),
          reason: String(p.reason || ''),
          risk: String(p.risk || ''),
        })),
      };
    } catch (e) {
      this.logger.warn(`AI 选股失败：${(e as Error).message}`);
      return { comment: '', picks: [] };
    }
  }

  /** 最新一期榜单（供接口）。顺带触发一次按需补算。 */
  async getLatest() {
    void this.ensureToday();
    const run = await this.prisma.dailyPickRun.findFirst({
      orderBy: { tradeDate: 'desc' },
      include: { picks: { orderBy: { rank: 'asc' } } },
    });
    const mem = await this.prisma.picksMemory
      .findUnique({ where: { id: 'default' } })
      .catch(() => null);
    let memStats: any = null;
    try {
      memStats = mem?.stats ? JSON.parse(mem.stats) : null;
    } catch {
      memStats = null;
    }
    if (!run) {
      return {
        tradeDate: null,
        boards: [],
        comment: null,
        picks: [],
        memory: { playbook: mem?.playbook || '', stats: memStats },
      };
    }
    let boards: any[] = [];
    try {
      boards = JSON.parse(run.boards);
    } catch {
      boards = [];
    }
    return {
      tradeDate: run.tradeDate,
      boards,
      comment: run.comment,
      memory: { playbook: mem?.playbook || '', stats: memStats },
      disclaimer: '⚠️ 以上为数据分析与参考信息，不构成投资建议，据此操作风险自负。',
      picks: run.picks.map((p) => ({
        rank: p.rank,
        code: p.code,
        symbol: p.symbol,
        name: p.name,
        boardName: p.boardName,
        price: p.price,
        changePercent: p.changePercent,
        pe: p.pe,
        pb: p.pb,
        score: p.score,
        action: p.action,
        reason: p.reason,
        risk: p.risk,
      })),
    };
  }
}

/** 容错解析 LLM JSON（去 ``` 包裹；失败时截到最后一个 } 再试） */
function parseJsonLoose(raw: string): any | null {
  if (!raw) return null;
  const s = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '');
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch {
      return null;
    }
  }
  return null;
}
