import { Prisma } from '@prisma/client';

/**
 * 对账中心 · 四项内部一致性检查（纯函数，Jest 单测覆盖）
 *
 * 设计约束：
 *  - 只操作明文字段（amount / date / type / accountId / categoryId），
 *    绝不触碰 noteCipher / nameCipher（端到端加密隐私不变式）。
 *  - 金额一律 Prisma.Decimal 运算，禁止浮点累加；仅序列化输出时转 number。
 *  - source='stock' 纸面盈亏：每日结算维护，按市值变化增减余额，与「当日盈亏」
 *    流水口径可能有结算差；四项检查排除。
 *  - source='stock_close' 平仓已实现盈亏：计入收支但不改余额（避免与纸面双计）；
 *    余额恒等式与疑似重复检查同样排除。
 *    balanceDrift 另把股票相关净额作为提示信息返回。
 */

export type ReconcileSeverity = 'ok' | 'info' | 'warning' | 'critical';

const SEV_RANK: Record<ReconcileSeverity, number> = {
  ok: 0,
  info: 1,
  warning: 2,
  critical: 3,
};

/** 区块严重度 = 所有条目的最高档；无条目 = ok */
export function worstSeverity(items: { severity: ReconcileSeverity }[]): ReconcileSeverity {
  let worst: ReconcileSeverity = 'ok';
  for (const i of items) {
    if (SEV_RANK[i.severity] > SEV_RANK[worst]) worst = i.severity;
  }
  return worst;
}

// ── 输入结构（service 从 Prisma 读出后适配） ─────────────────────

export interface RcAccount {
  id: string;
  initialBalance: Prisma.Decimal | number | string;
  balance: Prisma.Decimal | number | string;
}

export interface RcBill {
  id: string;
  accountId: string;
  categoryId: string;
  /** income / expense */
  type: string;
  amount: Prisma.Decimal | number | string;
  date: Date;
  isTransfer: boolean;
  source: string;
  /** 银行流水快照余额（仅导入流水有）；用于重复判定的强反证 */
  bankBalance?: Prisma.Decimal | number | string | null;
  /** 外部订单号 / 流水号（导入来源有）；不同即铁定是两笔真实交易 */
  externalId?: string | null;
}

export interface RcRecurring {
  id: string;
  accountId: string;
  categoryId: string;
  type: string;
  amount: Prisma.Decimal | number | string;
  nextDate: Date;
}

const dec = (x: Prisma.Decimal | number | string) => new Prisma.Decimal(x);
const DAY_MS = 86_400_000;

/** 偏差小于该值视为一致（分位） */
const DRIFT_TOLERANCE = new Prisma.Decimal('0.01');
/** 无股票因素时，偏差达到该值升级为 critical */
const DRIFT_CRITICAL = new Prisma.Decimal('100');

// ── 1. balanceDrift：余额一致性 ──────────────────────────────────
// 恒等式：initialBalance + 全部流水净额（收入−支出，含转账双腿，排除 stock）
//         = 当前 balance。偏离即说明存在漏记 / 校准 / 结算差。

export interface BalanceDriftItem {
  accountId: string;
  initialBalance: Prisma.Decimal;
  flowNet: Prisma.Decimal;
  expected: Prisma.Decimal;
  actual: Prisma.Decimal;
  /** actual − expected（正 = 账面比推算多） */
  drift: Prisma.Decimal;
  /** 该账户是否存在 stock 流水（有则偏差大概率来自纸面盈亏结算） */
  hasStock: boolean;
  severity: ReconcileSeverity;
}

export function checkBalanceDrift(
  accounts: RcAccount[],
  nonStockNet: Map<string, Prisma.Decimal>,
  stockNet: Map<string, Prisma.Decimal>,
): BalanceDriftItem[] {
  const items: BalanceDriftItem[] = [];
  for (const a of accounts) {
    const initial = dec(a.initialBalance);
    const net = nonStockNet.get(a.id) ?? new Prisma.Decimal(0);
    const expected = initial.add(net);
    const actual = dec(a.balance);
    const drift = actual.sub(expected);
    if (drift.abs().lt(DRIFT_TOLERANCE)) continue;

    const hasStock = (stockNet.get(a.id) ?? new Prisma.Decimal(0))
      .abs()
      .gte(DRIFT_TOLERANCE);
    const severity: ReconcileSeverity = hasStock
      ? 'info'
      : drift.abs().gte(DRIFT_CRITICAL)
        ? 'critical'
        : 'warning';
    items.push({
      accountId: a.id,
      initialBalance: initial,
      flowNet: net,
      expected,
      actual,
      drift,
      hasStock,
      severity,
    });
  }
  // 偏差绝对值大的在前
  items.sort((x, y) => y.drift.abs().cmp(x.drift.abs()));
  return items;
}

// ── 2. suspectedDuplicates：疑似重复账单 ─────────────────────────
// 同账户、同方向、同金额、日期差 ≤ windowDays 的相邻账单对。
// 分组内按日期排序后只报「相邻对」（N 条报 N−1 对），避免 3 条连坐报 3 对的噪音；
// 只报 later 腿落在 [monthStart, monthEnd] 内的对（数据窗口含前溯，
// 跨月边界的对锚定在后腿所在月，保证每对只出现一次）。
// 强反证：两腿都有银行余额快照且余额不同 → 两笔之间账户余额变了，
// 必然是真两笔流水，不算重复。

export interface DupBillRef {
  id: string;
  date: Date;
}

export interface SuspectedDuplicateItem {
  accountId: string;
  /** 跨账户对：另一腿所在账户（同账户对为空） */
  secondAccountId?: string;
  /** true = 同账本不同账户之间的疑似重复（可能是两人各记了同一笔） */
  crossAccount?: boolean;
  type: string;
  amount: Prisma.Decimal;
  gapDays: number;
  first: DupBillRef;
  second: DupBillRef;
  severity: ReconcileSeverity;
}

export function checkSuspectedDuplicates(
  bills: RcBill[],
  monthStart: Date,
  monthEnd: Date,
  windowDays = 4,
): SuspectedDuplicateItem[] {
  const groups = new Map<string, RcBill[]>();
  for (const b of bills) {
    if (b.source === 'stock' || b.source === 'stock_close') continue;
    const key = `${b.accountId}|${b.type}|${dec(b.amount).toFixed(2)}`;
    const arr = groups.get(key);
    if (arr) arr.push(b);
    else groups.set(key, [b]);
  }

  const items: SuspectedDuplicateItem[] = [];
  const startMs = monthStart.getTime();
  const endMs = monthEnd.getTime();
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    arr.sort((x, y) => x.date.getTime() - y.date.getTime() || x.id.localeCompare(y.id));
    for (let i = 0; i + 1 < arr.length; i++) {
      const a = arr[i];
      const b = arr[i + 1];
      const gapDays = Math.round((b.date.getTime() - a.date.getTime()) / DAY_MS);
      if (gapDays > windowDays) continue;
      // 余额反证：两腿都有余额快照且不同 → 不是重复流水
      if (a.bankBalance != null && b.bankBalance != null) {
        const diff = dec(a.bankBalance).sub(dec(b.bankBalance)).abs();
        if (diff.gt(DRIFT_TOLERANCE)) continue;
      }
      // 单号反证：两腿都有外部单号且不同 → 铁定是两笔真实交易
      // （典型：每天通勤的地铁代扣，同商户同金额，但微信/银行单号各异）
      if (a.externalId && b.externalId && a.externalId !== b.externalId) continue;
      const bMs = b.date.getTime();
      if (bMs < startMs || bMs > endMs) continue; // 锚定到后腿所在月
      items.push({
        accountId: b.accountId,
        type: b.type,
        amount: dec(b.amount),
        gapDays,
        first: { id: a.id, date: a.date },
        second: { id: b.id, date: b.date },
        severity: 'warning',
      });
    }
  }

  // ── 跨账户配对：同账本不同账户（含其他成员账户）──────────────
  // 场景：共享账本里两人各自导入自己的流水，同一笔消费在两个账户各记一次。
  // 反证规则与同账户不同：不同来源的同一笔交易单号 / 余额快照天然不同，
  // 所以 externalId、bankBalance 在这里不作反证；单号相同反而是强信号。
  const xGroups = new Map<string, RcBill[]>();
  for (const b of bills) {
    if (b.source === 'stock' || b.source === 'stock_close') continue;
    const key = `${b.type}|${dec(b.amount).toFixed(2)}`;
    const arr = xGroups.get(key);
    if (arr) arr.push(b);
    else xGroups.set(key, [b]);
  }
  for (const arr of xGroups.values()) {
    if (arr.length < 2) continue;
    // 组内只有一个账户 → 不存在跨账户对
    if (new Set(arr.map((x) => x.accountId)).size < 2) continue;
    arr.sort((x, y) => x.date.getTime() - y.date.getTime() || x.id.localeCompare(y.id));
    for (let i = 0; i + 1 < arr.length; i++) {
      const a = arr[i];
      const b = arr[i + 1];
      if (a.accountId === b.accountId) continue; // 同账户对已由上面处理
      const gapDays = Math.round((b.date.getTime() - a.date.getTime()) / DAY_MS);
      if (gapDays > windowDays) continue;
      const bMs = b.date.getTime();
      if (bMs < startMs || bMs > endMs) continue; // 锚定到后腿所在月
      items.push({
        accountId: a.accountId,
        secondAccountId: b.accountId,
        crossAccount: true,
        type: b.type,
        amount: dec(b.amount),
        gapDays,
        first: { id: a.id, date: a.date },
        second: { id: b.id, date: b.date },
        severity: 'warning',
      });
    }
  }
  items.sort((x, y) => y.second.date.getTime() - x.second.date.getTime());
  return items.slice(0, 100);
}

// ── 3. recurringMissing：周期账单缺记 ────────────────────────────
// 周期账单 nextDate 已过（≤ asOf），但当月找不到匹配账单：
// 匹配 = 同方向 + 金额差 ≤ 0.01 + 分类模糊匹配（同分类 / 父子 / 兄弟）。
// 不限账户（用户可能换账户支付），命中最宽松、宁可少报。

export interface RecurringMissingItem {
  recurringId: string;
  accountId: string;
  categoryId: string;
  type: string;
  amount: Prisma.Decimal;
  /** 触发日期（即存储的 nextDate；滞后多时即为最早缺记日） */
  dueDate: Date;
  severity: ReconcileSeverity;
}

const RECURRING_AMOUNT_TOLERANCE = new Prisma.Decimal('0.01');

export function fuzzyCategoryMatch(
  a: string,
  b: string,
  parentOf: Map<string, string | null>,
): boolean {
  if (a === b) return true;
  const pa = parentOf.get(a) ?? null;
  const pb = parentOf.get(b) ?? null;
  if (pa !== null && pa === b) return true; // a 是 b 的子类
  if (pb !== null && pb === a) return true; // b 是 a 的子类
  return pa !== null && pa === pb; // 兄弟分类
}

export function checkRecurringMissing(
  recurring: RcRecurring[],
  bills: RcBill[],
  parentOf: Map<string, string | null>,
  monthStart: Date,
  monthEnd: Date,
  asOf: Date,
): RecurringMissingItem[] {
  const startMs = monthStart.getTime();
  const endMs = monthEnd.getTime();
  const monthBills = bills.filter((b) => {
    if (b.source === 'stock' || b.source === 'stock_close') return false;
    const ms = b.date.getTime();
    return ms >= startMs && ms <= endMs;
  });

  const items: RecurringMissingItem[] = [];
  for (const r of recurring) {
    if (r.nextDate.getTime() > asOf.getTime()) continue; // 还没到触发日
    const rAmt = dec(r.amount);
    const matched = monthBills.some(
      (b) =>
        b.type === r.type &&
        dec(b.amount).sub(rAmt).abs().lte(RECURRING_AMOUNT_TOLERANCE) &&
        fuzzyCategoryMatch(b.categoryId, r.categoryId, parentOf),
    );
    if (matched) continue;
    items.push({
      recurringId: r.id,
      accountId: r.accountId,
      categoryId: r.categoryId,
      type: r.type,
      amount: rAmt,
      dueDate: r.nextDate,
      severity: 'info',
    });
  }
  items.sort((x, y) => x.dueDate.getTime() - y.dueDate.getTime());
  return items;
}

// ── 4. transferOrphans：转账缺腿 ─────────────────────────────────
// 一笔正常转账 = 同账本、同金额、收支相反、日期差 ≤ windowDays 的两条腿。
// 用日期序贪心配对（每条腿最多用一次），配不上的即孤儿——说明另一腿
// 被删 / 改金额 / 改日期，两个账户的余额从此各错一笔。

export function checkTransferOrphans(
  bills: RcBill[],
  monthStart: Date,
  monthEnd: Date,
  windowDays = 2,
): RcBill[] {
  const transfers = bills
    .filter((b) => b.isTransfer && b.source !== 'stock' && b.source !== 'stock_close')
    .sort((x, y) => x.date.getTime() - y.date.getTime() || x.id.localeCompare(y.id));

  const windowMs = windowDays * DAY_MS;
  const unmatched: RcBill[] = [];
  for (const t of transfers) {
    const tAmt = dec(t.amount);
    const idx = unmatched.findIndex(
      (p) =>
        p.type !== t.type &&
        p.accountId !== t.accountId &&
        dec(p.amount).equals(tAmt) &&
        Math.abs(p.date.getTime() - t.date.getTime()) <= windowMs,
    );
    if (idx >= 0) unmatched.splice(idx, 1); // 配对成功，双方出列
    else unmatched.push(t);
  }

  const startMs = monthStart.getTime();
  const endMs = monthEnd.getTime();
  return unmatched.filter((b) => {
    const ms = b.date.getTime();
    return ms >= startMs && ms <= endMs;
  });
}
