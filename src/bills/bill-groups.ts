import { Prisma } from '@prisma/client';

export type BillGrouping = 'day' | 'week' | 'month' | 'quarter' | 'year';

// Only accepts the small, explicit filter vocabulary built by BillsService.
// Identifiers/operators are allowlisted; all user values remain SQL parameters.
function whereSql(where: Prisma.BillWhereInput): Prisma.Sql {
  const fields = ['ledgerId', 'type', 'categoryId', 'accountId', 'userId',
    'source', 'isTransfer', 'date', 'amount'];
  const parts: Prisma.Sql[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND') {
      const children = Array.isArray(value) ? value : [value];
      parts.push(...children.map(v => Prisma.sql`(${whereSql(v as Prisma.BillWhereInput)})`));
      continue;
    }
    if (!fields.includes(key)) throw new Error(`Unsupported bill filter: ${key}`);
    const col = Prisma.raw(key === 'type' ? '"type"::text' : `"${key}"`);
    if (value != null && typeof value === 'object' && !(value instanceof Date) &&
        !(value instanceof Prisma.Decimal)) {
      for (const [op, operand] of Object.entries(value)) {
        if (op === 'in') {
          const values = operand as string[];
          parts.push(values.length ? Prisma.sql`${col} IN (${Prisma.join(values)})` : Prisma.sql`false`);
        } else {
          const operators = {not: '<>', gte: '>=', lte: '<=', lt: '<', gt: '>', equals: '='};
          if (!(op in operators)) throw new Error(`Unsupported bill operator: ${op}`);
          // Prisma binds raw JS Dates as timestamptz, while Bill.date is a UTC
          // timestamp without time zone. Cast ISO text explicitly to avoid
          // the PostgreSQL session timezone shifting filter boundaries.
          const bound = operand instanceof Date
            ? Prisma.sql`${operand.toISOString()}::timestamp`
            : Prisma.sql`${operand}`;
          parts.push(Prisma.sql`${col} ${Prisma.raw(operators[op])} ${bound}`);
        }
      }
    } else {
      parts.push(Prisma.sql`${col} = ${value}`);
    }
  }
  return parts.length ? Prisma.sql`${Prisma.join(parts, ' AND ')}` : Prisma.sql`true`;
}

export function buildGroupQuery(where: Prisma.BillWhereInput, grouping: BillGrouping,
  offsetMinutes: number, limit: number, before?: string): Prisma.Sql {
  const bucket = Prisma.sql`date_trunc(${grouping}, "date" + ${offsetMinutes} * interval '1 minute')`;
  return Prisma.sql`
    WITH filtered AS (SELECT *, ${bucket} AS bucket FROM "Bill" WHERE ${whereSql(where)})
    SELECT to_char(bucket, 'YYYY-MM-DD') AS key,
      count(*)::int AS count,
      COALESCE(SUM("amount") FILTER (WHERE "type" = 'income' AND "isTransfer" = false AND "source" <> 'stock'), 0) AS income,
      COALESCE(SUM("amount") FILTER (WHERE "type" = 'expense' AND "isTransfer" = false AND "source" <> 'stock'), 0) AS expense
    FROM filtered
    GROUP BY bucket
    ${before ? Prisma.sql`HAVING bucket < ${before}::timestamp` : Prisma.empty}
    ORDER BY bucket DESC LIMIT ${limit + 1}`;
}

export function groupRange(key: string, grouping: BillGrouping, offsetMinutes: number) {
  const start = new Date(`${key}T00:00:00.000Z`);
  const end = new Date(start);
  if (grouping === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
  else if (grouping === 'quarter' || grouping === 'month')
    end.setUTCMonth(end.getUTCMonth() + (grouping === 'quarter' ? 3 : 1));
  else end.setUTCDate(end.getUTCDate() + (grouping === 'week' ? 7 : 1));
  return {
    startAt: new Date(start.getTime() - offsetMinutes * 60000).toISOString(),
    endBefore: new Date(end.getTime() - offsetMinutes * 60000).toISOString(),
  };
}
