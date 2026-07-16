import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { LlmRegistry } from '../ai/llm/llm-registry';
import { PrismaService } from '../prisma/prisma.service';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

interface CrumbState {
  cookie: string;
  crumb: string;
  ts: number;
}

/**
 * 股票查询服务：基于 Yahoo Finance 非官方接口（免 API key）。
 *
 *  - 解析：英文名/代码走 Yahoo search；中文名等搜不到时用 LLM 转 ticker 再查
 *  - 行情/基本面：走 crumb+cookie 流程拿 quoteSummary（价格/市值/PE/EPS/评级/目标价…）
 *  - 分析：把关键指标喂 LLM 产出中文分析
 *  - 缓存：crumb 复用 ~50 分钟；单只股票结果缓存 10 分钟，避免频繁外呼/重复 LLM
 *
 * 行情是公开数据，不涉及账本/加密。
 */
@Injectable()
export class StockService {
  private readonly logger = new Logger('StockService');
  private crumbState: CrumbState | null = null;

  private static readonly CRUMB_TTL = 50 * 60 * 1000;
  private static readonly KEEP_PER_SYMBOL = 20; // 每只股票每用户保留的历史快照数

  constructor(
    private readonly llms: LlmRegistry,
    private readonly prisma: PrismaService,
  ) {}

  // ── crumb / cookie ────────────────────────────────────────
  private async ensureCrumb(force = false): Promise<CrumbState> {
    const now = Date.now();
    if (
      !force &&
      this.crumbState &&
      now - this.crumbState.ts < StockService.CRUMB_TTL
    ) {
      return this.crumbState;
    }
    // 1. 取 cookie
    let cookie = '';
    try {
      const r = await fetch('https://fc.yahoo.com', {
        headers: { 'User-Agent': UA },
        redirect: 'manual',
      });
      const sc = (r as any).headers.getSetCookie
        ? (r as any).headers.getSetCookie()
        : [r.headers.get('set-cookie')];
      cookie = (sc || [])
        .filter(Boolean)
        .map((c: string) => c.split(';')[0])
        .join('; ');
    } catch (e) {
      this.logger.warn(`取 cookie 失败：${(e as Error).message}`);
    }
    // 2. 取 crumb
    const r = await fetch(
      'https://query1.finance.yahoo.com/v1/test/getcrumb',
      { headers: { 'User-Agent': UA, Cookie: cookie } },
    );
    const crumb = (await r.text()).trim();
    if (!crumb || crumb.length > 40) {
      throw new Error('获取 crumb 失败');
    }
    this.crumbState = { cookie, crumb, ts: now };
    return this.crumbState;
  }

  private async yahooJson(url: string, withCrumb = false): Promise<any> {
    const doFetch = async (cs?: CrumbState) => {
      const u = cs ? url + (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(cs.crumb) : url;
      const r = await fetch(u, {
        headers: {
          'User-Agent': UA,
          ...(cs ? { Cookie: cs.cookie } : {}),
        },
      });
      return r;
    };
    if (!withCrumb) {
      const r = await doFetch();
      if (!r.ok) throw new Error(`Yahoo ${r.status}`);
      return r.json();
    }
    // 带 crumb；401 则刷新一次重试
    let cs = await this.ensureCrumb();
    let r = await doFetch(cs);
    if (r.status === 401) {
      cs = await this.ensureCrumb(true);
      r = await doFetch(cs);
    }
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    return r.json();
  }

  // ── 解析代码 ───────────────────────────────────────────────
  private async searchSymbol(q: string): Promise<{ symbol: string; name: string; exchange: string } | null> {
    try {
      const j = await this.yahooJson(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=5&newsCount=0`,
      );
      const eq = (j.quotes || []).find(
        (x: any) => x.quoteType === 'EQUITY' && x.symbol,
      );
      if (eq) {
        return {
          symbol: eq.symbol,
          name: eq.shortname || eq.longname || eq.symbol,
          exchange: eq.exchange || '',
        };
      }
    } catch (e) {
      this.logger.warn(`search 失败：${(e as Error).message}`);
    }
    return null;
  }

  /** 用 LLM 把名字/代码转成 Yahoo ticker（处理中文名等 search 搜不到的情况） */
  private async llmResolveTicker(q: string): Promise<string | null> {
    const modelName = this.llms.defaultTextModelName();
    if (!modelName) return null;
    try {
      const res = await this.llms.get(modelName).chat(
        [
          {
            role: 'system',
            content:
              '你是股票代码助手。给定股票名称或代码，返回它在 Yahoo Finance 上的 ticker。' +
              '规则：美股直接用代码(如 AAPL)；港股用4位数字加 .HK(如 腾讯=0700.HK)；' +
              'A股上交所 .SS、深交所 .SZ(如 贵州茅台=600519.SS, 宁德时代=300750.SZ)。' +
              '只返回 JSON：{"symbol":""}，找不到返回 {"symbol":""}。',
          },
          { role: 'user', content: q },
        ],
        // 推理模型(reasoning_content)会先消耗 token，需留足空间否则 content 为空
        { responseFormat: 'json_object', temperature: 0, maxTokens: 800 },
      );
      const sym = (JSON.parse(res.content || '{}').symbol || '').trim();
      return sym || null;
    } catch {
      return null;
    }
  }

  private async resolve(q: string): Promise<{ symbol: string; name: string; exchange: string }> {
    const query = q.trim();
    // 1. 直接 search
    let hit = await this.searchSymbol(query);
    if (hit) return hit;
    // 2. LLM 转 ticker 再 search 校验
    const guess = await this.llmResolveTicker(query);
    if (guess) {
      hit = await this.searchSymbol(guess);
      if (hit) return hit;
      // search 校验不到也直接用猜测的 ticker（quoteSummary 兜底）
      return { symbol: guess, name: guess, exchange: '' };
    }
    throw new NotFoundException(`未找到股票「${q}」，试试用代码（如 AAPL、0700.HK、600519.SS）`);
  }

  // ── 行情 + 基本面 ─────────────────────────────────────────
  private num(o: any): number | null {
    if (o == null) return null;
    if (typeof o === 'number') return o;
    if (typeof o.raw === 'number') return o.raw;
    return null;
  }

  /**
   * 涨跌幅：Yahoo 的 regularMarketChangePercent 是「小数比例」(0.03 = 3%)，
   * 这里统一 ×100 转成「百分数」(3)，前端直接当百分比显示，避免出现 0.03%。
   */
  private numPct(o: any): number | null {
    const v = this.num(o);
    return v == null ? null : v * 100;
  }

  /** 轻量实时价（只取 price 模块），进详情时刷新用于算盈亏 */
  async fetchLivePrice(symbol: string): Promise<{
    price: number | null;
    change: number | null;
    changePercent: number | null;
    currency: string;
  } | null> {
    try {
      const j = await this.yahooJson(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price`,
        true,
      );
      const p = j?.quoteSummary?.result?.[0]?.price;
      if (!p) return null;
      return {
        price: this.num(p.regularMarketPrice),
        change: this.num(p.regularMarketChange),
        changePercent: this.numPct(p.regularMarketChangePercent),
        currency: p.currency || '',
      };
    } catch {
      return null;
    }
  }

  private async fetchQuote(symbol: string) {
    const modules =
      'price,summaryDetail,defaultKeyStatistics,financialData,recommendationTrend,assetProfile';
    const j = await this.yahooJson(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`,
      true,
    );
    const res = j?.quoteSummary?.result?.[0];
    if (!res) throw new NotFoundException(`未找到行情数据：${symbol}`);
    const p = res.price || {};
    const sd = res.summaryDetail || {};
    const ks = res.defaultKeyStatistics || {};
    const fd = res.financialData || {};
    const tr = (res.recommendationTrend?.trend || [])[0] || {};
    const ap = res.assetProfile || {};

    return {
      symbol: p.symbol || symbol,
      name: p.longName || p.shortName || symbol,
      nameZh: null as string | null,
      exchange: p.fullExchangeName || p.exchangeName || '',
      currency: p.currency || '',
      price: this.num(p.regularMarketPrice),
      change: this.num(p.regularMarketChange),
      changePercent: this.numPct(p.regularMarketChangePercent),
      marketCap: this.num(p.marketCap),
      dayHigh: this.num(p.regularMarketDayHigh),
      dayLow: this.num(p.regularMarketDayLow),
      volume: this.num(p.regularMarketVolume),
      pe: this.num(sd.trailingPE),
      forwardPe: this.num(sd.forwardPE),
      eps: this.num(ks.trailingEps),
      pb: this.num(ks.priceToBook),
      peg: this.num(ks.pegRatio),
      beta: this.num(sd.beta),
      dividendYield: this.num(sd.dividendYield),
      high52: this.num(sd.fiftyTwoWeekHigh),
      low52: this.num(sd.fiftyTwoWeekLow),
      ma50: this.num(sd.fiftyDayAverage),
      ma200: this.num(sd.twoHundredDayAverage),
      recommendation: fd.recommendationKey || null,
      recommendationMean: this.num(fd.recommendationMean),
      targetMean: this.num(fd.targetMeanPrice),
      targetHigh: this.num(fd.targetHighPrice),
      targetLow: this.num(fd.targetLowPrice),
      analystCount: this.num(fd.numberOfAnalystOpinions),
      profitMargins: this.num(fd.profitMargins),
      roe: this.num(fd.returnOnEquity),
      revenueGrowth: this.num(fd.revenueGrowth),
      earningsGrowth: this.num(fd.earningsGrowth),
      grossMargins: this.num(fd.grossMargins),
      totalCash: this.num(fd.totalCash),
      totalDebt: this.num(fd.totalDebt),
      currentRatio: this.num(fd.currentRatio),
      recTrend: {
        strongBuy: tr.strongBuy || 0,
        buy: tr.buy || 0,
        hold: tr.hold || 0,
        sell: tr.sell || 0,
        strongSell: tr.strongSell || 0,
      },
      sector: ap.sector || null,
      industry: ap.industry || null,
      country: ap.country || null,
      summary: ap.longBusinessSummary || null,
    };
  }

  // ── LLM 分析（结构化）──────────────────────────────────────
  private emptyAnalysis() {
    return { business: '', market: '', analyst: '', rating: '', suggestion: '' };
  }

  private async analyze(
    q: any,
    summary: string | null,
    newsTitles: string[],
    prior?: { date: string; price: any; pe: any; target: any },
    holding?: { buyPrice: number; shares: number } | null,
  ): Promise<{
    business: string;
    market: string;
    analyst: string;
    rating: string;
    suggestion: string;
  }> {
    const modelName = this.llms.defaultTextModelName();
    if (!modelName) return this.emptyAnalysis();
    const pct = (v: number | null) =>
      v == null ? '—' : (v * 100).toFixed(1) + '%';
    const facts = [
      `名称：${q.name}(${q.symbol})  交易所：${q.exchange}  币种：${q.currency}`,
      `现价：${q.price}  涨跌：${q.change}(${q.changePercent == null ? '—' : q.changePercent.toFixed(2) + '%'})`,
      `市值：${q.marketCap}  市盈率(TTM)：${q.pe}  预期PE：${q.forwardPe}  市净率：${q.pb}  PEG：${q.peg}`,
      `EPS：${q.eps}  Beta：${q.beta}  股息率：${pct(q.dividendYield)}`,
      `52周高/低：${q.high52}/${q.low52}  50/200日均线：${q.ma50}/${q.ma200}`,
      `分析师评级：${q.recommendation}(均值${q.recommendationMean}, ${q.analystCount}人)  目标价 低/均/高：${q.targetLow}/${q.targetMean}/${q.targetHigh}`,
      `利润率：${pct(q.profitMargins)}  ROE：${pct(q.roe)}  营收增速：${pct(q.revenueGrowth)}  盈利增速：${pct(q.earningsGrowth)}`,
      `行业：${q.sector} / ${q.industry}  国家：${q.country}`,
    ].join('\n');
    const sumLine = summary
      ? `\n\n公司业务说明(英文，供你概括为中文主营业务)：\n${String(summary).slice(0, 1600)}`
      : '';
    const newsLine = newsTitles.length
      ? `\n\n近期相关新闻标题：\n${newsTitles.slice(0, 10).map((t) => `- ${t}`).join('\n')}`
      : '';
    const priorLine = prior
      ? `\n\n上次查询(${prior.date})：现价 ${prior.price}、市盈率 ${prior.pe}、目标均价 ${prior.target}。请在 market 里点出与上次相比的关键变化。`
      : '';
    let holdingLine = '';
    if (holding && holding.buyPrice > 0 && holding.shares > 0) {
      const cur = typeof q.price === 'number' ? q.price : null;
      const plPct =
        cur != null
          ? (((cur - holding.buyPrice) / holding.buyPrice) * 100).toFixed(2)
          : '—';
      holdingLine = `\n\n【用户持仓】成本价 ${holding.buyPrice}，持有 ${holding.shares} 股，现价 ${cur}，浮动盈亏约 ${plPct}%。请在 suggestion 里针对该持仓给出明确操作建议（继续持有 / 逢低加仓 / 部分止盈 / 止损减仓 / 清仓等），结合成本与当前盈亏、估值和风险说明理由。`;
    }
    const suggestionDesc = holdingLine
      ? '针对用户持仓的操作建议：给出明确操作倾向(继续持有/逢低加仓/部分止盈/止损减仓/清仓等)、结合其成本与盈亏的理由，并提示主要风险'
      : '明确的买入建议：给出操作倾向(适合买入/逢低布局/持有观望/暂时回避等)、理由，并提示主要风险';
    const system =
      '你是资深证券分析师。基于给定数据用中文分析，严格只返回 JSON：' +
      '{"business":"公司简介与主营业务，2-3句","market":"市场动态：结合近期股价/估值/新闻的表现与事件","analyst":"分析师观点综合：评级与目标价相对现价的空间","rating":"你的综合评级，从【买入/增持/中性/减持/卖出】里选一个","suggestion":"' +
      suggestionDesc +
      '"}。客观、只依据所给数据，不编造数字。suggestion 末尾另起一句「⚠️ 仅供参考，不构成投资建议」。';
    try {
      const res = await this.llms.get(modelName).chat(
        [
          { role: 'system', content: system },
          {
            role: 'user',
            content: facts + sumLine + newsLine + priorLine + holdingLine,
          },
        ],
        { responseFormat: 'json_object', temperature: 0.3, maxTokens: 2200 },
      );
      const j = parseJsonLoose(res.content || '') || {};
      return {
        business: String(j.business || ''),
        market: String(j.market || ''),
        analyst: String(j.analyst || ''),
        rating: String(j.rating || '').slice(0, 4),
        suggestion: String(j.suggestion || ''),
      };
    } catch (e) {
      this.logger.warn(`分析失败：${(e as Error).message}`);
      return this.emptyAnalysis();
    }
  }

  // ── 公司最新新闻 ──────────────────────────────────────────
  /** 去掉公司名常见后缀，得到便于搜新闻的品牌名（PetroChina Company Limited → PetroChina） */
  private cleanCompanyName(name: string): string {
    if (!name) return '';
    let s = name.replace(/[,，]/g, ' ');
    s = s.replace(
      /\b(Company|Companies|Limited|Ltd|Inc|Incorporated|Corporation|Corp|Co|PLC|Group|Holdings?|S\.?A\.?|AG|N\.?V\.?|ADR|Class\s+[A-C]|股份有限公司|有限公司|集团)\b/gi,
      ' ',
    );
    s = s.replace(/\s+/g, ' ').trim();
    return s || name;
  }

  private async fetchNewsByQuery(q: string): Promise<any[]> {
    try {
      const j = await this.yahooJson(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=12`,
      );
      return (j.news || [])
        .filter((n: any) => n.title && n.link)
        .map((n: any) => ({
          title: n.title,
          publisher: n.publisher || '',
          url: n.link,
          publishedAt: n.providerPublishTime
            ? new Date(n.providerPublishTime * 1000).toISOString()
            : null,
        }));
    } catch {
      return [];
    }
  }

  /**
   * 抓公司新闻：优先按公司英文名搜（按代码搜常返回无关大盘新闻），
   * 名字搜到的不够再用代码补，按 url 去重。
   */
  private async fetchNews(name: string, symbol: string): Promise<any[]> {
    const queries: string[] = [];
    const clean = this.cleanCompanyName(name);
    if (clean && clean.toUpperCase() !== symbol.toUpperCase()) {
      queries.push(clean);
    }
    queries.push(symbol);

    const seen = new Set<string>();
    const out: any[] = [];
    for (const q of queries) {
      const items = await this.fetchNewsByQuery(q);
      for (const it of items) {
        if (!seen.has(it.url)) {
          seen.add(it.url);
          out.push(it);
        }
      }
      if (out.length >= 10) break;
    }
    return out.slice(0, 14);
  }

  // ── A股/港股：东方财富按个股新闻流（中文，比 Yahoo 相关得多）──────
  /** Yahoo 代码 → 东方财富 secid（上交所 1.、深交所 0.、港股 116.）；美股返回 null */
  private toEastmoneySecid(symbol: string): string | null {
    const up = symbol.toUpperCase();
    const code = up.replace(/\.(SS|SZ|HK)$/, '');
    if (up.endsWith('.SS')) return '1.' + code;
    if (up.endsWith('.SZ')) return '0.' + code;
    if (up.endsWith('.HK')) return '116.' + code.padStart(5, '0');
    return null;
  }

  private async fetchEastmoneyNews(secid: string): Promise<any[]> {
    try {
      const u = `https://np-listapi.eastmoney.com/comm/web/getListInfo?client=web&biz=web_news&mTypeAndCode=${secid}&type=1&pageindex=1&pagesize=14&_=1`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(u, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
      });
      clearTimeout(timer);
      if (!r.ok) return [];
      const text = await r.text();
      let j: any;
      try {
        j = JSON.parse(text);
      } catch {
        const m = text.match(/^[^(]*\((.*)\)\s*;?\s*$/s);
        j = m ? JSON.parse(m[1]) : null;
      }
      const arr = j?.data?.list || j?.list || [];
      return arr
        .filter((a: any) => a.Art_Title && a.Art_Url)
        .slice(0, 14)
        .map((a: any) => ({
          title: a.Art_Title,
          publisher: '东方财富',
          url: a.Art_Url,
          publishedAt: a.Art_ShowTime
            ? new Date(a.Art_ShowTime.replace(' ', 'T') + '+08:00').toISOString()
            : null,
        }));
    } catch {
      return [];
    }
  }

  /** 取公司新闻：A股/港股用东方财富(中文)，美股/其他用 Yahoo(按公司名) */
  private async getCompanyNews(quote: any): Promise<any[]> {
    const secid = this.toEastmoneySecid(quote.symbol);
    if (secid) {
      const em = await this.fetchEastmoneyNews(secid);
      if (em.length) return em;
    }
    return this.fetchNews(quote.name, quote.symbol);
  }

  /**
   * 翻译公司中文名 + 过滤新闻：只保留与该公司或其主营业务直接相关的，翻成中文。
   * 无关的丢弃。LLM 失败时回退为不过滤（保留全部、英文标题）。
   */
  private async processNews(
    name: string,
    items: any[],
  ): Promise<{ nameZh: string; news: any[] }> {
    if (!items.length) return { nameZh: '', news: [] };
    const fallback = {
      nameZh: '',
      news: items.slice(0, 8).map((n) => ({ ...n, titleZh: null })),
    };
    const modelName = this.llms.defaultTextModelName();
    if (!modelName) return fallback;
    try {
      const user =
        `公司：${name}\n候选新闻标题：\n` +
        items.map((n, i) => `${i}. ${n.title}`).join('\n');
      const res = await this.llms.get(modelName).chat(
        [
          {
            role: 'system',
            content:
              '给定一家公司和若干候选新闻标题。判断每条是否与【该公司本身或其主营业务】直接相关' +
              '（仅泛泛提到行业、或只是大盘/他司新闻的，算不相关）。相关的把标题翻成简洁中文。' +
              '严格只返回 JSON：{"nameZh":"公司中文常用名","items":[{"i":序号,"relevant":true或false,"zh":"中文标题"}]}，' +
              'i 与输入序号对应、覆盖全部。',
          },
          { role: 'user', content: user },
        ],
        { responseFormat: 'json_object', temperature: 0.2, maxTokens: 2000 },
      );
      const j = parseJsonLoose(res.content || '') || {};
      const arr = Array.isArray(j.items) ? j.items : [];
      const byIdx = new Map<number, any>();
      for (const o of arr) {
        const i = typeof o.i === 'number' ? o.i : parseInt(o.i, 10);
        if (Number.isInteger(i)) byIdx.set(i, o);
      }
      const kept: any[] = [];
      items.forEach((n, i) => {
        const o = byIdx.get(i);
        if (o && o.relevant) {
          kept.push({ ...n, titleZh: String(o.zh || '') || null });
        }
      });
      return { nameZh: String(j.nameZh || '').slice(0, 40), news: kept.slice(0, 8) };
    } catch {
      return fallback;
    }
  }

  // ── 对外入口 ──────────────────────────────────────────────
  /**
   * 查询/更新某只股票：取最新行情+新闻，结合该用户上次快照做对比分析，存一条快照。
   */
  async lookup(
    userId: string,
    q: string,
  ): Promise<{
    quote: any;
    analysis: any;
    news: any[];
    updatedAt: string;
    holding: any;
  }> {
    if (!q || !q.trim()) {
      throw new NotFoundException('请输入股票名称或代码');
    }
    const resolved = await this.resolve(q);
    const symbol = resolved.symbol.toUpperCase();

    // 行情（含公司名）。已聚焦「记账/持仓」，不再做 AI 选股分析与资讯。
    const quote = await this.fetchQuote(resolved.symbol);
    const holding = await this.getHolding(userId, symbol);

    // 存快照（仅名称 + 行情，供持仓列表取名/最新价用）+ 修剪历史
    const row = await this.prisma.stockAnalysis.create({
      data: {
        userId,
        symbol,
        name: quote.name || null,
        nameZh: quote.nameZh || null,
        quote: quote as any,
      },
      select: { createdAt: true },
    });
    await this.pruneHistory(userId, symbol);

    return {
      quote,
      analysis: this.emptyAnalysis(),
      news: [],
      updatedAt: row.createdAt.toISOString(),
      holding,
    };
  }

  // ── 持仓 ──────────────────────────────────────────────────
  /**
   * 设置/更新持仓；买入价或数量 ≤0 视为清空持仓。
   * 可选关联账本+账户：关联后每天 15:00 自动按最新价更新账户余额、记当日盈亏。
   * 关联或换账户时，用当前实时价作为基准(lastPrice)，这样首次结算只记关联之后的波动，
   * 不会把"买入至今"的累计盈亏一次性灌进账户。
   */
  async setHolding(
    userId: string,
    symbol: string,
    buyPrice: number,
    shares: number,
    opts?: { ledgerId?: string | null; accountId?: string | null },
  ) {
    const sym = symbol.toUpperCase();
    if (!(buyPrice > 0) || !(shares > 0)) {
      await this.prisma.stockHolding.deleteMany({
        where: { userId, symbol: sym },
      });
      return { holding: null };
    }

    const prev = await this.prisma.stockHolding.findUnique({
      where: { userId_symbol: { userId, symbol: sym } },
    });
    const accountId = opts?.accountId ?? null;
    const ledgerId = opts?.ledgerId ?? null;

    // 账户变化（首次关联 / 换账户）→ 重建价格基准
    const accountChanged = (prev?.accountId ?? null) !== accountId;
    let lastPrice = prev?.lastPrice ?? null;
    let lastCalcAt = prev?.lastCalcAt ?? null;
    if (accountId && accountChanged) {
      const live = await this.fetchLivePrice(sym).catch(() => null);
      lastPrice = live?.price ?? null;
      lastCalcAt = lastPrice != null ? new Date() : null;
    }
    if (!accountId) {
      // 取消关联：清掉结算基准
      lastPrice = null;
      lastCalcAt = null;
    }

    const h = await this.prisma.stockHolding.upsert({
      where: { userId_symbol: { userId, symbol: sym } },
      create: {
        userId,
        symbol: sym,
        buyPrice,
        shares,
        ledgerId,
        accountId,
        lastPrice,
        lastCalcAt,
      },
      update: { buyPrice, shares, ledgerId, accountId, lastPrice, lastCalcAt },
    });
    return {
      holding: {
        buyPrice: h.buyPrice,
        shares: h.shares,
        accountId: h.accountId,
      },
    };
  }

  /**
   * 每日持仓决策分析：把「我的持仓 + 股票数据」喂给 LLM，扮演资深分析师给出
   * 加仓/持有/减仓/清仓/观望 的明确建议与理由。供每日结算时调用、存库。
   */
  async analyzeHoldingDecision(
    symbol: string,
    holding: { buyPrice: number; shares: number; currentPrice?: number | null },
  ): Promise<{ action: string; reason: string } | null> {
    const modelName = this.llms.defaultTextModelName();
    if (!modelName) return null;
    const quote = await this.fetchQuote(symbol).catch(() => null);
    if (!quote) return null;
    const cur = holding.currentPrice ?? quote.price ?? null;
    const cost = holding.buyPrice;
    const plPct =
      cur != null && cost > 0
        ? (((cur - cost) / cost) * 100).toFixed(2)
        : '—';
    const mktValue = cur != null ? (cur * holding.shares).toFixed(2) : '—';
    const facts = [
      `名称：${quote.name}(${quote.symbol})  币种：${quote.currency}`,
      `现价：${cur}  市值：${quote.marketCap}  市盈率：${quote.pe}  预期PE：${quote.forwardPe}  市净率：${quote.pb}  PEG：${quote.peg}`,
      `EPS：${quote.eps}  ROE：${quote.roe}  利润率：${quote.profitMargins}  营收增速：${quote.revenueGrowth}`,
      `52周高/低：${quote.high52}/${quote.low52}  50/200日均线：${quote.ma50}/${quote.ma200}`,
      `分析师评级：${quote.recommendation}(${quote.analystCount}人)  目标价 低/均/高：${quote.targetLow}/${quote.targetMean}/${quote.targetHigh}`,
      `行业：${quote.sector} / ${quote.industry}`,
    ].join('\n');
    const holdingLine = `\n\n【我的持仓】成本价 ${cost}，持有 ${holding.shares} 股，现价 ${cur}，持仓市值约 ${mktValue}，浮动盈亏约 ${plPct}%。`;
    const system =
      '你是资深证券分析师，正在为客户做每日持仓复盘。基于给定数据用中文分析，严格只返回 JSON：' +
      '{"action":"从【加仓/持有/减仓/清仓/观望】里选一个最贴切的","reason":"针对该持仓的决策理由：结合成本与当前盈亏、估值水平、分析师目标价空间、主要风险，150字内，最后一句「⚠️ 仅供参考，不构成投资建议」"}。' +
      '客观、只依据所给数据，不编造数字。';
    try {
      const res = await this.llms.get(modelName).chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: facts + holdingLine },
        ],
        { responseFormat: 'json_object', temperature: 0.3, maxTokens: 1200 },
      );
      const j = parseJsonLoose(res.content || '') || {};
      const action = String(j.action || '').slice(0, 6);
      const reason = String(j.reason || '');
      if (!reason) return null;
      return { action, reason };
    } catch (e) {
      this.logger.warn(`持仓决策分析失败：${(e as Error).message}`);
      return null;
    }
  }

  private parseAdvice(
    raw: string | null,
  ): { action: string; reason: string } | null {
    if (!raw) return null;
    try {
      const j = JSON.parse(raw);
      if (!j?.reason) return null;
      return { action: String(j.action || ''), reason: String(j.reason) };
    } catch {
      return null;
    }
  }

  private async getHolding(userId: string, symbol: string) {
    const h = await this.prisma.stockHolding.findUnique({
      where: { userId_symbol: { userId, symbol: symbol.toUpperCase() } },
    });
    return h
      ? {
          buyPrice: h.buyPrice,
          shares: h.shares,
          accountId: h.accountId,
          advice: this.parseAdvice(h.advice),
          adviceAt: h.adviceAt ? h.adviceAt.toISOString() : null,
        }
      : null;
  }

  /**
   * 列表：该用户每只股票的最新一条快照（轻量字段）。
   * 价格/涨跌幅实时拉最新价覆盖（拉不到再回退快照），让列表与详情一致、不再停在旧快照。
   */
  async list(userId: string) {
    const [rows, holdings] = await Promise.all([
      this.prisma.stockAnalysis.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        distinct: ['symbol'],
      }),
      this.prisma.stockHolding.findMany({ where: { userId } }),
    ]);
    // symbol → 持仓（买入价/股数 > 0 才算持仓）
    const hmap = new Map(
      holdings
        .filter((h) => h.buyPrice > 0 && h.shares > 0)
        .map((h) => [h.symbol.toUpperCase(), h]),
    );
    return Promise.all(
      rows.map(async (r) => {
        const q = (r.quote as any) || {};
        const live = await this.fetchLivePrice(r.symbol).catch(() => null);
        const h = hmap.get(r.symbol.toUpperCase());
        return {
          symbol: r.symbol,
          name: r.name,
          nameZh: r.nameZh,
          currency: live?.currency || q.currency || '',
          price: live?.price ?? q.price ?? null,
          change: live?.change ?? q.change ?? null,
          changePercent: live?.changePercent ?? q.changePercent ?? null,
          recommendation: q.recommendation ?? null,
          rating: this.parseRating(r.analysis),
          updatedAt: r.createdAt.toISOString(),
          // 持仓信息（关注 tab 没有；持仓 tab 用来算盈亏）
          held: !!h,
          buyPrice: h?.buyPrice ?? null,
          shares: h?.shares ?? null,
        };
      }),
    );
  }

  private parseRating(analysis: string | null): string | null {
    if (!analysis) return null;
    try {
      return JSON.parse(analysis).rating || null;
    } catch {
      return null;
    }
  }

  /** 详情：某股票最新保存的完整快照 + 历史(价格/PE/时间) */
  async getSaved(userId: string, symbol: string) {
    const sym = symbol.toUpperCase();
    const rows = await this.prisma.stockAnalysis.findMany({
      where: { userId, symbol: sym },
      orderBy: { createdAt: 'desc' },
      take: StockService.KEEP_PER_SYMBOL,
    });
    if (!rows.length) throw new NotFoundException('没有该股票的记录');
    const latest = rows[0];
    const history = rows
      .map((r) => ({
        price: (r.quote as any)?.price ?? null,
        pe: (r.quote as any)?.pe ?? null,
        at: r.createdAt.toISOString(),
      }))
      .reverse();
    // analysis 以 JSON 字符串存；解析回对象，兼容旧的纯文本快照
    let analysis: any;
    try {
      analysis = latest.analysis ? JSON.parse(latest.analysis) : this.emptyAnalysis();
      if (typeof analysis !== 'object' || analysis == null) {
        analysis = { ...this.emptyAnalysis(), suggestion: String(latest.analysis) };
      }
    } catch {
      analysis = { ...this.emptyAnalysis(), suggestion: latest.analysis || '' };
    }
    // 进详情时取最新价 + 持仓，便于算盈亏
    const [live, holding] = await Promise.all([
      this.fetchLivePrice(sym),
      this.getHolding(userId, sym),
    ]);
    return {
      quote: latest.quote,
      analysis,
      news: latest.news || [],
      updatedAt: latest.createdAt.toISOString(),
      history,
      live,
      holding,
    };
  }

  private async pruneHistory(userId: string, symbol: string) {
    const old = await this.prisma.stockAnalysis.findMany({
      where: { userId, symbol },
      orderBy: { createdAt: 'desc' },
      skip: StockService.KEEP_PER_SYMBOL,
      select: { id: true },
    });
    if (old.length) {
      await this.prisma.stockAnalysis
        .deleteMany({ where: { id: { in: old.map((o) => o.id) } } })
        .catch(() => {});
    }
  }
}

/** 容错解析 LLM 返回的 JSON（去 ``` 包裹；失败时截到最后一个 } 再补全） */
function parseJsonLoose(raw: string): any | null {
  if (!raw) return null;
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try {
    return JSON.parse(s);
  } catch {
    /* 继续容错 */
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}
