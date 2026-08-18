require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const p = new PrismaClient();

async function main() {
  // 所有账本：名字像余额/校准/调整 的分类
  const cats = await p.category.findMany({
    where: {
      OR: [
        { name: { contains: '余额' } },
        { name: { contains: '校准' } },
        { name: { contains: '调整' } },
      ],
    },
  });
  console.log('--- balance-like categories ---');
  for (const c of cats) {
    const dirty = await p.bill.count({
      where: { categoryId: c.id, isTransfer: false },
    });
    const ok = await p.bill.count({
      where: { categoryId: c.id, isTransfer: true },
    });
    console.log(
      `${c.type}\t${c.name}\tledger=${c.ledgerId ?? 'SYS'}\tdirty=${dirty}\tok=${ok}`,
    );
  }

  // 自建：转账 / 借贷 是否在脏记收支
  const special = await p.category.findMany({
    where: {
      isSystem: false,
      name: { in: ['转账', '借贷', '余额调整', '调整余额'] },
    },
  });
  console.log('--- special custom ---');
  for (const c of special) {
    const dirty = await p.bill.count({
      where: { categoryId: c.id, isTransfer: false },
    });
    const ok = await p.bill.count({
      where: { categoryId: c.id, isTransfer: true },
    });
    console.log(
      `${c.type}\t${c.name}\t${c.id}\tdirty=${dirty}\tok=${ok}`,
    );
  }

  // source=reconcile 概况
  const rec = await p.bill.groupBy({
    by: ['isTransfer'],
    where: { source: 'reconcile' },
    _count: true,
  });
  console.log('--- source=reconcile ---', rec);

  // 名字含余额的分类下，按 type 分布
  const balIds = cats.map((c) => c.id);
  if (balIds.length) {
    const byType = await p.bill.groupBy({
      by: ['type', 'isTransfer'],
      where: { categoryId: { in: balIds } },
      _count: true,
      _sum: { amount: true },
    });
    console.log('--- bills on balance cats ---', JSON.stringify(byType, null, 2));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
