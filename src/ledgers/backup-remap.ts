/**
 * 备份恢复 · id 重映射（纯函数，不碰数据库，便于 Jest 单测）
 *
 * 输入：备份数据包（各实体带「原 id」，cipher 字段保持密文 base64 原样）
 * 输出：按依赖顺序排好的 createMany 数据（全部换新 id，外键已改写）
 *
 * 隐私不变式：本函数只搬运字段，绝不解密 noteCipher / nameCipher。
 *
 * 悬空外键策略（dangling = 引用了数据包里不存在的 id）：
 *  - bills.accountId / bills.categoryId 悬空 → 丢弃该账单并计数（required FK）
 *  - budgets.categoryId 悬空 → 丢弃该预算并计数（置 null 会错变「总预算」）
 *  - recurring.categoryId / accountId 悬空 → 丢弃并计数（required FK）
 *  - categories.parentId 悬空 → 升为一级分类并计数
 *  - accounts.autoDepositCategoryId / goals.accountId / loans.accountId 悬空 → 置 null 并计数（可空 FK）
 *  - accounts.ownerId 非恢复者 → 置 null（恢复方拿不到他人私人账户语义）
 */

// ── 输入行（字段即现有 model 字段的 JSON 形态）─────────────────
export interface BackupCategoryInput {
  id: string;
  name: string;
  type: string;
  icon?: string | null;
  color?: string | null;
  parentId?: string | null;
  /** 父分类名（仅用于系统分类匹配，导出时带上） */
  parentName?: string | null;
  isSystem?: boolean;
}

export interface BackupAccountInput {
  id: string;
  nameCipher: string;
  nameDekVer?: number;
  type: string;
  balance?: number | string;
  initialBalance?: number | string;
  icon?: string | null;
  color?: string | null;
  ownerId?: string | null;
  statementDay?: number | null;
  dueDay?: number | null;
  creditLimit?: number | string | null;
  interestRate?: number | string | null;
  loanPrincipal?: number | string | null;
  loanTermMonths?: number | null;
  firstPaymentDate?: string | null;
  repaymentMethod?: string | null;
  autoDepositDay?: number | null;
  autoDepositAmount?: number | string | null;
  autoDepositCategoryId?: string | null;
  lastAutoProcessedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface BackupBillInput {
  id: string;
  accountId: string;
  categoryId: string;
  type: string;
  amount: number | string;
  noteCipher: string;
  noteDekVer?: number;
  date: string;
  externalId?: string | null;
  source?: string;
  isTransfer?: boolean;
  bankBalance?: number | string | null;
  merchantHash?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface BackupBudgetInput {
  id: string;
  categoryId?: string | null;
  amount: number | string;
  period: string;
  startDate: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface BackupGoalInput {
  id: string;
  nameCipher: string;
  nameDekVer?: number;
  targetAmount: number | string;
  startDate?: string | null;
  accountId?: string | null;
  initialBalance?: number | string | null;
  deadline?: string | null;
  icon?: string | null;
  color?: string | null;
  isCompleted?: boolean;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface BackupLoanInput {
  id: string;
  direction: string;
  amount: number | string;
  repaidAmount?: number | string;
  accountId?: string | null;
  noteCipher?: string | null;
  noteDekVer?: number;
  voucherKey?: string | null;
  date: string;
  settledAt?: string | null;
  createdAt?: string;
}

export interface BackupRecurringInput {
  id: string;
  categoryId: string;
  accountId: string;
  type?: string;
  amount: number | string;
  noteCipher?: string | null;
  noteDekVer?: number | null;
  cycleType: string;
  cycleDay: number;
  nextDate: string;
  isActive?: boolean;
  isAuto?: boolean;
  confidence?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface BackupPayload {
  categories?: BackupCategoryInput[];
  accounts?: BackupAccountInput[];
  bills?: BackupBillInput[];
  budgets?: BackupBudgetInput[];
  goals?: BackupGoalInput[];
  loans?: BackupLoanInput[];
  recurring?: BackupRecurringInput[];
}

// ── 输出行（cipher 字段仍是 base64 字符串，由 service 转 Buffer）──
export interface RemapContext {
  /** 恢复者用户 id（新账本 owner / 记账人 / 目标所属人） */
  userId: string;
  /** 新账本 id（service 事先生成，事务内显式写库） */
  ledgerId: string;
  /** 新 id 生成器（注入以便测试确定性） */
  newId: () => string;
  /** 当前时间 ISO（缺省 createdAt/updatedAt 时兜底） */
  now: string;
  /** 现有系统分类（全局），恢复时按 (type, parentName, name) 复用而非重建 */
  systemCategories: Array<{
    id: string;
    name: string;
    type: string;
    parentName: string | null;
  }>;
}

export interface RemapStats {
  /** 悬空外键导致整行丢弃的数量 */
  dropped: { bills: number; budgets: number; recurring: number };
  /** 悬空外键被置 null（或私人账户被共享化）的数量 */
  nulled: {
    categoryParents: number;
    privateAccounts: number;
    autoDepositCategories: number;
    goalAccounts: number;
    loanAccounts: number;
  };
  /** 结构不合法被跳过的行数（缺必填字段 / 枚举值非法） */
  invalidRows: number;
  /** 系统分类按名称复用（未重建）的数量 */
  systemCategoriesMatched: number;
  /** 新建到恢复账本的自定义分类数量（含未匹配上的「系统」分类降级） */
  customCategoriesCreated: number;
}

export interface RemapOutput {
  categories: Array<Record<string, unknown>>;
  accounts: Array<Record<string, unknown>>;
  budgets: Array<Record<string, unknown>>;
  bills: Array<Record<string, unknown>>;
  goals: Array<Record<string, unknown>>;
  loans: Array<Record<string, unknown>>;
  recurring: Array<Record<string, unknown>>;
  /** old → new 的 id 映射（调试用 / 测试断言用） */
  idMaps: {
    categories: Map<string, string>;
    accounts: Map<string, string>;
  };
  stats: RemapStats;
}

const ACCOUNT_TYPES = new Set([
  'CASH', 'BANK', 'VIRTUAL', 'CREDIT', 'INVESTMENT', 'INSURANCE', 'DEBT',
  'OTHER', 'ALIPAY', 'WECHAT',
]);
const BILL_TYPES = new Set(['income', 'expense']);
const BUDGET_PERIODS = new Set(['MONTHLY', 'YEARLY']);
const LOAN_DIRECTIONS = new Set(['lend', 'borrow']);

export function remapBackup(
  payload: BackupPayload,
  ctx: RemapContext,
): RemapOutput {
  const stats: RemapStats = {
    dropped: { bills: 0, budgets: 0, recurring: 0 },
    nulled: {
      categoryParents: 0,
      privateAccounts: 0,
      autoDepositCategories: 0,
      goalAccounts: 0,
      loanAccounts: 0,
    },
    invalidRows: 0,
    systemCategoriesMatched: 0,
    customCategoriesCreated: 0,
  };
  const catMap = new Map<string, string>();
  const accMap = new Map<string, string>();
  const { userId, ledgerId, now } = ctx;
  const at = (v?: string) => v ?? now;

  // ── 分类：系统分类按 (type,parentName,name) 复用；其余两级拓扑重建 ──
  const sysIndex = new Map<string, string>();
  for (const s of ctx.systemCategories) {
    sysIndex.set(`${s.type}|${s.parentName ?? ''}|${s.name}`, s.id);
  }
  const categoriesOut: Array<Record<string, unknown>> = [];
  const pending: BackupCategoryInput[] = [];
  for (const c of payload.categories ?? []) {
    if (!c || !c.id || !c.name || !BILL_TYPES.has(c.type)) {
      stats.invalidRows++;
      continue;
    }
    if (c.isSystem) {
      const hit = sysIndex.get(`${c.type}|${c.parentName ?? ''}|${c.name}`);
      if (hit) {
        catMap.set(c.id, hit);
        stats.systemCategoriesMatched++;
        continue;
      }
      // 系统分类在目标库找不到（跨实例 / 种子差异）→ 降级为自定义分类重建
    }
    pending.push(c);
  }
  // 拓扑：父分类已映射（或是一级）的先建；父在 pending 里就等下一轮
  let guard = pending.length + 2;
  while (pending.length > 0 && guard-- > 0) {
    let progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const c = pending[i];
      let parentNew: string | null = null;
      if (c.parentId) {
        const mapped = catMap.get(c.parentId);
        if (mapped) {
          parentNew = mapped;
        } else if (pending.some((p) => p.id === c.parentId)) {
          continue; // 父还没建，下一轮
        } else {
          stats.nulled.categoryParents++; // 悬空父 → 升为一级
        }
      }
      const id = ctx.newId();
      catMap.set(c.id, id);
      categoriesOut.push({
        id,
        ledgerId,
        userId,
        name: c.name,
        type: c.type,
        icon: c.icon ?? null,
        color: c.color ?? null,
        isSystem: false,
        parentId: parentNew,
        createdAt: now,
      });
      stats.customCategoriesCreated++;
      pending.splice(i, 1);
      progressed = true;
    }
    if (!progressed) {
      // parentId 成环等病态数据：剩余全部升为一级，不死循环
      for (const c of pending) {
        const id = ctx.newId();
        catMap.set(c.id, id);
        categoriesOut.push({
          id,
          ledgerId,
          userId,
          name: c.name,
          type: c.type,
          icon: c.icon ?? null,
          color: c.color ?? null,
          isSystem: false,
          parentId: null,
          createdAt: now,
        });
        stats.customCategoriesCreated++;
        stats.nulled.categoryParents++;
      }
      pending.length = 0;
    }
  }

  // ── 账户：ownerId 非恢复者置 null；autoDepositCategoryId 重映射 ──
  const accountsOut: Array<Record<string, unknown>> = [];
  for (const a of payload.accounts ?? []) {
    if (!a || !a.id || !a.nameCipher || !ACCOUNT_TYPES.has(a.type)) {
      stats.invalidRows++;
      continue;
    }
    let ownerId: string | null = null;
    if (a.ownerId) {
      if (a.ownerId === userId) {
        ownerId = userId;
      } else {
        stats.nulled.privateAccounts++; // 他人私人账户 → 恢复为共享
      }
    }
    let autoCat: string | null = null;
    if (a.autoDepositCategoryId) {
      autoCat = catMap.get(a.autoDepositCategoryId) ?? null;
      if (!autoCat) stats.nulled.autoDepositCategories++;
    }
    const id = ctx.newId();
    accMap.set(a.id, id);
    accountsOut.push({
      id,
      ledgerId,
      ownerId,
      nameCipher: a.nameCipher,
      nameDekVer: a.nameDekVer ?? 1,
      type: a.type,
      balance: a.balance ?? 0,
      initialBalance: a.initialBalance ?? 0,
      icon: a.icon ?? null,
      color: a.color ?? null,
      statementDay: a.statementDay ?? null,
      dueDay: a.dueDay ?? null,
      creditLimit: a.creditLimit ?? null,
      interestRate: a.interestRate ?? null,
      loanPrincipal: a.loanPrincipal ?? null,
      loanTermMonths: a.loanTermMonths ?? null,
      firstPaymentDate: a.firstPaymentDate ?? null,
      repaymentMethod: a.repaymentMethod ?? null,
      autoDepositDay: a.autoDepositDay ?? null,
      autoDepositAmount: a.autoDepositAmount ?? null,
      autoDepositCategoryId: autoCat,
      lastAutoProcessedAt: a.lastAutoProcessedAt ?? null,
      createdAt: at(a.createdAt),
      updatedAt: at(a.updatedAt),
    });
  }

  // ── 预算：categoryId 悬空 → 丢弃（置 null 会错变总预算）──
  const budgetsOut: Array<Record<string, unknown>> = [];
  for (const b of payload.budgets ?? []) {
    if (!b || !b.id || b.amount == null || !BUDGET_PERIODS.has(b.period) || !b.startDate) {
      stats.invalidRows++;
      continue;
    }
    let categoryId: string | null = null;
    if (b.categoryId) {
      categoryId = catMap.get(b.categoryId) ?? null;
      if (!categoryId) {
        stats.dropped.budgets++;
        continue;
      }
    }
    budgetsOut.push({
      id: ctx.newId(),
      ledgerId,
      categoryId,
      amount: b.amount,
      period: b.period,
      startDate: b.startDate,
      createdAt: at(b.createdAt),
      updatedAt: at(b.updatedAt),
    });
  }

  // ── 账单：账户 / 分类任一悬空 → 丢弃并计数；记账人归为恢复者 ──
  const billsOut: Array<Record<string, unknown>> = [];
  for (const b of payload.bills ?? []) {
    if (
      !b || !b.id || !BILL_TYPES.has(b.type) ||
      b.amount == null || !b.date || !b.noteCipher
    ) {
      stats.invalidRows++;
      continue;
    }
    const accountId = b.accountId ? accMap.get(b.accountId) : undefined;
    const categoryId = b.categoryId ? catMap.get(b.categoryId) : undefined;
    if (!accountId || !categoryId) {
      stats.dropped.bills++;
      continue;
    }
    billsOut.push({
      id: ctx.newId(),
      ledgerId,
      userId,
      accountId,
      categoryId,
      type: b.type,
      amount: b.amount,
      noteCipher: b.noteCipher,
      noteDekVer: b.noteDekVer ?? 1,
      date: b.date,
      externalId: b.externalId ?? null,
      source: b.source ?? 'manual',
      isTransfer: !!b.isTransfer,
      bankBalance: b.bankBalance ?? null,
      merchantHash: b.merchantHash ?? null,
      createdAt: at(b.createdAt),
      updatedAt: at(b.updatedAt),
    });
  }

  // ── 储蓄目标：accountId 悬空 → 置 null（退化为按收支净额计进度）──
  const goalsOut: Array<Record<string, unknown>> = [];
  for (const g of payload.goals ?? []) {
    if (!g || !g.id || !g.nameCipher || g.targetAmount == null) {
      stats.invalidRows++;
      continue;
    }
    let accountId: string | null = null;
    if (g.accountId) {
      accountId = accMap.get(g.accountId) ?? null;
      if (!accountId) stats.nulled.goalAccounts++;
    }
    goalsOut.push({
      id: ctx.newId(),
      userId,
      ledgerId,
      nameCipher: g.nameCipher,
      nameDekVer: g.nameDekVer ?? 1,
      targetAmount: g.targetAmount,
      startDate: g.startDate ?? now,
      accountId,
      initialBalance: g.initialBalance ?? null,
      deadline: g.deadline ?? null,
      icon: g.icon ?? null,
      color: g.color ?? null,
      isCompleted: !!g.isCompleted,
      completedAt: g.completedAt ?? null,
      createdAt: at(g.createdAt),
      updatedAt: at(g.updatedAt),
    });
  }

  // ── 借贷往来：accountId 悬空 → 置 null；还款明细不在备份范围（见报告）──
  const loansOut: Array<Record<string, unknown>> = [];
  for (const l of payload.loans ?? []) {
    if (!l || !l.id || !LOAN_DIRECTIONS.has(l.direction) || l.amount == null || !l.date) {
      stats.invalidRows++;
      continue;
    }
    let accountId: string | null = null;
    if (l.accountId) {
      accountId = accMap.get(l.accountId) ?? null;
      if (!accountId) stats.nulled.loanAccounts++;
    }
    loansOut.push({
      id: ctx.newId(),
      ledgerId,
      userId,
      direction: l.direction,
      amount: l.amount,
      repaidAmount: l.repaidAmount ?? 0,
      accountId,
      noteCipher: l.noteCipher ?? null, // String 列（base64），原样透传
      noteDekVer: l.noteDekVer ?? 1,
      voucherKey: l.voucherKey ?? null,
      date: l.date,
      settledAt: l.settledAt ?? null,
      createdAt: at(l.createdAt),
    });
  }

  // ── 周期账单：账户 / 分类任一悬空 → 丢弃并计数 ──
  const recurringOut: Array<Record<string, unknown>> = [];
  for (const r of payload.recurring ?? []) {
    if (
      !r || !r.id || r.amount == null ||
      !r.cycleType || r.cycleDay == null || !r.nextDate
    ) {
      stats.invalidRows++;
      continue;
    }
    const type = r.type ?? 'expense';
    if (!BILL_TYPES.has(type)) {
      stats.invalidRows++;
      continue;
    }
    const accountId = r.accountId ? accMap.get(r.accountId) : undefined;
    const categoryId = r.categoryId ? catMap.get(r.categoryId) : undefined;
    if (!accountId || !categoryId) {
      stats.dropped.recurring++;
      continue;
    }
    recurringOut.push({
      id: ctx.newId(),
      ledgerId,
      categoryId,
      accountId,
      type,
      amount: r.amount,
      noteCipher: r.noteCipher ?? null,
      noteDekVer: r.noteDekVer ?? null,
      cycleType: r.cycleType,
      cycleDay: r.cycleDay,
      nextDate: r.nextDate,
      isActive: r.isActive ?? true,
      isAuto: r.isAuto ?? false,
      confidence: r.confidence ?? null,
      createdAt: at(r.createdAt),
      updatedAt: at(r.updatedAt),
    });
  }

  return {
    categories: categoriesOut,
    accounts: accountsOut,
    budgets: budgetsOut,
    bills: billsOut,
    goals: goalsOut,
    loans: loansOut,
    recurring: recurringOut,
    idMaps: { categories: catMap, accounts: accMap },
    stats,
  };
}
