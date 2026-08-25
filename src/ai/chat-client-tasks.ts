import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** 需客户端解密/解析后完成的查询任务（E2E 通路 B） */
export type ClientTask =
  | { task: 'merchant'; billIds: string[]; period: string }
  | {
      task: 'note_search';
      keyword: string;
      billIds: string[];
      period: string;
      dateFrom: string;
      dateTo: string;
    }
  | {
      task: 'account_query';
      accountName: string;
      period: string;
      dateFrom: string;
      dateTo: string;
      billType?: 'expense' | 'income';
    }
  | { task: 'goal_progress'; goalName: string }
  | {
      task: 'transfer_list';
      period: string;
      dateFrom: string;
      dateTo: string;
      pairs: {
        amount: number;
        date: string;
        fromAccountId: string;
        toAccountId: string;
      }[];
    };

export interface PeriodBillIds {
  billIds: string[];
  periodLabel: string;
  dateFrom: string;
  dateTo: string;
}

/** 将 queryStats 的 period 参数转为中文展示标签 */
export function formatPeriodLabel(
  tag: string | undefined,
  start?: Date,
  end?: Date,
): string {
  const t = (tag || 'thisMonth').trim();
  switch (t) {
    case 'today':
      return '今天';
    case 'thisWeek':
      return '本周';
    case 'lastWeek':
      return '上周';
    case 'thisMonth':
      return '本月';
    case 'lastMonth':
      return '上月';
    case 'last30d':
      return '近30天';
    case 'thisYear':
      return '今年';
    case 'lastYear':
      return '去年';
    case 'lastYearSameMonth':
      return '去年同期';
  }
  const m = t.match(/^(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})$/);
  if (m) return `${m[1]} ~ ${m[2]}`;
  if (start && end) {
    return `${start.toISOString().slice(0, 10)} ~ ${end.toISOString().slice(0, 10)}`;
  }
  return t;
}

/** 收支公共 where：转账腿与股票纸面盈亏都不算收支 */
const flowWhere = (
  ledgerId: string,
  start: Date,
  end: Date,
  type?: 'expense' | 'income',
) => {
  const where: Prisma.BillWhereInput = {
    ledgerId,
    isTransfer: false,
    source: { not: 'stock' },
    date: { gte: start, lte: end },
  };
  if (type) where.type = type;
  return where;
};

/**
 * 拉取时间段内账单 id（供客户端解密备注 / 按账户二次筛选）。
 * 上限 300 条，按日期倒序。
 */
export async function fetchBillIdsInPeriod(
  prisma: PrismaService,
  ledgerId: string,
  start: Date,
  end: Date,
  periodLabel: string,
  type?: 'expense' | 'income',
  limit = 300,
): Promise<PeriodBillIds> {
  const bills = await prisma.bill.findMany({
    where: flowWhere(ledgerId, start, end, type),
    select: { id: true },
    orderBy: { date: 'desc' },
    take: limit,
  });
  return {
    billIds: bills.map((b) => b.id),
    periodLabel,
    dateFrom: start.toISOString().slice(0, 10),
    dateTo: end.toISOString().slice(0, 10),
  };
}
