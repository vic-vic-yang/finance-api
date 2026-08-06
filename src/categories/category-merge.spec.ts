import {
  resolveMergeGuard,
  MergeGuardInput,
} from './category-merge';

describe('resolveMergeGuard', () => {
  const base: MergeGuardInput = {
    sourceId: 's1',
    targetId: 't1',
    source: {
      id: 's1',
      isSystem: false,
      ledgerId: 'L',
      type: 'expense',
      parentId: null,
      name: '转账',
    },
    target: {
      id: 't1',
      isSystem: true,
      ledgerId: null,
      type: 'expense',
      parentId: null,
      name: '其他支出',
    },
    sourceChildCount: 0,
    targetIsDescendantOfSource: false,
  };

  it('允许自建 → 系统同类型', () => {
    expect(resolveMergeGuard(base)).toBeNull();
  });

  it('拒绝合并到自己', () => {
    expect(
      resolveMergeGuard({ ...base, targetId: 's1', target: { ...base.target!, id: 's1' } }),
    ).toMatch(/不能合并到自己/);
  });

  it('拒绝系统分类作为源', () => {
    expect(
      resolveMergeGuard({
        ...base,
        source: { ...base.source!, isSystem: true },
      }),
    ).toMatch(/系统分类不可合并/);
  });

  it('拒绝跨类型', () => {
    expect(
      resolveMergeGuard({
        ...base,
        target: { ...base.target!, type: 'income' },
      }),
    ).toMatch(/类型不一致/);
  });

  it('拒绝仍有二级的一级源', () => {
    expect(resolveMergeGuard({ ...base, sourceChildCount: 2 })).toMatch(
      /二级分类/,
    );
  });

  it('拒绝目标是源的子分类', () => {
    expect(
      resolveMergeGuard({ ...base, targetIsDescendantOfSource: true }),
    ).toMatch(/子分类/);
  });

  it('拒绝他账本自建目标', () => {
    expect(
      resolveMergeGuard({
        ...base,
        ledgerId: 'L',
        target: {
          ...base.target!,
          isSystem: false,
          ledgerId: 'OTHER',
        },
      }),
    ).toMatch(/无权/);
  });

  it('源不存在', () => {
    expect(resolveMergeGuard({ ...base, source: null })).toMatch(/不存在/);
  });

  it('带 ledgerId 时校验源自建归属', () => {
    expect(
      resolveMergeGuard({
        ...base,
        ledgerId: 'L',
        source: { ...base.source!, ledgerId: 'OTHER' },
      }),
    ).toMatch(/无权/);
  });
});
