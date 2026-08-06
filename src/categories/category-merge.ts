/** 合并分类前置校验（纯函数，供 service 与单测共用） */

export interface MergeCatRow {
  id: string;
  isSystem: boolean;
  ledgerId: string | null;
  type: string;
  parentId: string | null;
  name: string;
}

export interface MergeGuardInput {
  sourceId: string;
  targetId: string;
  source: MergeCatRow | null;
  target: MergeCatRow | null;
  /** 源为一级时，其下二级数量 */
  sourceChildCount: number;
  /** 目标是否是源的子分类（禁止把父并进自己的子） */
  targetIsDescendantOfSource: boolean;
  /** 当前操作账本 */
  ledgerId?: string;
}

/** 返回错误文案；null 表示可通过 */
export function resolveMergeGuard(input: MergeGuardInput): string | null {
  const {
    sourceId,
    targetId,
    source,
    target,
    sourceChildCount,
    ledgerId: opLedgerId,
  } = input;

  if (sourceId === targetId) return '不能合并到自己';
  if (!source) return '源分类不存在';
  if (!target) return '目标分类不存在';
  if (source.isSystem) return '系统分类不可合并，请选自建分类';

  // 自建源必须属于当前账本
  if (opLedgerId && source.ledgerId !== opLedgerId) {
    return '无权操作该分类';
  }
  // 目标：系统全局可用；自建必须属于本账本
  if (!target.isSystem) {
    if (!opLedgerId || target.ledgerId !== opLedgerId) {
      return '无权合并到该分类';
    }
  }
  if (source.type !== target.type) return '收支类型不一致，无法合并';
  if (sourceChildCount > 0) {
    return '该分类下还有二级分类，请先合并或删除二级后再合并一级';
  }
  if (input.targetIsDescendantOfSource) {
    return '不能合并到自己的子分类';
  }
  return null;
}
