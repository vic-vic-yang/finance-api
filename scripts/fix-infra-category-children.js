/**
 * 清理转账/借贷/余额调整下的自建二级：账单改挂到一级后删二级。
 * 收入侧「其他收入 › 转账」改挂到支出侧系统「转账」分类（与账户互转同款）。
 *
 * node scripts/fix-infra-category-children.js [--dry]
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const dry = process.argv.includes('--dry');
const p = new PrismaClient();

async function repointAndDelete(fromId, toId, label) {
  const bills = await p.bill.count({ where: { categoryId: fromId } });
  const budgets = await p.budget.count({ where: { categoryId: fromId } });
  const recurring = await p.recurringBill.count({ where: { categoryId: fromId } });
  console.log(`  ${label}: bills=${bills} budgets=${budgets} recurring=${recurring} → ${toId}`);
  if (dry) return;
  await p.$transaction([
    p.bill.updateMany({ where: { categoryId: fromId }, data: { categoryId: toId } }),
    p.budget.updateMany({ where: { categoryId: fromId }, data: { categoryId: toId } }),
    p.recurringBill.updateMany({ where: { categoryId: fromId }, data: { categoryId: toId } }),
    p.categoryCorrection.updateMany({ where: { categoryId: fromId }, data: { categoryId: toId } }),
    p.aiCorrection.updateMany({ where: { categoryId: fromId }, data: { categoryId: toId } }),
    p.account.updateMany({
      where: { autoDepositCategoryId: fromId },
      data: { autoDepositCategoryId: toId },
    }),
    p.categorySort.deleteMany({ where: { categoryId: fromId } }),
  ]);
  await p.category.delete({ where: { id: fromId } });
  console.log(`  已删除 ${fromId}`);
}

async function main() {
  const pairs = [
    // 转出 → 转账
    {
      fromId: 'cmqdy6d26003c3s605zs07my6',
      toId: 'cmq3ke96l001523xk9g041999',
      label: '转出 → 转账',
    },
    // 借钱 → 借贷
    {
      fromId: 'cmqdz0kv9006j3s60ybiqixt9',
      toId: 'cmq3nq2lr0002qff0ap2spcr3',
      label: '借钱 → 借贷',
    },
    // 调整余额 → 余额调整
    {
      fromId: 'cmqdz0l1y006l3s606t2u93u7',
      toId: 'cmq0zacn50002l4ofrrj8ikgf',
      label: '调整余额 → 余额调整',
    },
    // 余额调整 › 其他 → 余额调整
    {
      fromId: 'cmrqjtfhz000310a6hkjey0dp',
      toId: 'cmq0zacn50002l4ofrrj8ikgf',
      label: '余额调整/其他 → 余额调整',
    },
    // 其他收入 › 转账 → 转账（支出侧内部分类，展示用）
    {
      fromId: 'cmqgo8lan00dj2x3k9zl7xnc8',
      toId: 'cmq3ke96l001523xk9g041999',
      label: '其他收入/转账 → 转账',
    },
  ];

  console.log(`fix infra children (dry=${dry})`);
  for (const pair of pairs) {
    const from = await p.category.findUnique({ where: { id: pair.fromId } });
    if (!from) {
      console.log(`  skip ${pair.label}（源已不存在）`);
      continue;
    }
    await repointAndDelete(pair.fromId, pair.toId, pair.label);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
