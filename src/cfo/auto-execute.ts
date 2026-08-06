/// ======================================================================
/// 主动式 CFO · 自动执行门控（白名单制）
/// ======================================================================
///
/// 只有低风险、可逆的服务端动作允许自动执行；高危动作（delete_bill 等）
/// 永远需要用户手动确认。门控是纯函数，便于单测与审计。

/// 允许自动执行的动作白名单。delete_bill 等高危动作不在其中。
export const AUTO_EXECUTABLE_ACTIONS = [
  'adjust_budget',
  'recategorize_bill',
] as const;

export type AutoExecutableAction = (typeof AUTO_EXECUTABLE_ACTIONS)[number];

/// 每账本每天自动执行次数上限（防止规则失控批量改动）
export const AUTO_EXECUTE_DAILY_LIMIT = 5;

/// 门控只读取 Proposal 的明文结构字段，绝不触碰任何加密内容。
export interface AutoExecuteCandidate {
  status?: string;
  actionKind?: string | null;
  requiresClient?: boolean;
  severity?: string;
}

/** 动作类型是否在自动执行白名单内 */
export function isAutoExecutableAction(actionType: string): boolean {
  return (AUTO_EXECUTABLE_ACTIONS as readonly string[]).includes(actionType);
}

/** 某条提议是否允许被 [actionType] 规则自动执行：
 *  1. 动作类型在白名单内（delete_bill 等高危动作直接拒绝）；
 *  2. 提议仍处于 pending（未被人工决定过）；
 *  3. 提议的动作与规则动作一致；
 *  4. 不需要客户端参与（requiresClient 的无法由服务端闭环）；
 *  5. 非 critical 级（高危提议永远需要用户确认）。
 */
export function canAutoExecute(
  actionType: string,
  proposal: AutoExecuteCandidate | null | undefined,
): boolean {
  if (!isAutoExecutableAction(actionType)) return false;
  if (!proposal) return false;
  if (proposal.status !== 'pending') return false;
  if (proposal.actionKind !== actionType) return false;
  if (proposal.requiresClient) return false;
  if (proposal.severity === 'critical') return false;
  return true;
}
