require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const cats = await p.category.findMany({
    where: {
      isSystem: false,
      OR: [
        { name: { in: ['转账', '转出', '转入', '借贷', '余额调整', '调整余额'] } },
        { name: { contains: '转' } },
        { name: { contains: '借贷' } },
        { name: { contains: '余额' } },
      ],
    },
    orderBy: { name: 'asc' },
  });

  for (const c of cats) {
    const bills = await p.bill.count({ where: { categoryId: c.id } });
    const children = await p.category.count({ where: { parentId: c.id } });
    const budgets = await p.budget.count({ where: { categoryId: c.id } });
    const recurring = await p.recurringBill.count({ where: { categoryId: c.id } });
    console.log(
      `${c.type}\t${c.name}\tid=${c.id}\tparent=${c.parentId ?? '-'}\tbills=${bills}\tchildren=${children}\tbudgets=${budgets}\trecurring=${recurring}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
