import {
  L1_RENAMES,
  SYSTEM_CATEGORIES,
  SYSTEM_SUBCATEGORIES,
  buildCanonicalKeys,
  catKey,
  resolveLegacyTarget,
} from './system-categories';

describe('system-categories seeds', () => {
  it('支出一级恰好 12 个、收入 6 个', () => {
    const income = SYSTEM_CATEGORIES.filter((c) => c.type === 'income');
    const expense = SYSTEM_CATEGORIES.filter((c) => c.type === 'expense');
    expect(income).toHaveLength(6);
    expect(expense).toHaveLength(12);
  });

  it('每个二级父级都在一级列表里', () => {
    const parents = new Set(SYSTEM_CATEGORIES.map((c) => c.name));
    for (const p of Object.keys(SYSTEM_SUBCATEGORIES)) {
      expect(parents.has(p)).toBe(true);
    }
  });

  it('住房含物业费/房贷/水费等常用项', () => {
    const names = SYSTEM_SUBCATEGORIES['住房'].map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['房租', '房贷', '水费', '电费', '燃气费', '物业费']),
    );
  });

  it('交通含用车相关，无独立用车一级', () => {
    expect(SYSTEM_CATEGORIES.some((c) => c.name === '用车')).toBe(false);
    const names = SYSTEM_SUBCATEGORIES['交通'].map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['加油充电', '停车费', '车贷', '保养维修']),
    );
  });
});

describe('resolveLegacyTarget', () => {
  const canonical = buildCanonicalKeys();

  it('已在新树中的分类保持不变', () => {
    expect(resolveLegacyTarget('expense', null, '餐饮', canonical)).toBe(
      'expense||餐饮',
    );
    expect(resolveLegacyTarget('expense', '住房', '物业费', canonical)).toBe(
      'expense|住房|物业费',
    );
  });

  it('一级改名后旧名解析到新名', () => {
    expect(L1_RENAMES['工资']).toBe('工资薪金');
    expect(resolveLegacyTarget('income', null, '工资', canonical)).toBe(
      'income||工资薪金',
    );
  });

  it('早餐/午餐/晚餐 → 堂食', () => {
    expect(resolveLegacyTarget('expense', '餐饮', '早餐', canonical)).toBe(
      'expense|餐饮|堂食',
    );
    expect(resolveLegacyTarget('expense', '餐饮', '午餐', canonical)).toBe(
      'expense|餐饮|堂食',
    );
  });

  it('汽车一级及子项迁到交通/金融', () => {
    expect(resolveLegacyTarget('expense', null, '汽车', canonical)).toBe(
      'expense||交通',
    );
    expect(resolveLegacyTarget('expense', '汽车', '车贷', canonical)).toBe(
      'expense|交通|车贷',
    );
    expect(resolveLegacyTarget('expense', '汽车', '保险', canonical)).toBe(
      'expense|金融保险|车险',
    );
  });

  it('奖金一级并入工资薪金', () => {
    expect(resolveLegacyTarget('income', null, '奖金', canonical)).toBe(
      'income||工资薪金',
    );
    expect(resolveLegacyTarget('income', '奖金', '年终奖', canonical)).toBe(
      'income|工资薪金|年终奖',
    );
  });

  it('宠物一级收到家庭·宠物', () => {
    expect(resolveLegacyTarget('expense', null, '宠物', canonical)).toBe(
      'expense|家庭|宠物',
    );
  });

  it('未知系统分类回落到其他', () => {
    expect(resolveLegacyTarget('expense', null, '奇怪分类', canonical)).toBe(
      'expense||其他支出',
    );
    expect(resolveLegacyTarget('income', '未知父', '奇怪', canonical)).toBe(
      'income||其他收入',
    );
  });

  it('canonical keys 与 catKey 一致', () => {
    expect(canonical.has(catKey('income', null, '工资薪金'))).toBe(true);
    expect(canonical.has(catKey('expense', '金融保险', '车险'))).toBe(true);
    expect(canonical.has(catKey('expense', null, '汽车'))).toBe(false);
  });
});
