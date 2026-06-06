import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

interface RateTable {
  /// 以 USD 为基准的汇率表：1 USD = rates[X] 个 X
  rates: Record<string, number>;
  /// 上游数据更新时间（unix 秒）
  updatedAt: number;
  /// 本地抓取时间（ms）
  fetchedAt: number;
}

/**
 * 汇率服务：代理免费汇率源（open.er-api.com，无需 key），
 * 服务端内存缓存一张以 USD 为基准的表，任意币种间换算由本地交叉计算得出。
 *
 * - 上游每日更新，故缓存 TTL 设 3 小时，避免频繁外呼
 * - 上游故障时回退到过期缓存（stale-while-error），保证可用性
 * - 汇率是公开数据，不涉及账本/加密隐私
 */
@Injectable()
export class ExchangeService {
  private readonly logger = new Logger('ExchangeService');
  private cache: RateTable | null = null;
  private inflight: Promise<RateTable> | null = null;

  private static readonly TTL_MS = 3 * 60 * 60 * 1000; // 3h
  private static readonly UPSTREAM = 'https://open.er-api.com/v6/latest/USD';

  private async ensureTable(): Promise<RateTable> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < ExchangeService.TTL_MS) {
      return this.cache;
    }
    // 合并并发请求，避免多个调用同时打上游
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(ExchangeService.UPSTREAM, {
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`upstream ${res.status}`);
        const data: any = await res.json();
        if (data.result !== 'success' || !data.rates) {
          throw new Error('bad upstream payload');
        }
        const table: RateTable = {
          rates: data.rates,
          updatedAt:
            typeof data.time_last_update_unix === 'number'
              ? data.time_last_update_unix
              : Math.floor(Date.now() / 1000),
          fetchedAt: Date.now(),
        };
        this.cache = table;
        return table;
      } catch (e) {
        this.logger.warn(`fetch rates failed: ${(e as Error).message}`);
        // 回退到过期缓存
        if (this.cache) return this.cache;
        throw new ServiceUnavailableException('汇率服务暂时不可用，请稍后再试');
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }

  /**
   * 返回以 [base] 为基准的汇率表：1 base = rates[X] 个 X。
   */
  async getRates(base: string): Promise<{
    base: string;
    updatedAt: string;
    rates: Record<string, number>;
  }> {
    const b = (base || 'CNY').toUpperCase();
    const table = await this.ensureTable();
    const baseRate = table.rates[b];
    if (!baseRate) {
      throw new ServiceUnavailableException(`不支持的币种：${b}`);
    }
    const out: Record<string, number> = {};
    for (const [cur, usdRate] of Object.entries(table.rates)) {
      // 1 base = (usdRate / baseRate) 个 cur
      out[cur] = (usdRate as number) / baseRate;
    }
    return {
      base: b,
      updatedAt: new Date(table.updatedAt * 1000).toISOString(),
      rates: out,
    };
  }
}
