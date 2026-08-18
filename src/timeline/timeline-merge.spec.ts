import { mergeTimeline, TimelineEvent } from './timeline-merge';

const ev = (id: string, at: string, kind = 'bill'): TimelineEvent => ({
  kind,
  at: new Date(at),
  id,
  data: {},
});

describe('mergeTimeline', () => {
  it('按时间倒序', () => {
    const out = mergeTimeline([ev('a', '2025-06-01'), ev('b', '2025-06-03'), ev('c', '2025-06-02')]);
    expect(out.map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('截断到 limit', () => {
    const out = mergeTimeline([ev('a', '2025-06-01'), ev('b', '2025-06-02'), ev('c', '2025-06-03')], 2);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('c');
  });

  it('同时间按 id 稳定', () => {
    const out = mergeTimeline([ev('z', '2025-06-01'), ev('a', '2025-06-01')]);
    expect(out.map((e) => e.id)).toEqual(['a', 'z']);
  });
});
