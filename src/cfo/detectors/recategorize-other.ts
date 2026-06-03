import { DetectorInput, ProposalDraft } from './types';

const OTHER_NAMES = ['其他', '其它', '其他支出', '其他收入'];
const THRESHOLD = 3;

export function detectRecategorizeOther(input: DetectorInput): ProposalDraft[] {
  const others = input.bills.filter((b) => OTHER_NAMES.includes(b.categoryName));
  if (others.length < THRESHOLD) return [];
  const categoryIds = [...new Set(others.map((b) => b.categoryId))];
  return [{
    type: 'recategorize_other',
    severity: 'info',
    title: `有 ${others.length} 笔还落在「其他」`,
    body: `本期有 ${others.length} 笔账单没归好类,点开逐笔归类能让统计更准。`,
    actionKind: 'review_uncategorized',
    actionParams: { categoryIds, count: others.length },
    requiresClient: true,
    evidenceRefs: { billIds: others.map((b) => b.id) },
    dedupeKey: `recat:${input.periodKey}`,
  }];
}
