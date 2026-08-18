require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const ids = [
    'cmpvb2xqb0006ysopdfpz31ur',
    'cmq3nq2lr0002qff0ap2spcr3',
    'cmq0zacn50002l4ofrrj8ikgf',
    'cmq3ke96l001523xk9g041999',
  ];
  for (const id of ids) {
    const c = await p.category.findUnique({ where: { id } });
    console.log('CAT', c && { id: c.id, name: c.name, type: c.type, parentId: c.parentId });
    const ch = await p.category.findMany({ where: { parentId: id } });
    console.log(
      '  children',
      ch.map((x) => ({ id: x.id, name: x.name, type: x.type })),
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
