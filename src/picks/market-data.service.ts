import { Injectable, Logger } from '@nestjs/common';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export interface BoardRow {
  code: string; // 新浪行业代码，如 new_dzqj
  name: string;
  count: number; // 公司家数
  pct: number; // 板块涨跌幅 %
  amount: number; // 成交额（元）
  lead: string; // 领涨股名称
}

export interface StockRow {
  code: string; // 6 位代码
  symbol: string; // 带市场前缀，如 sh600176
  name: string;
  price: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  preClose: number;
  volume: number;
  amount: number; // 成交额（元）
  pe: number | null;
  pb: number | null;
  turnover: number | null; // 换手率 %
  mktcap: number | null; // 总市值
  nmc: number | null; // 流通市值
}

/**
 * 行情数据源：新浪财经（免费、免 token）。
 * 选它是因为东财 push2.eastmoney.com 在本部署网络不可达（UND_ERR_SOCKET），
 * 而新浪的行业板块列表 + 板块成分股接口稳定可达。
 *  - 板块列表（GBK 编码，用 TextDecoder('gbk') 解）
 *  - 板块成分股（标准 JSON，含价/涨幅/PE/PB/换手/市值）
 */
@Injectable()
export class MarketDataService {
  private readonly logger = new Logger('MarketData');
  private static readonly SINA = 'https://vip.stock.finance.sina.com.cn';

  private async getText(url: string, gbk = false): Promise<string> {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (gbk) {
      const buf = await res.arrayBuffer();
      return new TextDecoder('gbk').decode(buf);
    }
    return res.text();
  }

  /** 全部新浪行业板块（板块级：涨幅、成交额、领涨股） */
  async fetchBoards(): Promise<BoardRow[]> {
    const txt = await this.getText(
      `${MarketDataService.SINA}/q/view/newSinaHy.php`,
      true,
    );
    const m = txt.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (!m) return [];
    let obj: Record<string, string>;
    try {
      obj = JSON.parse(m[1]);
    } catch {
      return [];
    }
    const rows: BoardRow[] = [];
    for (const v of Object.values(obj)) {
      const a = String(v).split(',');
      if (a.length < 13) continue;
      rows.push({
        code: a[0],
        name: a[1],
        count: Number(a[2]) || 0,
        pct: Number(a[5]) || 0,
        amount: Number(a[7]) || 0,
        lead: a[12] || '',
      });
    }
    return rows;
  }

  /** 某板块成分股（按涨幅倒序，最多 num 只） */
  async fetchBoardStocks(boardCode: string, num = 80): Promise<StockRow[]> {
    const url =
      `${MarketDataService.SINA}/quotes_service/api/json_v2.php/Market_Center.getHQNodeData` +
      `?page=1&num=${num}&sort=changepercent&asc=0&node=${encodeURIComponent(boardCode)}`;
    const txt = await this.getText(url);
    let arr: any[];
    try {
      arr = JSON.parse(txt);
    } catch {
      return [];
    }
    if (!Array.isArray(arr)) return [];
    return arr.map((d) => ({
      code: String(d.code || ''),
      symbol: String(d.symbol || ''),
      name: String(d.name || ''),
      price: Number(d.trade) || 0,
      changePercent: Number(d.changepercent) || 0,
      open: Number(d.open) || 0,
      high: Number(d.high) || 0,
      low: Number(d.low) || 0,
      preClose: Number(d.settlement) || 0,
      volume: Number(d.volume) || 0,
      amount: Number(d.amount) || 0,
      pe: d.per != null ? Number(d.per) : null,
      pb: d.pb != null ? Number(d.pb) : null,
      turnover: d.turnoverratio != null ? Number(d.turnoverratio) : null,
      mktcap: d.mktcap != null ? Number(d.mktcap) : null,
      nmc: d.nmc != null ? Number(d.nmc) : null,
    }));
  }

  /**
   * 批量取现价（腾讯 qt.gtimg.cn，一次可拉很多只，用于复盘历史推荐）。
   * 入参 symbols 形如 ['sh600176','sz000823']；返回 symbol → 现价。
   */
  async fetchQuotes(symbols: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const uniq = [...new Set(symbols.filter(Boolean))];
    const CHUNK = 60;
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const batch = uniq.slice(i, i + CHUNK);
      try {
        const res = await fetch(
          `https://qt.gtimg.cn/q=${batch.join(',')}`,
          { headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' } },
        );
        const txt = new TextDecoder('gbk').decode(await res.arrayBuffer());
        for (const line of txt.split(';')) {
          const m = line.match(/v_(\w+)="([^"]*)"/);
          if (!m) continue;
          const f = m[2].split('~');
          const price = Number(f[3]);
          if (isFinite(price) && price > 0) out.set(m[1], price);
        }
      } catch {
        /* 单批失败忽略，继续下一批 */
      }
    }
    return out;
  }

  /** 主板且非 ST：沪主板 60xxxx / 深主板 000·001·002·003，排除创业板·科创板·北交所·ST */
  isMainBoardNonST(code: string, name: string): boolean {
    if (!code) return false;
    if (/ST/i.test(name)) return false;
    if (code.startsWith('60')) return true; // 沪主板（不含 688 科创）
    if (/^00[0123]/.test(code)) return true; // 深主板（含原中小板 002）
    return false;
  }
}
