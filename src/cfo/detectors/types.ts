export type Severity = 'info' | 'warning' | 'critical';

export interface ProposalDraft {
  type: string;
  severity: Severity;
  title: string;
  body: string;
  actionKind: string | null;
  actionParams: Record<string, unknown> | null;
  requiresClient: boolean;
  evidenceRefs: Record<string, unknown> | null;
  dedupeKey: string;
}

// —— 进入 detector 的明文数据(均已 Number 化,绝不含加密 note/name)——
export interface DetectorBill {
  id: string;
  accountId: string;
  categoryId: string;
  categoryName: string;   // 明文系统/账本分类名
  type: 'expense' | 'income';
  amount: number;
  date: Date;
  externalId: string | null;
  isTransfer: boolean;
}
export interface DetectorAccount {
  id: string;
  accountType: string;    // CASH|BANK|VIRTUAL|CREDIT|...
  balance: number;
}
export interface DetectorBudget {
  id: string;
  categoryId: string | null;
  categoryName: string;
  period: string;         // MONTHLY|YEARLY
  limit: number;
  spent: number;
}
export interface DetectorGoal {
  id: string;
  accountId: string | null;
  target: number;
  saved: number;          // 已存(服务端按绑定/未绑定算好)
}
export interface DetectorInput {
  periodKey: string;      // 'YYYY-MM'
  now: Date;
  bills: DetectorBill[];          // 当期账单
  recentBills: DetectorBill[];    // 近 ~90 天账单(异常/重复用)
  accounts: DetectorAccount[];
  budgets: DetectorBudget[];
  goals: DetectorGoal[];
  recentExpenseByAccount: Record<string, number>; // accountId -> 近月支出合计(闲钱判定)
  lastOutflowDays: Record<string, number>;        // accountId -> 距上次支出流出的天数
}
