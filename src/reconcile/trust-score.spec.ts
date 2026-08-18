import { scoreDataTrust, trustGrade } from './trust-score';

describe('scoreDataTrust', () => {
  const clean = {
    totalAccounts: 2,
    coveredAccounts: 2,
    balanceDriftCount: 0,
    duplicateCount: 0,
    missingRecurringCount: 0,
    orphanTransferCount: 0,
  };

  it('全绿 → 满分 S', () => {
    const r = scoreDataTrust(clean);
    expect(r.score).toBe(100);
    expect(r.grade).toBe('S');
  });

  it('无账户 → 覆盖率维度给中性分', () => {
    const r = scoreDataTrust({ ...clean, totalAccounts: 0, coveredAccounts: 0 });
    expect(r.dimensions.find((d) => d.key === 'accountCoverage')!.score).toBe(60);
  });

  it('覆盖率 50% → 该维度 50 分', () => {
    const r = scoreDataTrust({ ...clean, totalAccounts: 4, coveredAccounts: 2 });
    expect(r.dimensions.find((d) => d.key === 'accountCoverage')!.score).toBe(50);
  });

  it('漂移 + 缺记会拉低总分', () => {
    const bad = scoreDataTrust({
      ...clean,
      totalAccounts: 4,
      coveredAccounts: 4,
      balanceDriftCount: 1,
      missingRecurringCount: 2,
    });
    const good = scoreDataTrust({ ...clean, totalAccounts: 4, coveredAccounts: 4 });
    expect(bad.score).toBeLessThan(good.score);
  });

  it('去重维度：5 条重复 → 50 分', () => {
    const r = scoreDataTrust({ ...clean, duplicateCount: 5 });
    expect(r.dimensions.find((d) => d.key === 'dedupCleanliness')!.score).toBe(50);
  });

  it('grade 分档', () => {
    expect(trustGrade(95)).toBe('S');
    expect(trustGrade(85)).toBe('A');
    expect(trustGrade(75)).toBe('B');
    expect(trustGrade(65)).toBe('C');
    expect(trustGrade(50)).toBe('D');
  });
});
