/**
 * 财务事件时间线 · 纯函数：把多种事件按时间倒序合并、截断。
 * 时间相同按 id 稳定排序，保证输出确定。
 */
export interface TimelineEvent {
  kind: string;
  at: Date;
  id: string;
  data: Record<string, unknown>;
}

export function mergeTimeline(events: TimelineEvent[], limit = 50): TimelineEvent[] {
  return events
    .slice()
    .sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}
