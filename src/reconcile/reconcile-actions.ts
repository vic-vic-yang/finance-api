/**
 * 对账闭环 · 把对账报告的四类发现映射成 CFO 可审批的修复提案（纯函数）
 *
 * 安全设计（沿用 CFO 隐私不变式）：
 *  - 只读取序列化后的明文计数 / id / 金额，绝不触碰 noteCipher / nameCipher；
 *  - 删除类动作复用 cfo 已有的 delete_bill（会同步回退余额）；
 *  - 余额校准 reconcile_balance 为新增服务端动作，但不在自动执行白名单内，
 *    只能人工 approve；
 *  - 周期补记 create_missing_recurring 需要客户端用 DEK 加密备注，标记 requiresClient。
 */

export interface ReconcileDraft {
  type: string;
  severity: string;
  title: string;
  body: string;
  actionKind: string;
  actionParams: Record<string, unknown>;
  requiresClient: boolean;
  dedupeKey: string;
}

interface SectionLike {
  key: string;
  items: any[];
}

const fmt = (n: unknown) => Number(n ?? 0).toFixed(2);

export function buildReconcileDrafts(sections: SectionLike[]): ReconcileDraft[] {
  const drafts: ReconcileDraft[] = [];

  for (const s of sections) {
    if (s.key === 'balanceDrift') {
      for (const it of s.items) {
        // info 级 / 含股票因素 → 大概率是纸面盈亏结算差，不生成修复建议
        if (it.severity === 'info' || it.hasStock) continue;
        const expected = Number(it.expected);
        drafts.push({
          type: 'reconcile_balance',
          severity: it.severity,
          title: '校准账户余额',
          body:
            '该账户余额与流水推算偏差 ¥' + fmt(Math.abs(Number(it.drift))) +
            '，建议校准为 ¥' + fmt(expected) + '。',
          actionKind: 'reconcile_balance',
          actionParams: { accountId: it.accountId, balance: expected },
          requiresClient: false,
          dedupeKey: 'reconcile:balance:' + it.accountId,
        });
      }
    } else if (s.key === 'suspectedDuplicates') {
      for (const it of s.items) {
        const later = it.bills?.[1];
        if (!later?.id) continue;
        drafts.push({
          type: 'reconcile_duplicate',
          severity: it.severity,
          title: '删除疑似重复账单',
          body:
            '两笔 ¥' + fmt(it.amount) + ' 的' +
            (it.type === 'income' ? '收入' : '支出') +
            '疑似重复，建议删除较晚一笔。',
          actionKind: 'delete_bill',
          actionParams: { billId: later.id },
          requiresClient: false,
          dedupeKey: 'reconcile:dup:' + later.id,
        });
      }
    } else if (s.key === 'recurringMissing') {
      for (const it of s.items) {
        drafts.push({
          type: 'reconcile_missing',
          severity: it.severity,
          title: '补记周期账单',
          body: '周期账单已到期但本月无匹配账单，建议补记一笔 ¥' + fmt(it.amount) + '。',
          actionKind: 'create_missing_recurring',
          actionParams: { recurringId: it.recurringId, dueDate: it.dueDate },
          requiresClient: true, // 备注是密文，需客户端用 DEK 加密后入账
          dedupeKey: 'reconcile:missing:' + it.recurringId + ':' + String(it.dueDate).slice(0, 10),
        });
      }
    } else if (s.key === 'transferOrphans') {
      for (const it of s.items) {
        drafts.push({
          type: 'reconcile_orphan',
          severity: it.severity,
          title: '删除转账缺腿',
          body: '这笔 ¥' + fmt(it.amount) + ' 的转账缺少配对腿，建议删除并回退余额。',
          actionKind: 'delete_bill',
          actionParams: { billId: it.billId },
          requiresClient: false,
          dedupeKey: 'reconcile:orphan:' + it.billId,
        });
      }
    }
  }
  return drafts;
}
