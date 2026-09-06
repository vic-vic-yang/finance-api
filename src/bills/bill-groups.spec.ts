import { buildGroupQuery, groupRange } from './bill-groups';

describe('bill period groups', () => {
  it('uses a complete Monday-to-Sunday range across the year boundary', () => {
    expect(groupRange('2025-12-29', 'week', 480)).toEqual({
      startAt: '2025-12-28T16:00:00.000Z',
      endBefore: '2026-01-04T16:00:00.000Z',
    });
  });
  it('handles leap months and quarter/year rollover', () => {
    expect(groupRange('2024-02-01', 'month', 480).endBefore)
      .toBe('2024-02-29T16:00:00.000Z');
    expect(groupRange('2026-10-01', 'quarter', 480).endBefore)
      .toBe('2026-12-31T16:00:00.000Z');
    expect(groupRange('2026-01-01', 'year', 480).endBefore)
      .toBe('2026-12-31T16:00:00.000Z');
  });
  it('keeps ledger, filters and cursor parameterized and sums full groups before limiting', () => {
    const sql = buildGroupQuery({ledgerId: "ledger'", categoryId: {in: ['a', 'b']},
      amount: {gte: 10}, source: {not: 'stock'}, isTransfer: false},
      'month', 480, 12, '2026-09-01');
    expect(sql.text).not.toContain("ledger'");
    expect(sql.values).toContain("ledger'");
    expect(sql.text).toContain('SUM');
    expect(sql.text).toContain('HAVING');
    expect(sql.text.indexOf('GROUP BY')).toBeLessThan(sql.text.indexOf('LIMIT'));
    expect(sql.text).toContain('"isTransfer" = false');
    expect(sql.values).toContain(13); // one extra group to detect pagination
  });
  it('preserves inclusive date filter and exclusive detail bounds together', () => {
    const sql = buildGroupQuery({ledgerId: 'l', date: {gte: new Date('2026-01-01Z')},
      AND: [{date: {lt: new Date('2026-02-01Z')}}]}, 'month', 0, 12);
    expect(sql.text).toContain('>=');
    expect(sql.text).toContain('<');
    expect(sql.values).toEqual(expect.arrayContaining(['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']));
    expect(sql.text.match(/::timestamp/g)).toHaveLength(2);
  });
});
