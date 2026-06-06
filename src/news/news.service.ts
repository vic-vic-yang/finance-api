import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LlmRegistry } from '../ai/llm/llm-registry';
// rss-parser 是 CommonJS（export =），本项目未开 esModuleInterop，必须用 import-equals
import Parser = require('rss-parser');

/**
 * 每日财经新闻 agent。
 *
 *  - 抓取：聚合多个 RSS 源（可用 NEWS_RSS_FEEDS 覆盖默认列表，逗号分隔）
 *  - 富化：可选用已配置的 LLM 给每条新闻排重要性 + 生成中文摘要 + 打标签
 *          （NEWS_USE_LLM=false 可关闭，省 token；关闭则按时间排序、用原始描述）
 *  - 去重：按 url 唯一，跨日不重复
 *  - 触发：① 每天清晨定时抓（后端常驻时）② 打开页面时若数据超过 12h 则按需补抓
 *  - 留存：只保留最近 14 天，自动清理
 *
 * 新闻是公开数据，不涉及账本/端到端加密。
 */
@Injectable()
export class NewsService implements OnModuleInit {
  private readonly logger = new Logger('NewsService');
  private readonly parser = new Parser({
    timeout: 8000,
    headers: { 'User-Agent': 'CaiJiNewsBot/1.0 (+finance app)' },
  });
  private inflight: Promise<number> | null = null;
  /** 分析任务进行中标记，避免重复并发分析同一批 */
  private analyzing = false;

  private static readonly KEEP_DAYS = 14;
  private static readonly MAX_KEEP = 50; // 每天最多保留的精选条数（按重要性）
  private static readonly STALE_MS = 5 * 60 * 60 * 1000; // 按需补抓阈值：>5h 视为陈旧

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly llms: LlmRegistry,
  ) {}

  onModuleInit() {
    // 启动时：若数据陈旧先补抓，然后补齐所有"还没分析"的新闻
    // （重启/中断后能自动续上，不会让旧新闻一直没分析）
    this.ensureFresh()
      .then(() => this.analyzePending())
      .catch(() => {});
  }

  private get feeds(): string[] {
    const raw = (this.config.get<string>('NEWS_RSS_FEEDS') || '').trim();
    if (raw) {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [
      // 股市 / 宏观 / 综合财经
      'https://www.cnbc.com/id/100003114/device/rss/rss.html', // CNBC Finance
      'https://www.cnbc.com/id/20910258/device/rss/rss.html', // CNBC Markets
      'https://www.cnbc.com/id/10000664/device/rss/rss.html', // CNBC Economy
      'http://feeds.marketwatch.com/marketwatch/topstories/', // MarketWatch
      'https://finance.yahoo.com/news/rssindex', // Yahoo Finance
      'https://feeds.bbci.co.uk/news/business/rss.xml', // BBC Business
      'https://www.theguardian.com/uk/business/rss', // Guardian Business
      'https://www.investing.com/rss/news.rss', // Investing.com
      'https://moxie.foxbusiness.com/google-publisher/markets.xml', // Fox Business Markets
      // 政治 / 政策
      'https://www.cnbc.com/id/10000113/device/rss/rss.html', // CNBC Politics
      // 科技
      'https://www.cnbc.com/id/19854910/device/rss/rss.html', // CNBC Technology
      'https://techcrunch.com/feed/', // TechCrunch
      'https://www.theverge.com/rss/index.xml', // The Verge
      'https://www.engadget.com/rss.xml', // Engadget
      'https://36kr.com/feed', // 36氪（中文·科技/创投）
      // 加密
      'https://www.coindesk.com/arc/outboundfeeds/rss/', // CoinDesk
      'https://cointelegraph.com/rss', // Cointelegraph
      'https://decrypt.co/feed', // Decrypt
    ];
  }

  private get useLlm(): boolean {
    const v = (this.config.get<string>('NEWS_USE_LLM') || 'true')
      .trim()
      .toLowerCase();
    return !['false', '0', 'no', 'n'].includes(v);
  }

  /** 每天 早 7:00 / 午 12:00 / 晚 20:00 各抓一次（后端常驻时生效） */
  @Cron('0 0 7,12,20 * * *')
  async scheduledFetch() {
    this.logger.log('定时抓取财经新闻（早7/午12/晚20）…');
    await this.fetchAndStore().catch((e) =>
      this.logger.warn(`定时抓取失败：${e?.message}`),
    );
    await this.analyzePending().catch((e) =>
      this.logger.warn(`分析失败：${e?.message}`),
    );
  }

  /** 列表：取最近的精选新闻（按重要性 + 时间）。列表不返回大字段 content。 */
  async list(limit = 50) {
    const rows = await this.prisma.newsArticle.findMany({
      orderBy: [{ publishedAt: 'desc' }],
      take: Math.min(Math.max(limit, 1), 100),
      select: {
        id: true,
        title: true,
        titleZh: true,
        summary: true,
        source: true,
        url: true,
        imageUrl: true,
        category: true,
        importance: true,
        sentiment: true,
        publishedAt: true,
      },
    });
    return rows;
  }

  /**
   * 详情：返回单条新闻 + 抓取的正文 + LLM 要点分析。
   * 懒加载：首次打开时抓原文 HTML、提取正文、调 LLM 生成要点并缓存，后续直接读库。
   */
  async detail(id: string) {
    const a = await this.prisma.newsArticle.findUnique({ where: { id } });
    if (!a) return null;
    if (a.analysis && a.content) return a; // 已分析过，直接返回

    let content = a.content || '';
    if (!content) {
      content = await this.fetchArticleText(a.url);
    }
    // 用 RSS 摘要兜底，确保 LLM 至少有东西可分析
    const basis = (content || a.summary || a.title).slice(0, 8000);
    const analysis = await this.analyze(a.title, basis);

    const updated = await this.prisma.newsArticle.update({
      where: { id },
      data: {
        content: content || a.summary || null,
        analysis: analysis || null,
      },
    });
    return updated;
  }

  /** 抓取文章 HTML 并粗提取正文纯文本 */
  private async fetchArticleText(url: string): Promise<string> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; CaiJiNewsBot/1.0; +finance app)',
        },
      });
      clearTimeout(timer);
      if (!res.ok) return ''; // 401/403/付费墙等 → 降级用 RSS 摘要
      const html = await res.text();
      const text = extractMainText(html);
      // 反爬/JS 墙/太薄 → 视为抓取失败，让上层回退到摘要
      if (text.length < 300) return '';
      if (
        /enable\s+js|ad\s?blocker|are you a (robot|human)|access denied|subscribe to (read|continue)|sign in to read/i.test(
          text.slice(0, 400),
        )
      ) {
        return '';
      }
      return text;
    } catch (e) {
      this.logger.warn(`抓正文失败 ${url}: ${(e as Error).message}`);
      return '';
    }
  }

  /** LLM：基于正文生成要点分析（中文） */
  private async analyze(title: string, body: string): Promise<string> {
    if (!this.useLlm) return '';
    const modelName = this.llms.defaultTextModelName();
    if (!modelName) return '';
    const system =
      '你是资深财经分析师。基于给定新闻正文，用中文输出结构化要点，便于投资者快速决策。' +
      '格式：先一段不超过60字的「核心概要」，再用 3-6 条「• 」开头的要点（涉及的公司/资产、' +
      '影响、数据、对市场或投资者的含义）。客观、简洁，不要编造正文里没有的数字。直接输出文本，不要用 markdown 标题。';
    try {
      const res = await this.llms.get(modelName).chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: `标题：${title}\n\n正文：\n${body}` },
        ],
        { responseFormat: 'text', temperature: 0.3, maxTokens: 700 },
      );
      return (res.content || '').trim();
    } catch (e) {
      this.logger.warn(`分析失败：${(e as Error).message}`);
      return '';
    }
  }

  /** 距上次抓取超过阈值（或当天无数据）则补抓一次 */
  async ensureFresh(): Promise<void> {
    const newest = await this.prisma.newsArticle.findFirst({
      orderBy: { fetchedAt: 'desc' },
      select: { fetchedAt: true },
    });
    const stale =
      !newest || Date.now() - newest.fetchedAt.getTime() > NewsService.STALE_MS;
    if (stale) {
      await this.fetchAndStore().catch((e) =>
        this.logger.warn(`按需抓取失败：${e?.message}`),
      );
    }
  }

  /** 强制立即抓取 */
  async refresh(): Promise<number> {
    const n = await this.fetchAndStore();
    // 抓完后台补齐分析（不阻塞返回）
    void this.analyzePending().catch(() => {});
    return n;
  }

  // ── 核心：抓取 + 富化 + 入库 ────────────────────────────────
  private async fetchAndStore(): Promise<number> {
    if (this.inflight) return this.inflight;
    this.inflight = this._fetchAndStore().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async _fetchAndStore(): Promise<number> {
    const feeds = this.feeds;
    const settled = await Promise.allSettled(
      feeds.map(async (url) => ({ url, feed: await this.parser.parseURL(url) })),
    );

    type Raw = {
      title: string;
      url: string;
      snippet: string;
      source: string;
      publishedAt: Date;
      imageUrl?: string;
    };
    const raws: Raw[] = [];
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      const { url: feedUrl, feed } = s.value;
      const source = this.sourceName(feedUrl, feed.title);
      for (const item of feed.items || []) {
        const url = (item.link || item.guid || '').trim();
        const title = (item.title || '').trim();
        if (!url || !title) continue;
        const snippet = (item.contentSnippet || item.content || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400);
        const publishedAt = item.isoDate
          ? new Date(item.isoDate)
          : item.pubDate
            ? new Date(item.pubDate)
            : new Date();
        const imageUrl =
          (item.enclosure && item.enclosure.url) ||
          (item as any)['media:content']?.['$']?.url ||
          undefined;
        raws.push({ title, url, snippet, source, publishedAt, imageUrl });
      }
    }

    if (raws.length === 0) {
      this.logger.warn('所有 RSS 源都没拿到内容');
      return 0;
    }

    // 去重：库里已有的 url 跳过
    const urls = raws.map((r) => r.url);
    const existing = await this.prisma.newsArticle.findMany({
      where: { url: { in: urls } },
      select: { url: true },
    });
    const existSet = new Set(existing.map((e) => e.url));
    // 同一批内也按 url 去重
    const seen = new Set<string>();
    let fresh = raws.filter((r) => {
      if (existSet.has(r.url) || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });
    // 按时间倒序，限制单次富化/入库规模（多源覆盖各分类，放宽到 150）
    fresh.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    fresh = fresh.slice(0, 150);

    if (fresh.length === 0) {
      this.logger.log('没有新的新闻');
      await this.prune();
      return 0;
    }

    // LLM 富化（可选）
    const enrich = await this.enrich(
      fresh.map((r) => ({ title: r.title, snippet: r.snippet })),
    );

    // 入库
    let inserted = 0;
    for (let i = 0; i < fresh.length; i++) {
      const r = fresh[i];
      const e = enrich[i];
      try {
        await this.prisma.newsArticle.create({
          data: {
            title: r.title,
            titleZh: e?.titleZh || null,
            summary: e?.zh || r.snippet || null,
            source: r.source || 'RSS',
            url: r.url,
            imageUrl: r.imageUrl || null,
            category: e?.category || null,
            importance: e?.importance ?? 0,
            sentiment: e?.sentiment || null,
            publishedAt: r.publishedAt,
          },
        });
        inserted++;
      } catch {
        // 唯一约束并发冲突等，忽略
      }
    }

    await this.prune();
    this.logger.log(`新增 ${inserted} 条财经新闻`);
    return inserted;
  }

  private get analyzeAtIngest(): boolean {
    const v = (this.config.get<string>('NEWS_ANALYZE_AT_INGEST') || 'true')
      .trim()
      .toLowerCase();
    return !['false', '0', 'no', 'n'].includes(v);
  }

  private get analyzeLimit(): number {
    const n = parseInt(
      this.config.get<string>('NEWS_ANALYZE_LIMIT') || '200',
      10,
    );
    return Number.isNaN(n) ? 200 : Math.max(0, n);
  }

  /**
   * 扫库补齐分析：找出所有"还没分析"的新闻（按重要性优先），抓全文 + LLM 要点写库。
   * 幂等、可重入安全（inflight 锁），启动/抓取/重启后都能把欠的补上，
   * 这样看详情时永远是读现成结果，不再现场分析。
   */
  async analyzePending(): Promise<number> {
    if (this.analyzing || !this.analyzeAtIngest) return 0;
    this.analyzing = true;
    try {
      const rows = await this.prisma.newsArticle.findMany({
        where: { analysis: null },
        orderBy: [{ importance: 'desc' }, { publishedAt: 'desc' }],
        take: this.analyzeLimit,
        select: { id: true, url: true, title: true, summary: true },
      });
      if (!rows.length) return 0;
      this.logger.log(`开始补齐 ${rows.length} 条新闻的全文分析…`);
      const CONC = 4;
      let idx = 0;
      const worker = async () => {
        while (idx < rows.length) {
          const it = rows[idx++];
          await this.analyzeAndStore(
            it.id,
            it.url,
            it.title,
            it.summary || '',
          ).catch(() => {});
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONC, rows.length) }, () => worker()),
      );
      this.logger.log(`已完成 ${rows.length} 条新闻的全文分析`);
      return rows.length;
    } finally {
      this.analyzing = false;
    }
  }

  /** 抓单篇全文 + 分析并写库 */
  private async analyzeAndStore(
    id: string,
    url: string,
    title: string,
    summary: string,
  ): Promise<void> {
    const content = await this.fetchArticleText(url);
    const basis = (content || summary || title).slice(0, 8000);
    const analysis = await this.analyze(title, basis);
    await this.prisma.newsArticle.update({
      where: { id },
      data: {
        content: content || summary || null,
        analysis: analysis || null,
      },
    });
  }

  /** 由 feed url 主机名映射到友好来源名，回退到 feed 标题 */
  private sourceName(feedUrl: string, feedTitle?: string): string {
    let host = '';
    try {
      host = new URL(feedUrl).hostname.replace(/^www\./, '');
    } catch {
      /* ignore */
    }
    const map: Record<string, string> = {
      'cnbc.com': 'CNBC',
      'marketwatch.com': 'MarketWatch',
      'feeds.marketwatch.com': 'MarketWatch',
      'finance.yahoo.com': 'Yahoo Finance',
      'yahoo.com': 'Yahoo Finance',
      'investing.com': 'Investing.com',
      'reuters.com': 'Reuters',
      'ft.com': 'FT',
      'bloomberg.com': 'Bloomberg',
      'bbci.co.uk': 'BBC',
      'bbc.co.uk': 'BBC',
      'bbc.com': 'BBC',
      'theguardian.com': '卫报',
      'foxbusiness.com': 'Fox Business',
      'techcrunch.com': 'TechCrunch',
      'theverge.com': 'The Verge',
      'engadget.com': 'Engadget',
      '36kr.com': '36氪',
      'coindesk.com': 'CoinDesk',
      'cointelegraph.com': 'Cointelegraph',
      'decrypt.co': 'Decrypt',
      'sina.com.cn': '新浪财经',
      'rss.sina.com.cn': '新浪财经',
    };
    if (map[host]) return map[host];
    // 主域名兜底（如 abc.cnbc.com → cnbc.com）
    for (const key of Object.keys(map)) {
      if (host.endsWith(key)) return map[key];
    }
    return (feedTitle || host || 'RSS').replace(/\s*[-|·].*$/, '').trim();
  }

  /** 删除超过留存期的旧新闻 */
  private async prune() {
    const cutoff = new Date(
      Date.now() - NewsService.KEEP_DAYS * 24 * 60 * 60 * 1000,
    );
    await this.prisma.newsArticle
      .deleteMany({ where: { publishedAt: { lt: cutoff } } })
      .catch(() => {});
  }

  // ── LLM：批量翻译标题 + 排重要性 + 中文摘要 + 标签 ───────────
  private static readonly ENRICH_CHUNK = 12;

  private async enrich(
    items: { title: string; snippet: string }[],
  ): Promise<
    Array<{
      titleZh: string;
      zh: string;
      importance: number;
      category: string;
      sentiment: string;
    } | null>
  > {
    const empty = items.map(() => null);
    if (!this.useLlm || items.length === 0) return empty;
    const modelName = this.llms.defaultTextModelName();
    if (!modelName) return empty;

    // 分块（每块 ~20 条），避免单次响应过长被截断；各块并发
    const size = NewsService.ENRICH_CHUNK;
    const chunks: { start: number; items: typeof items }[] = [];
    for (let s = 0; s < items.length; s += size) {
      chunks.push({ start: s, items: items.slice(s, s + size) });
    }
    const out = items.map(() => null) as any[];
    await Promise.all(
      chunks.map(async (chunk) => {
        const local = await this.enrichChunk(modelName, chunk.items);
        for (let i = 0; i < local.length; i++) {
          out[chunk.start + i] = local[i];
        }
      }),
    );
    return out;
  }

  private async enrichChunk(
    modelName: string,
    items: { title: string; snippet: string }[],
  ): Promise<Array<any | null>> {
    const list = items
      .map(
        (it, i) =>
          `${i}. ${it.title}${it.snippet ? ' — ' + it.snippet.slice(0, 140) : ''}`,
      )
      .join('\n');
    const system =
      '你是资深财经新闻编辑。给定若干条英文/中文财经新闻，为每条输出：' +
      '中文标题(titleZh，把原标题翻译成简洁地道的中文，≤30字)、' +
      '一句话中文摘要(zh，≤40字)、重要性评分(importance，0-100，越影响全球市场/投资者越高)、' +
      '分类(category，从【股市/宏观/政策/加密/科技/AI/公司/商品/外汇/其他】里选一个；' +
      '人工智能相关-大模型/AI芯片算力/AI应用-归 AI，不要归科技)、' +
      '情绪(sentiment，positive/neutral/negative)。' +
      '严格返回 JSON：{"items":[{"i":序号,"titleZh":"","zh":"","importance":0,"category":"","sentiment":""}]}，' +
      'i 必须与输入序号对应，覆盖全部条目。字符串内不要出现未转义的双引号或换行。';

    // 模型偶发返回非法 JSON，重试 2 次（含一次容错解析）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.llms.get(modelName).chat(
          [
            { role: 'system', content: system },
            { role: 'user', content: list },
          ],
          { responseFormat: 'json_object', temperature: 0.2, maxTokens: 3000 },
        );
        const arr = parseItemsLoose(res.content || '');
        if (!arr) throw new Error('解析为空');
        const out = items.map(() => null) as any[];
        for (const o of arr) {
          const i = typeof o.i === 'number' ? o.i : parseInt(o.i, 10);
          if (Number.isInteger(i) && i >= 0 && i < items.length) {
            out[i] = {
              titleZh: String(o.titleZh || '').slice(0, 60),
              zh: String(o.zh || '').slice(0, 80),
              importance: Math.max(0, Math.min(100, Number(o.importance) || 0)),
              category: String(o.category || '').slice(0, 8),
              sentiment: ['positive', 'neutral', 'negative'].includes(
                o.sentiment,
              )
                ? o.sentiment
                : 'neutral',
            };
          }
        }
        return out;
      } catch (e) {
        if (attempt === 1) {
          this.logger.warn(
            `LLM 富化分块失败(重试后)，降级原始描述：${(e as Error).message}`,
          );
        }
      }
    }
    return items.map(() => null);
  }
}

/**
 * 容错解析 LLM 返回的 items 数组：先正常 JSON.parse；
 * 失败则截取最后一个完整对象前的片段补全数组，尽量抢救已生成的条目。
 */
function parseItemsLoose(raw: string): any[] | null {
  if (!raw) return null;
  let s = raw.trim();
  // 去掉可能的 ```json 包裹
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? p : p.items || p.data || null;
  } catch {
    /* 继续容错 */
  }
  // 容错：抓取 items 数组，截到最后一个完整 } 再补 ]
  const idx = s.indexOf('[');
  if (idx < 0) return null;
  let body = s.slice(idx);
  const lastClose = body.lastIndexOf('}');
  if (lastClose < 0) return null;
  body = body.slice(0, lastClose + 1) + ']';
  try {
    const p = JSON.parse(body);
    return Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * 从 HTML 粗提取正文：去 script/style/标签，优先取 <article>/<p> 文本，
 * 折叠空白，截断到合理长度。不依赖外部 readability 库（避免重依赖）。
 */
function extractMainText(html: string): string {
  if (!html) return '';
  // 去掉脚本/样式/注释/头部
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ');

  // 优先抓 <article> 区块（多数新闻站正文容器）
  const articleMatch = h.match(/<article[\s\S]*?<\/article>/i);
  if (articleMatch) h = articleMatch[0];

  // 收集 <p> 段落文本
  const paras: string[] = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(h)) !== null) {
    const text = stripTags(m[1]);
    if (text.length >= 40) paras.push(text); // 过滤太短的（多为导航/版权）
  }

  let body = paras.join('\n\n');
  // 段落太少时，退化为整段 strip
  if (body.length < 200) {
    body = stripTags(h);
  }
  return body.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 10000);
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
