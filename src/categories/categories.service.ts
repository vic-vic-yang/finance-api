import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import {
  SYSTEM_CATEGORIES,
  SYSTEM_SUBCATEGORIES,
  L1_RENAMES,
  buildCanonicalKeys,
  catKey,
  parseCatKey,
  resolveLegacyTarget,
  BillCatType,
} from './system-categories';
import { resolveMergeGuard } from './category-merge';

// 把数据库行处理为前端要的形状
function shapeCategory(c: any) {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    icon: c.icon,
    color: c.color,
    isSystem: c.isSystem,
    parentId: c.parentId ?? null,
    parentName: c.parent?.name ?? null,
    parentIcon: c.parent?.icon ?? null,
  };
}

@Injectable()
export class CategoriesService implements OnModuleInit {
  private readonly logger = new Logger('Categories');

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    await this.ensureSystemCategories();
  }

  /**
   * 确保系统分类与定稿种子一致，并幂等迁移旧系统分类上的业务引用。
   * 用户自建分类（isSystem=false）不动。
   */
  private async ensureSystemCategories() {
    await this.seedSystemCategories();
    await this.migrateLegacySystemCategories();
  }

  /** 补种 / 一级就地改名 / 补二级 */
  private async seedSystemCategories() {
    // 1. 一级：改名优先，否则按名创建
    for (const seed of SYSTEM_CATEGORIES) {
      const existing = await this.prisma.category.findFirst({
        where: { isSystem: true, parentId: null, name: seed.name, type: seed.type as any },
      });
      if (existing) {
        // 图标/颜色漂移时轻轻对齐（不改 name）
        if (existing.icon !== seed.icon || existing.color !== seed.color) {
          await this.prisma.category.update({
            where: { id: existing.id },
            data: { icon: seed.icon, color: seed.color },
          });
        }
        continue;
      }

      // 旧名就地改名（保留 id → 账单不用迁）
      const oldName = Object.entries(L1_RENAMES).find(
        ([, neu]) => neu === seed.name,
      )?.[0];
      if (oldName) {
        const oldRow = await this.prisma.category.findFirst({
          where: {
            isSystem: true,
            parentId: null,
            name: oldName,
            type: seed.type as any,
          },
        });
        if (oldRow) {
          await this.prisma.category.update({
            where: { id: oldRow.id },
            data: {
              name: seed.name,
              icon: seed.icon,
              color: seed.color,
            },
          });
          this.logger.log(`系统一级改名：${oldName} → ${seed.name}`);
          continue;
        }
      }

      await this.prisma.category.create({
        data: {
          name: seed.name,
          type: seed.type as any,
          icon: seed.icon,
          color: seed.color,
          isSystem: true,
        },
      });
      this.logger.log(`补种系统一级：${seed.name}`);
    }

    // 2. 二级：按父名挂接，缺则建
    const parents = await this.prisma.category.findMany({
      where: {
        isSystem: true,
        parentId: null,
        name: { in: Object.keys(SYSTEM_SUBCATEGORIES) },
      },
    });
    const parentByName = new Map(parents.map((p) => [p.name, p]));

    for (const [parentName, children] of Object.entries(SYSTEM_SUBCATEGORIES)) {
      const parent = parentByName.get(parentName);
      if (!parent) continue;
      const existing = await this.prisma.category.findMany({
        where: { parentId: parent.id, isSystem: true },
        select: { name: true },
      });
      const existingNames = new Set(existing.map((c) => c.name));
      const toCreate = children
        .filter((c) => !existingNames.has(c.name))
        .map((c) => ({
          name: c.name,
          icon: c.icon,
          type: parent.type,
          color: parent.color,
          isSystem: true,
          parentId: parent.id,
        }));
      if (toCreate.length) {
        await this.prisma.category.createMany({ data: toCreate as any });
        this.logger.log(
          `补种系统二级「${parentName}」：${toCreate.map((c) => c.name).join('、')}`,
        );
      }
    }
  }

  /**
   * 把不在新种子中的旧系统分类上的引用改挂到目标，再删空壳分类。
   * 可重复执行：无旧分类时立刻返回。
   */
  private async migrateLegacySystemCategories() {
    const canonical = buildCanonicalKeys();
    const allSystem = await this.prisma.category.findMany({
      where: { isSystem: true },
      include: { parent: { select: { name: true } } },
    });

    // id → key / key → id（新树）
    const keyOf = (c: (typeof allSystem)[0]) =>
      catKey(c.type as BillCatType, c.parent?.name ?? null, c.name);

    const idByKey = new Map<string, string>();
    for (const c of allSystem) {
      const k = keyOf(c);
      if (canonical.has(k)) idByKey.set(k, c.id);
    }

    // 种子刚补完时 allSystem 可能缺新行——再拉一次目标 id
    const ensureTargetId = async (targetKey: string): Promise<string | null> => {
      const hit = idByKey.get(targetKey);
      if (hit) return hit;
      const { type, parentName, name } = parseCatKey(targetKey);
      let parentId: string | null = null;
      if (parentName) {
        const parent = await this.prisma.category.findFirst({
          where: {
            isSystem: true,
            parentId: null,
            name: parentName,
            type: type as any,
          },
        });
        if (!parent) return null;
        parentId = parent.id;
      }
      const row = await this.prisma.category.findFirst({
        where: {
          isSystem: true,
          parentId,
          name,
          type: type as any,
        },
      });
      if (row) {
        idByKey.set(targetKey, row.id);
        return row.id;
      }
      return null;
    };

    const legacy = allSystem.filter((c) => !canonical.has(keyOf(c)));
    if (legacy.length === 0) return;

    let moved = 0;
    // 先迁二级再迁一级，减少「父被删子还在」窗口
    legacy.sort((a, b) => {
      const ap = a.parentId ? 0 : 1;
      const bp = b.parentId ? 0 : 1;
      return ap - bp;
    });

    for (const old of legacy) {
      const oldKey = keyOf(old);
      const targetKey = resolveLegacyTarget(
        old.type as BillCatType,
        old.parent?.name ?? null,
        old.name,
        canonical,
      );
      const toId = await ensureTargetId(targetKey);
      if (!toId) {
        this.logger.warn(`迁移跳过：找不到目标 ${targetKey}（来自 ${oldKey}）`);
        continue;
      }
      if (toId === old.id) continue;

      await this.repointCategoryRefs(old.id, toId);
      moved++;
    }

    // 删除已无引用的废弃系统分类（先子后父）
    const leftovers = await this.prisma.category.findMany({
      where: { isSystem: true },
      include: { parent: { select: { name: true } } },
    });
    const toDelete = leftovers
      .filter((c) => !canonical.has(keyOf(c)))
      .sort((a, b) => {
        const ap = a.parentId ? 0 : 1;
        const bp = b.parentId ? 0 : 1;
        return ap - bp;
      });

    let deleted = 0;
    for (const c of toDelete) {
      const refs = await this.countCategoryRefs(c.id);
      if (refs > 0) {
        this.logger.warn(
          `废弃分类「${c.name}」仍有 ${refs} 处引用，暂不删除`,
        );
        continue;
      }
      // 若还有子分类挂着，跳过（下一轮或子删后再删）
      const childCount = await this.prisma.category.count({
        where: { parentId: c.id },
      });
      if (childCount > 0) continue;

      await this.prisma.categorySort.deleteMany({ where: { categoryId: c.id } });
      await this.prisma.category.delete({ where: { id: c.id } });
      deleted++;
    }

    if (moved || deleted) {
      this.logger.log(
        `系统分类迁移完成：重挂 ${moved} 个，删除废弃 ${deleted} 个`,
      );
    }
  }

  private async countCategoryRefs(categoryId: string): Promise<number> {
    const [bills, budgets, recurring, corrections, aiCorr, accounts] =
      await Promise.all([
        this.prisma.bill.count({ where: { categoryId } }),
        this.prisma.budget.count({ where: { categoryId } }),
        this.prisma.recurringBill.count({ where: { categoryId } }),
        this.prisma.categoryCorrection.count({ where: { categoryId } }),
        this.prisma.aiCorrection.count({ where: { categoryId } }),
        this.prisma.account.count({ where: { autoDepositCategoryId: categoryId } }),
      ]);
    return bills + budgets + recurring + corrections + aiCorr + accounts;
  }

  /** 把所有指向 fromId 的业务 FK 改到 toId */
  private async repointCategoryRefs(fromId: string, toId: string) {
    await this.prisma.$transaction([
      this.prisma.bill.updateMany({
        where: { categoryId: fromId },
        data: { categoryId: toId },
      }),
      this.prisma.budget.updateMany({
        where: { categoryId: fromId },
        data: { categoryId: toId },
      }),
      this.prisma.recurringBill.updateMany({
        where: { categoryId: fromId },
        data: { categoryId: toId },
      }),
      this.prisma.categoryCorrection.updateMany({
        where: { categoryId: fromId },
        data: { categoryId: toId },
      }),
      this.prisma.aiCorrection.updateMany({
        where: { categoryId: fromId },
        data: { categoryId: toId },
      }),
      this.prisma.account.updateMany({
        where: { autoDepositCategoryId: fromId },
        data: { autoDepositCategoryId: toId },
      }),
      this.prisma.categorySort.deleteMany({ where: { categoryId: fromId } }),
    ]);
  }

  /** 返回 系统分类 + 当前账本自建分类（含 parent 信息） */
  async findAll(ledgerId: string) {
    await this.ensureSystemCategories();

    const categories = await this.prisma.category.findMany({
      where: { OR: [{ isSystem: true }, { ledgerId }] },
      include: { parent: { select: { name: true, icon: true } } },
    });

    const sorts = await this.prisma.categorySort.findMany({
      where: { ledgerId },
      select: { categoryId: true, sortOrder: true },
    });
    const orderMap = new Map(sorts.map((s) => [s.categoryId, s.sortOrder]));

    const isOther = (name: string) =>
      typeof name === 'string' && name.startsWith('其他');

    // 一级展示顺序：跟种子数组一致
    const l1Order = new Map(
      SYSTEM_CATEGORIES.map((c, i) => [c.name, i] as const),
    );

    categories.sort((a, b) => {
      const aPid = a.parentId ?? '';
      const bPid = b.parentId ?? '';
      if (aPid !== bPid) {
        if (aPid === '') return -1;
        if (bPid === '') return 1;
        return aPid.localeCompare(bPid);
      }
      const ao = orderMap.get(a.id);
      const bo = orderMap.get(b.id);
      if (ao != null || bo != null) {
        if (ao != null && bo != null) return ao - bo;
        return ao != null ? -1 : 1;
      }
      // 一级：按种子顺序
      if (!a.parentId && !b.parentId) {
        const ai = l1Order.get(a.name) ?? 999;
        const bi = l1Order.get(b.name) ?? 999;
        if (ai !== bi) return ai - bi;
      }
      const aOther = isOther(a.name);
      const bOther = isOther(b.name);
      if (aOther !== bOther) return aOther ? 1 : -1;
      if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    return { categories: categories.map(shapeCategory) };
  }

  async create(ledgerId: string, userId: string, dto: CreateCategoryDto) {
    if (dto.parentId) {
      const parent = await this.prisma.category.findFirst({
        where: { id: dto.parentId },
      });
      if (!parent) throw new NotFoundException('父分类不存在');
      if (parent.type !== dto.type)
        throw new ForbiddenException('子分类必须跟父分类同类型');
      if (parent.parentId)
        throw new ForbiddenException('不支持三级分类');
    }

    const category = await this.prisma.category.create({
      data: {
        ledgerId,
        userId,
        name: dto.name,
        type: dto.type as any,
        icon: dto.icon,
        color: dto.color,
        parentId: dto.parentId,
        isSystem: false,
      },
      include: { parent: { select: { name: true, icon: true } } },
    });
    return { message: '创建成功', category: shapeCategory(category) };
  }

  async update(ledgerId: string, id: string, dto: UpdateCategoryDto) {
    const category = await this.prisma.category.findFirst({ where: { id } });
    if (!category) throw new NotFoundException('分类不存在');
    if (category.isSystem) throw new ForbiddenException('系统分类不可修改');
    if (category.ledgerId !== ledgerId)
      throw new ForbiddenException('无权操作');

    const updated = await this.prisma.category.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(dto.color !== undefined && { color: dto.color }),
      },
      include: { parent: { select: { name: true, icon: true } } },
    });
    return { message: '更新成功', category: shapeCategory(updated) };
  }

  async remove(ledgerId: string, id: string) {
    const category = await this.prisma.category.findFirst({ where: { id } });
    if (!category) throw new NotFoundException('分类不存在');
    if (category.isSystem) throw new ForbiddenException('系统分类不可删除');
    if (category.ledgerId !== ledgerId)
      throw new ForbiddenException('无权操作');

    const refs = await this.countCategoryRefs(id);
    if (refs > 0) {
      throw new BadRequestException(
        '仍有账单/预算等使用该分类，请先「合并到」其他分类后再删除',
      );
    }
    const childCount = await this.prisma.category.count({
      where: { parentId: id },
    });
    if (childCount > 0) {
      throw new BadRequestException('请先删除或合并二级分类');
    }

    await this.prisma.category.delete({ where: { id } });
    await this.prisma.categorySort
      .deleteMany({ where: { categoryId: id } })
      .catch(() => {});
    return { message: '删除成功' };
  }

  /**
   * 合并自建分类 → 目标分类：改挂全部业务引用后删除源。
   * 目标可以是系统分类或本账本自建；类型必须一致。
   */
  async merge(ledgerId: string, sourceId: string, targetId: string) {
    const [source, target, sourceChildCount] = await Promise.all([
      this.prisma.category.findFirst({ where: { id: sourceId } }),
      this.prisma.category.findFirst({ where: { id: targetId } }),
      this.prisma.category.count({ where: { parentId: sourceId } }),
    ]);

    const err = resolveMergeGuard({
      sourceId,
      targetId,
      source,
      target,
      sourceChildCount,
      targetIsDescendantOfSource: !!(
        target?.parentId && target.parentId === sourceId
      ),
      ledgerId,
    });
    if (err) {
      if (err.includes('不存在')) throw new NotFoundException(err);
      if (err.includes('无权') || err.includes('系统分类'))
        throw new ForbiddenException(err);
      throw new BadRequestException(err);
    }

    const moved = await this.countCategoryRefs(sourceId);
    await this.repointCategoryRefs(sourceId, targetId);
    await this.prisma.category.delete({ where: { id: sourceId } });

    this.logger.log(
      `合并分类「${source!.name}」→「${target!.name}」，改挂 ${moved} 处引用`,
    );
    return {
      message: '合并成功',
      moved,
      sourceName: source!.name,
      targetName: target!.name,
    };
  }

  async reorder(ledgerId: string, orderedIds: string[]) {
    const ids = (orderedIds ?? []).filter((x) => typeof x === 'string');
    if (ids.length === 0) return { message: '无变化' };
    await this.prisma.$transaction(
      ids.map((cid, i) =>
        this.prisma.categorySort.upsert({
          where: { ledgerId_categoryId: { ledgerId, categoryId: cid } },
          create: { ledgerId, categoryId: cid, sortOrder: i },
          update: { sortOrder: i },
        }),
      ),
    );
    return { message: '排序已保存' };
  }
}
