import { remapBackup, RemapContext, BackupPayload } from './backup-remap';

/** 确定性 id 生成器：id-1, id-2, ... */
const makeCtx = (over: Partial<RemapContext> = {}): RemapContext => {
  let n = 0;
  return {
    userId: 'user-me',
    ledgerId: 'ledger-new',
    newId: () => `id-${++n}`,
    now: '2026-01-01T00:00:00.000Z',
    systemCategories: [
      { id: 'sys-food', name: '餐饮', type: 'expense', parentName: null },
      { id: 'sys-food-breakfast', name: '早餐', type: 'expense', parentName: '餐饮' },
      { id: 'sys-salary', name: '工资', type: 'income', parentName: null },
    ],
    ...over,
  };
};

describe('remapBackup · 分类', () => {
  it('系统分类按 (type,parentName,name) 复用现有 id，不重建', () => {
    const out = remapBackup(
      {
        categories: [
          { id: 'old-food', name: '餐饮', type: 'expense', isSystem: true },
          { id: 'old-bf', name: '早餐', type: 'expense', isSystem: true, parentId: 'old-food', parentName: '餐饮' },
        ],
      },
      makeCtx(),
    );
    expect(out.categories).toHaveLength(0); // 全部复用，无需新建
    expect(out.stats.systemCategoriesMatched).toBe(2);
    expect(out.idMaps.categories.get('old-food')).toBe('sys-food');
    expect(out.idMaps.categories.get('old-bf')).toBe('sys-food-breakfast');
  });

  it('目标库没有同名系统分类 → 降级为自定义分类重建（isSystem=false）', () => {
    const out = remapBackup(
      {
        categories: [
          { id: 'old-x', name: '火星开销', type: 'expense', isSystem: true },
        ],
      },
      makeCtx(),
    );
    expect(out.categories).toHaveLength(1);
    expect(out.categories[0]).toMatchObject({
      name: '火星开销',
      isSystem: false,
      parentId: null,
      ledgerId: 'ledger-new',
      userId: 'user-me',
    });
    expect(out.stats.systemCategoriesMatched).toBe(0);
    expect(out.stats.customCategoriesCreated).toBe(1);
  });

  it('自定义两级分类：父先建，子的 parentId 指向父的新 id（与输入顺序无关）', () => {
    const out = remapBackup(
      {
        categories: [
          // 子故意排在父前面
          { id: 'old-child', name: '奶茶', type: 'expense', parentId: 'old-parent' },
          { id: 'old-parent', name: '饮品', type: 'expense' },
        ],
      },
      makeCtx(),
    );
    expect(out.categories).toHaveLength(2);
    const parentNew = out.idMaps.categories.get('old-parent')!;
    const childNew = out.idMaps.categories.get('old-child')!;
    expect(parentNew).toBeTruthy();
    expect(childNew).toBeTruthy();
    const childRow = out.categories.find((c) => c.id === childNew)!;
    expect(childRow.parentId).toBe(parentNew);
    // 输出行顺序：父在子前（满足 createMany 前的 FK 顺序无要求，但语义清晰）
    const parentIdx = out.categories.findIndex((c) => c.id === parentNew);
    const childIdx = out.categories.findIndex((c) => c.id === childNew);
    expect(parentIdx).toBeLessThan(childIdx);
  });

  it('父分类不在数据包里（悬空）→ 升为一级并计数', () => {
    const out = remapBackup(
      {
        categories: [
          { id: 'old-orphan', name: '孤儿分类', type: 'expense', parentId: 'not-exist' },
        ],
      },
      makeCtx(),
    );
    expect(out.categories[0].parentId).toBeNull();
    expect(out.stats.nulled.categoryParents).toBe(1);
  });

  it('parentId 成环的病态数据 → 不死循环，全部升为一级', () => {
    const out = remapBackup(
      {
        categories: [
          { id: 'a', name: 'A', type: 'expense', parentId: 'b' },
          { id: 'b', name: 'B', type: 'expense', parentId: 'a' },
        ],
      },
      makeCtx(),
    );
    expect(out.categories).toHaveLength(2);
    expect(out.categories.every((c) => c.parentId === null)).toBe(true);
    expect(out.stats.nulled.categoryParents).toBe(2);
  });

  it('非法 type 的分类行 → 跳过并计入 invalidRows', () => {
    const out = remapBackup(
      {
        categories: [
          { id: 'bad', name: '坏行', type: 'hacked' } as never,
          { id: 'good', name: '正常', type: 'income' },
        ],
      },
      makeCtx(),
    );
    expect(out.categories).toHaveLength(1);
    expect(out.stats.invalidRows).toBe(1);
  });
});

describe('remapBackup · 账户', () => {
  const baseAccount = {
    id: 'acc-1',
    nameCipher: 'Y2lwaGVy', // base64 密文原样
    type: 'BANK',
    balance: '1234.56',
    initialBalance: '100.00',
  };

  it('ownerId=恢复者本人 → 保留私人账户；ownerId=他人 → 置 null 并计数', () => {
    const out = remapBackup(
      {
        accounts: [
          { ...baseAccount, id: 'mine', ownerId: 'user-me' },
          { ...baseAccount, id: 'theirs', ownerId: 'user-other' },
          { ...baseAccount, id: 'shared', ownerId: null },
        ],
      },
      makeCtx(),
    );
    expect(out.accounts).toHaveLength(3);
    const mine = out.accounts.find((a) => a.id === out.idMaps.accounts.get('mine'))!;
    const theirs = out.accounts.find((a) => a.id === out.idMaps.accounts.get('theirs'))!;
    const shared = out.accounts.find((a) => a.id === out.idMaps.accounts.get('shared'))!;
    expect(mine.ownerId).toBe('user-me');
    expect(theirs.ownerId).toBeNull();
    expect(shared.ownerId).toBeNull();
    expect(out.stats.nulled.privateAccounts).toBe(1);
  });

  it('autoDepositCategoryId 重映射；悬空 → 置 null 并计数', () => {
    const out = remapBackup(
      {
        categories: [{ id: 'cat-1', name: '工资', type: 'income', isSystem: true }],
        accounts: [
          { ...baseAccount, id: 'a1', autoDepositCategoryId: 'cat-1' },
          { ...baseAccount, id: 'a2', autoDepositCategoryId: 'ghost' },
        ],
      },
      makeCtx(),
    );
    const a1 = out.accounts.find((a) => a.id === out.idMaps.accounts.get('a1'))!;
    const a2 = out.accounts.find((a) => a.id === out.idMaps.accounts.get('a2'))!;
    expect(a1.autoDepositCategoryId).toBe('sys-salary'); // 系统分类被复用
    expect(a2.autoDepositCategoryId).toBeNull();
    expect(out.stats.nulled.autoDepositCategories).toBe(1);
  });

  it('密文与金额字段原样透传（不解密、不转浮点）', () => {
    const out = remapBackup({ accounts: [baseAccount] }, makeCtx());
    expect(out.accounts[0].nameCipher).toBe('Y2lwaGVy');
    expect(out.accounts[0].balance).toBe('1234.56');
    expect(out.accounts[0].initialBalance).toBe('100.00');
    expect(out.accounts[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('remapBackup · 账单 / 预算 / 周期', () => {
  const payload: BackupPayload = {
    categories: [
      { id: 'c1', name: '餐饮', type: 'expense', isSystem: true },
      { id: 'c2', name: '自定义', type: 'expense' },
    ],
    accounts: [{ id: 'a1', nameCipher: 'eA==', type: 'CASH', balance: 0 }],
    bills: [
      { id: 'b1', accountId: 'a1', categoryId: 'c1', type: 'expense', amount: '35.00', noteCipher: 'bg==', date: '2025-12-01T12:00:00.000Z' },
      { id: 'b2', accountId: 'a1', categoryId: 'c2', type: 'income', amount: 88.5, noteCipher: 'bg==', date: '2025-12-02T12:00:00.000Z', isTransfer: true, source: 'manual' },
      { id: 'b3', accountId: 'ghost-acc', categoryId: 'c1', type: 'expense', amount: 1, noteCipher: 'bg==', date: '2025-12-03T12:00:00.000Z' }, // 悬空账户
      { id: 'b4', accountId: 'a1', categoryId: 'ghost-cat', type: 'expense', amount: 1, noteCipher: 'bg==', date: '2025-12-03T12:00:00.000Z' }, // 悬空分类
    ],
    budgets: [
      { id: 'bg1', categoryId: 'c2', amount: 500, period: 'MONTHLY', startDate: '2025-12-01' },
      { id: 'bg2', categoryId: null, amount: 2000, period: 'YEARLY', startDate: '2025-01-01' },
      { id: 'bg3', categoryId: 'ghost-cat', amount: 100, period: 'MONTHLY', startDate: '2025-12-01' }, // 悬空 → 丢弃
    ],
    recurring: [
      { id: 'r1', categoryId: 'c1', accountId: 'a1', amount: 15, cycleType: 'monthly', cycleDay: 1, nextDate: '2026-01-01T00:00:00.000Z' },
      { id: 'r2', categoryId: 'c1', accountId: 'ghost', amount: 15, cycleType: 'monthly', cycleDay: 1, nextDate: '2026-01-01T00:00:00.000Z' }, // 悬空 → 丢弃
    ],
  };

  it('账单外键全部改写为新 id；记账人归为恢复者；转账标记保留', () => {
    const out = remapBackup(payload, makeCtx());
    expect(out.bills).toHaveLength(2);
    const accNew = out.idMaps.accounts.get('a1')!;
    const catNew = out.idMaps.categories.get('c2')!;
    expect(out.bills[0].accountId).toBe(accNew);
    expect(out.bills[0].categoryId).toBe('sys-food'); // 系统分类复用
    expect(out.bills[0].userId).toBe('user-me');
    expect(out.bills[1].categoryId).toBe(catNew);
    expect(out.bills[1].isTransfer).toBe(true);
    expect(out.bills[0].amount).toBe('35.00'); // 金额字符串原样，不走浮点
  });

  it('悬空账户 / 分类的账单被丢弃并计数', () => {
    const out = remapBackup(payload, makeCtx());
    expect(out.stats.dropped.bills).toBe(2); // b3 + b4
  });

  it('预算：总预算（categoryId=null）保留；悬空分类预算丢弃', () => {
    const out = remapBackup(payload, makeCtx());
    expect(out.budgets).toHaveLength(2);
    expect(out.budgets.find((b) => b.categoryId === null)).toBeTruthy();
    expect(out.stats.dropped.budgets).toBe(1);
  });

  it('周期账单：悬空账户丢弃并计数', () => {
    const out = remapBackup(payload, makeCtx());
    expect(out.recurring).toHaveLength(1);
    expect(out.stats.dropped.recurring).toBe(1);
    expect(out.recurring[0].accountId).toBe(out.idMaps.accounts.get('a1'));
  });
});

describe('remapBackup · 目标 / 借贷', () => {
  it('目标 accountId 悬空 → 置 null 并计数（不退化为错账）', () => {
    const out = remapBackup(
      {
        accounts: [{ id: 'a1', nameCipher: 'eA==', type: 'CASH' }],
        goals: [
          { id: 'g1', nameCipher: 'Zw==', targetAmount: 10000, accountId: 'a1' },
          { id: 'g2', nameCipher: 'Zw==', targetAmount: 5000, accountId: 'ghost' },
          { id: 'g3', nameCipher: 'Zw==', targetAmount: 1000, accountId: null },
        ],
      },
      makeCtx(),
    );
    expect(out.goals).toHaveLength(3);
    expect(out.goals[0].accountId).toBe(out.idMaps.accounts.get('a1'));
    expect(out.goals[1].accountId).toBeNull();
    expect(out.goals[2].accountId).toBeNull();
    expect(out.stats.nulled.goalAccounts).toBe(1);
    // 目标归属恢复者
    expect(out.goals.every((g) => g.userId === 'user-me')).toBe(true);
  });

  it('借贷 accountId 悬空 → 置 null；非法 direction → invalid', () => {
    const out = remapBackup(
      {
        loans: [
          { id: 'l1', direction: 'lend', amount: 500, date: '2025-11-01T00:00:00.000Z', accountId: 'ghost', noteCipher: 'bA==' },
          { id: 'l2', direction: 'sideways', amount: 1, date: '2025-11-01T00:00:00.000Z' } as never,
        ],
      },
      makeCtx(),
    );
    expect(out.loans).toHaveLength(1);
    expect(out.loans[0].accountId).toBeNull();
    expect(out.loans[0].noteCipher).toBe('bA=='); // String 列密文原样
    expect(out.stats.nulled.loanAccounts).toBe(1);
    expect(out.stats.invalidRows).toBe(1);
  });
});
