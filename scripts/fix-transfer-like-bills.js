/**
 * 一次性数据修复：把误记成普通收支的「转账/余额调整」类账单
 * 标成 isTransfer=true（不改金额、账户、余额；只改统计口径）。
 *
 * 用法：node scripts/fix-transfer-like-bills.js [--dry]
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const dry = process.argv.includes('--dry');
const p = new PrismaClient();

async function main() {
  const cats = await p.category.findMany({
    where: {
      isSystem: false,
      OR: [
        { name: { in: ['转账', '余额调整', '调整余额', '余额校准'] } },
        { name: { contains: '余额' } },
      ],
    },
  });

  const ids = cats.map((c) => c.id);
  if (!ids.length) {
    console.log('没有匹配的自建分类');
    return;
  }

  const dirty = await p.bill.findMany({
    where: { categoryId: { in: ids }, isTransfer: false },
    select: {
      id: true,
      type: true,
      amount: true,
      date: true,
      categoryId: true,
      source: true,
    },
  });

  const byCat = new Map(cats.map((c) => [c.id, c]));
  console.log(`待修复 ${dirty.length} 笔（dry=${dry}）`);
  for (const b of dirty) {
    const c = byCat.get(b.categoryId);
    console.log(
      `  ${b.date.toISOString().slice(0, 10)} ${b.type} ${b.amount} 「${c?.name}」 source=${b.source}`,
    );
  }

  if (dry || dirty.length === 0) return;

  const res = await p.bill.updateMany({
    where: { id: { in: dirty.map((b) => b.id) } },
    data: { isTransfer: true },
  });
  console.log(`已更新 isTransfer=true：${res.count} 笔`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
