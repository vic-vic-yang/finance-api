// Run after pnpm build. SELECT-only fixtures; never reads or modifies user bills.
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { buildGroupQuery } = require('../dist/bills/bill-groups');
const db = new PrismaClient();
const fixture = `WITH "Bill" AS (SELECT * FROM (VALUES
 ('fixture', '2026-08-31 16:00:00'::timestamp, 'income'::"BillType", 12000::numeric, false, 'manual'),
 ('fixture', '2026-09-01 12:00:00'::timestamp, 'expense'::"BillType", 35.50::numeric, false, 'manual'),
 ('fixture', '2026-09-01 12:00:00'::timestamp, 'expense'::"BillType", 800::numeric, true, 'manual'),
 ('fixture', '2026-09-01 12:00:00'::timestamp, 'income'::"BillType", 200::numeric, false, 'stock'),
 ('other', '2026-09-01 12:00:00'::timestamp, 'income'::"BillType", 999::numeric, false, 'manual'),
 ('fixture', '2026-08-31 15:59:59'::timestamp, 'expense'::"BillType", 10::numeric, false, 'manual')
) AS t("ledgerId","date","type","amount","isTransfer","source")), filtered`;

(async () => {
  try {
    for (const type of [undefined, 'income', 'expense']) {
      const query = buildGroupQuery({ledgerId: 'fixture', ...(type ? {type} : {}),
        date: {gte: new Date('2026-08-31T16:00:00Z'), lt: new Date('2026-09-30T16:00:00Z')},
      }, 'month', 480, 12);
      const rows = await db.$queryRawUnsafe(query.text.replace('WITH filtered', fixture), ...query.values);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].key, '2026-09-01');
      assert.equal(Number(rows[0].income), type === 'expense' ? 0 : 12000);
      assert.equal(Number(rows[0].expense), type === 'income' ? 0 : 35.5);
    }
    const page = buildGroupQuery({ledgerId: 'fixture'}, 'month', 480, 1);
    const rows = await db.$queryRawUnsafe(page.text.replace('WITH filtered', fixture), ...page.values);
    assert.equal(rows.length, 2); // requested group plus continuation sentinel
    assert.equal(rows[0].key, '2026-09-01');
    const next = buildGroupQuery({ledgerId: 'fixture'}, 'month', 480, 1, rows[0].key);
    const older = await db.$queryRawUnsafe(next.text.replace('WITH filtered', fixture), ...next.values);
    assert.equal(older.length, 1);
    assert.equal(older[0].key, '2026-08-01');
    console.log('PostgreSQL fixtures passed: type filters, timezone boundaries, full sums, transfer/stock exclusion, ledger isolation, group cursor.');
  } finally {
    await db.$disconnect();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
