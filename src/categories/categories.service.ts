import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

// 一级系统分类
const SYSTEM_CATEGORIES = [
  // ── 收入 ──
  { name: '工资',     type: 'income',  icon: '💰', color: '#4CAF50' },
  { name: '奖金',     type: 'income',  icon: '🎁', color: '#8BC34A' },
  { name: '兼职副业', type: 'income',  icon: '💼', color: '#CDDC39' },
  { name: '投资理财', type: 'income',  icon: '📈', color: '#00BCD4' },
  { name: '报销',     type: 'income',  icon: '🧾', color: '#03A9F4' },
  { name: '红包礼金', type: 'income',  icon: '🧧', color: '#F44336' },
  { name: '其他收入', type: 'income',  icon: '➕', color: '#9C27B0' },
  // ── 支出 ──
  { name: '餐饮',     type: 'expense', icon: '🍜', color: '#F44336' },
  { name: '交通',     type: 'expense', icon: '🚌', color: '#FF9800' },
  { name: '购物',     type: 'expense', icon: '🛍️', color: '#E91E63' },
  { name: '住房',     type: 'expense', icon: '🏠', color: '#795548' },
  { name: '娱乐',     type: 'expense', icon: '🎮', color: '#FFC107' },
  { name: '医疗健康', type: 'expense', icon: '🏥', color: '#009688' },
  { name: '教育',     type: 'expense', icon: '📚', color: '#3F51B5' },
  { name: '通讯',     type: 'expense', icon: '📱', color: '#2196F3' },
  { name: '人情社交', type: 'expense', icon: '🎎', color: '#F06292' },
  { name: '育儿亲子', type: 'expense', icon: '👶', color: '#FF5722' },
  { name: '汽车',     type: 'expense', icon: '🚗', color: '#607D8B' },
  { name: '宠物',     type: 'expense', icon: '🐾', color: '#FF7043' },
  { name: '运动健身', type: 'expense', icon: '🏃', color: '#4CAF50' },
  { name: '美容美发', type: 'expense', icon: '💇', color: '#BA68C8' },
  { name: '保险',     type: 'expense', icon: '🛡️', color: '#26C6DA' },
  { name: '其他支出', type: 'expense', icon: '➖', color: '#9E9E9E' },
];

// 系统二级分类（parentName -> 子项列表）
const SYSTEM_SUBCATEGORIES: Record<string, Array<{ name: string; icon: string }>> = {
  餐饮: [
    { name: '早餐',     icon: '🥐' },
    { name: '午餐',     icon: '🍱' },
    { name: '晚餐',     icon: '🍲' },
    { name: '外卖',     icon: '🥡' },
    { name: '咖啡饮品', icon: '☕' },
    { name: '零食水果', icon: '🍿' },
    { name: '买菜食材', icon: '🥬' },
    { name: '聚餐请客', icon: '🥂' },
  ],
  交通: [
    { name: '公交地铁', icon: '🚇' },
    { name: '打车',     icon: '🚖' },
    { name: '火车',     icon: '🚂' },
    { name: '高铁',     icon: '🚄' },
    { name: '飞机',     icon: '✈️' },
    { name: '加油充电', icon: '⛽' },
    { name: '停车',     icon: '🅿️' },
    { name: '过路费',   icon: '🛣️' },
  ],
  购物: [
    { name: '日用品',   icon: '🧴' },
    { name: '数码电子', icon: '💻' },
    { name: '家电家居', icon: '🛋️' },
    { name: '服饰鞋包', icon: '👕' },
    { name: '美妆个护', icon: '💄' },
    { name: '书籍文具', icon: '📖' },
  ],
  住房: [
    { name: '房租',     icon: '🏠' },
    { name: '房贷',     icon: '🏦' },
    { name: '水费',     icon: '💧' },
    { name: '电费',     icon: '⚡' },
    { name: '燃气费',   icon: '🔥' },
    { name: '物业',     icon: '🛎️' },
    { name: '维修装修', icon: '🔧' },
    { name: '家政保洁', icon: '🧹' },
  ],
  娱乐: [
    { name: '电影演出', icon: '🎬' },
    { name: '游戏',     icon: '🎮' },
    { name: 'KTV',      icon: '🎤' },
    { name: '会员订阅', icon: '🎟️' },
    { name: '旅游度假', icon: '✈️' },
    { name: '景点门票', icon: '🎫' },
  ],
  医疗健康: [
    { name: '门诊挂号', icon: '🏥' },
    { name: '药品',     icon: '💊' },
    { name: '体检',     icon: '🩺' },
    { name: '牙科',     icon: '🦷' },
    { name: '保健养生', icon: '🧘' },
  ],
  教育: [
    { name: '学费培训', icon: '🎓' },
    { name: '教材文具', icon: '✏️' },
    { name: '考试报名', icon: '📝' },
  ],
  通讯: [
    { name: '话费',     icon: '📞' },
    { name: '宽带',     icon: '📡' },
    { name: '数字订阅', icon: '📲' },
  ],
  人情社交: [
    { name: '红包礼金', icon: '🧧' },
    { name: '份子钱',   icon: '💝' },
    { name: '请客送礼', icon: '🎁' },
  ],
  育儿亲子: [
    { name: '奶粉尿布', icon: '🍼' },
    { name: '玩具童装', icon: '🧸' },
    { name: '早教',     icon: '🏫' },
  ],
  汽车: [
    { name: '车贷',     icon: '🏦' },
    { name: '保险',     icon: '🛡️' },
    { name: '保养维修', icon: '🔧' },
    { name: '洗车年检', icon: '🚿' },
  ],
  宠物: [
    { name: '粮食零食', icon: '🐶' },
    { name: '医疗保健', icon: '💉' },
    { name: '用品玩具', icon: '🦴' },
  ],
  运动健身: [
    { name: '健身瑜伽', icon: '🏋️' },
    { name: '器材装备', icon: '⚽' },
    { name: '球类游泳', icon: '🎾' },
  ],
  美容美发: [
    { name: '理发造型', icon: '💈' },
    { name: '美容护肤', icon: '💆' },
    { name: '美甲美睫', icon: '💅' },
    { name: '按摩SPA',  icon: '🧖' },
  ],
  保险: [
    { name: '社保医保', icon: '🏥' },
    { name: '商业保险', icon: '📋' },
  ],
};

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
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    // 1. 一级分类种子
    const count = await this.prisma.category.count({
      where: { isSystem: true, parentId: null },
    });
    if (count === 0) {
      await this.prisma.category.createMany({
        data: SYSTEM_CATEGORIES.map((c) => ({ ...c, isSystem: true }) as any),
      });
    }

    // 2. 二级分类种子（按 parent name 找 parent id，幂等：name+parentId 已存在就跳过）
    const parents = await this.prisma.category.findMany({
      where: { isSystem: true, parentId: null, name: { in: Object.keys(SYSTEM_SUBCATEGORIES) } },
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
      }
    }
  }

  /** 返回 系统分类 + 当前账本自建分类（含 parent 信息）
   *
   *  排序优先级：
   *   1. parentId 升序（一级在前、子分类按父分组）
   *   2. 系统分类在前、用户自建在后（同一父下也是）
   *   3. 名字以"其他"开头的项 永远排到所在组的最后
   *   4. createdAt 升序
   */
  async findAll(ledgerId: string) {
    const categories = await this.prisma.category.findMany({
      where: { OR: [{ isSystem: true }, { ledgerId }] },
      include: { parent: { select: { name: true, icon: true } } },
    });

    const isOther = (name: string) =>
      typeof name === 'string' && name.startsWith('其他');

    categories.sort((a, b) => {
      // 一级在前，否则按 parentId 分组
      const aPid = a.parentId ?? '';
      const bPid = b.parentId ?? '';
      if (aPid !== bPid) {
        if (aPid === '') return -1;
        if (bPid === '') return 1;
        return aPid.localeCompare(bPid);
      }
      // "其他…" 排到所在组最后
      const aOther = isOther(a.name);
      const bOther = isOther(b.name);
      if (aOther !== bOther) return aOther ? 1 : -1;
      // 系统分类在前
      if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
      // 否则按创建时间
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    return { categories: categories.map(shapeCategory) };
  }

  async create(ledgerId: string, userId: string, dto: CreateCategoryDto) {
    // 如果带 parentId，校验 parent 存在且 type 一致
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

    await this.prisma.category.delete({ where: { id } });
    return { message: '删除成功' };
  }
}
