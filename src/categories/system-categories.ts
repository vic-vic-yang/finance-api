/**
 * 系统默认分类：种子 + 存量迁移映射（唯一真相源）。
 *
 * 迁移键：`${type}|${parentName ?? ''}|${name}`
 * 目标同样格式；一级 parentName 为空串。
 */

export type BillCatType = 'income' | 'expense';

export interface SystemCategorySeed {
  name: string;
  type: BillCatType;
  icon: string;
  color: string;
}

export interface SystemSubSeed {
  name: string;
  icon: string;
}

/** 一级系统分类（定稿） */
export const SYSTEM_CATEGORIES: SystemCategorySeed[] = [
  // ── 收入 ──
  { name: '工资薪金', type: 'income', icon: '💰', color: '#4CAF50' },
  { name: '兼职副业', type: 'income', icon: '💼', color: '#CDDC39' },
  { name: '投资理财', type: 'income', icon: '📈', color: '#00BCD4' },
  { name: '红包礼金', type: 'income', icon: '🧧', color: '#F44336' },
  { name: '报销退款', type: 'income', icon: '🧾', color: '#03A9F4' },
  { name: '其他收入', type: 'income', icon: '➕', color: '#9C27B0' },
  // ── 支出 ──
  { name: '餐饮', type: 'expense', icon: '🍜', color: '#F44336' },
  { name: '交通', type: 'expense', icon: '🚌', color: '#FF9800' },
  { name: '购物', type: 'expense', icon: '🛍️', color: '#E91E63' },
  { name: '住房', type: 'expense', icon: '🏠', color: '#795548' },
  { name: '娱乐', type: 'expense', icon: '🎮', color: '#FFC107' },
  { name: '通讯', type: 'expense', icon: '📱', color: '#2196F3' },
  { name: '医疗', type: 'expense', icon: '🏥', color: '#009688' },
  { name: '教育', type: 'expense', icon: '📚', color: '#3F51B5' },
  { name: '人情往来', type: 'expense', icon: '🎎', color: '#F06292' },
  { name: '金融保险', type: 'expense', icon: '🛡️', color: '#26C6DA' },
  { name: '家庭', type: 'expense', icon: '👨‍👩‍👧', color: '#FF5722' },
  { name: '其他支出', type: 'expense', icon: '➖', color: '#9E9E9E' },
];

/** 二级系统分类 */
export const SYSTEM_SUBCATEGORIES: Record<string, SystemSubSeed[]> = {
  // ── 收入 ──
  工资薪金: [
    { name: '基本工资', icon: '💵' },
    { name: '加班费', icon: '⏰' },
    { name: '年终奖', icon: '🎊' },
    { name: '绩效提成', icon: '📊' },
    { name: '补贴津贴', icon: '💴' },
  ],
  兼职副业: [
    { name: '自由职业', icon: '💻' },
    { name: '稿费外包', icon: '✍️' },
    { name: '其他兼职', icon: '🧾' },
  ],
  投资理财: [
    { name: '利息', icon: '🏦' },
    { name: '分红', icon: '💹' },
    { name: '基金股票收益', icon: '📈' },
    { name: '房租收入', icon: '🏠' },
  ],
  红包礼金: [
    { name: '收红包', icon: '🧧' },
    { name: '收礼金', icon: '💝' },
    { name: '压岁钱', icon: '🎀' },
    { name: '家人给予', icon: '👨‍👩‍👧' },
  ],
  报销退款: [
    { name: '差旅报销', icon: '🧳' },
    { name: '餐补', icon: '🍱' },
    { name: '交通报销', icon: '🚕' },
    { name: '购物退款', icon: '↩️' },
    { name: '医疗报销', icon: '🏥' },
    { name: '保险理赔', icon: '🛡️' },
  ],
  其他收入: [
    { name: '二手变卖', icon: '🏷️' },
    { name: '中奖', icon: '🎯' },
    { name: '退税', icon: '📋' },
    { name: '政府补贴', icon: '🏛️' },
    { name: '意外所得', icon: '✨' },
  ],
  // ── 支出 ──
  餐饮: [
    { name: '外卖', icon: '🥡' },
    { name: '堂食', icon: '🍱' },
    { name: '买菜食材', icon: '🥬' },
    { name: '咖啡奶茶', icon: '☕' },
    { name: '零食水果', icon: '🍿' },
    { name: '烟酒', icon: '🚬' },
    { name: '聚餐', icon: '🥂' },
  ],
  交通: [
    { name: '公交地铁', icon: '🚇' },
    { name: '打车', icon: '🚖' },
    { name: '火车高铁', icon: '🚄' },
    { name: '飞机', icon: '✈️' },
    { name: '共享单车', icon: '🚲' },
    { name: '加油充电', icon: '⛽' },
    { name: '停车费', icon: '🅿️' },
    { name: '过路费', icon: '🛣️' },
    { name: '保养维修', icon: '🔧' },
    { name: '车贷', icon: '🏦' },
    { name: '洗车年检', icon: '🚿' },
  ],
  购物: [
    { name: '日用百货', icon: '🧴' },
    { name: '服饰鞋包', icon: '👕' },
    { name: '数码电器', icon: '💻' },
    { name: '美妆个护', icon: '💄' },
    { name: '家居家装', icon: '🛋️' },
  ],
  住房: [
    { name: '房租', icon: '🏠' },
    { name: '房贷', icon: '🏦' },
    { name: '水费', icon: '💧' },
    { name: '电费', icon: '⚡' },
    { name: '燃气费', icon: '🔥' },
    { name: '物业费', icon: '🛎️' },
    { name: '取暖费', icon: '🌡️' },
    { name: '维修装修', icon: '🔧' },
    { name: '家政保洁', icon: '🧹' },
  ],
  娱乐: [
    { name: '电影演出', icon: '🎬' },
    { name: '游戏', icon: '🎮' },
    { name: '旅游度假', icon: '✈️' },
    { name: '运动健身', icon: '🏃' },
    { name: '会员订阅', icon: '🎟️' },
    { name: '酒店住宿', icon: '🏨' },
  ],
  通讯: [
    { name: '话费', icon: '📞' },
    { name: '宽带', icon: '📡' },
    { name: '流量包', icon: '📶' },
  ],
  医疗: [
    { name: '看病挂号', icon: '🏥' },
    { name: '药品', icon: '💊' },
    { name: '体检', icon: '🩺' },
    { name: '牙科', icon: '🦷' },
    { name: '保健养生', icon: '🧘' },
  ],
  教育: [
    { name: '学费培训', icon: '🎓' },
    { name: '书籍文具', icon: '✏️' },
    { name: '考试报名', icon: '📝' },
    { name: '孩子兴趣班', icon: '🎨' },
  ],
  人情往来: [
    { name: '红包', icon: '🧧' },
    { name: '随礼份子', icon: '💝' },
    { name: '请客招待', icon: '🥂' },
    { name: '送礼', icon: '🎁' },
    { name: '孝亲赡养', icon: '🙏' },
    { name: '亲属支持', icon: '🤝' },
  ],
  金融保险: [
    { name: '人身保险', icon: '📋' },
    { name: '车险', icon: '🚗' },
    { name: '社保公积金', icon: '🏥' },
    { name: '贷款利息', icon: '📉' },
    { name: '消费贷款', icon: '💳' },
    { name: '手续费', icon: '🏦' },
    { name: '投资亏损', icon: '📊' },
  ],
  家庭: [
    { name: '奶粉尿布', icon: '🍼' },
    { name: '玩具童装', icon: '🧸' },
    { name: '早教托育', icon: '🏫' },
    { name: '宠物', icon: '🐾' },
    { name: '理发造型', icon: '💈' },
    { name: '美容美甲', icon: '💅' },
  ],
  其他支出: [
    { name: '快递物流', icon: '📦' },
    { name: '捐赠公益', icon: '❤️' },
    { name: '税费罚款', icon: '📄' },
    { name: '办公耗材', icon: '📎' },
    { name: '意外支出', icon: '💥' },
  ],
};

/** 一级就地改名：旧名 → 新名（保留 id，账单不用动） */
export const L1_RENAMES: Record<string, string> = {
  工资: '工资薪金',
  报销: '报销退款',
  人情社交: '人情往来',
  医疗健康: '医疗',
};

/**
 * 旧分类 → 新分类显式映射。
 * key/value: `${type}|${parentName}|${name}`，一级 parentName 为空。
 */
export const LEGACY_CATEGORY_REMAP: Record<string, string> = {
  // ── 收入：废弃一级「奖金」──
  'income||奖金': 'income||工资薪金',
  'income|奖金|年终奖': 'income|工资薪金|年终奖',
  'income|奖金|项目奖金': 'income|工资薪金|绩效提成',
  'income|奖金|提成': 'income|工资薪金|绩效提成',
  'income|奖金|全勤奖': 'income|工资薪金|补贴津贴',

  // 工资子项改名
  'income|工资|基本工资': 'income|工资薪金|基本工资',
  'income|工资|绩效奖金': 'income|工资薪金|绩效提成',
  'income|工资|加班费': 'income|工资薪金|加班费',
  'income|工资|补贴津贴': 'income|工资薪金|补贴津贴',
  'income|工资薪金|绩效奖金': 'income|工资薪金|绩效提成',

  // 兼职
  'income|兼职副业|接单外包': 'income|兼职副业|稿费外包',
  'income|兼职副业|稿费': 'income|兼职副业|稿费外包',
  'income|兼职副业|直播带货': 'income|兼职副业|其他兼职',
  'income|兼职副业|摆摊': 'income|兼职副业|其他兼职',

  // 投资
  'income|投资理财|股票基金': 'income|投资理财|基金股票收益',
  'income|投资理财|数字货币': 'income|投资理财|基金股票收益',

  // 报销旧树
  'income|报销|差旅报销': 'income|报销退款|差旅报销',
  'income|报销|餐补': 'income|报销退款|餐补',
  'income|报销|交通报销': 'income|报销退款|交通报销',
  'income|报销|医疗报销': 'income|报销退款|医疗报销',
  'income|其他收入|退款': 'income|报销退款|购物退款',

  // 红包礼金
  'income|红包礼金|节日红包': 'income|红包礼金|收红包',
  'income|红包礼金|份子钱': 'income|红包礼金|收礼金',

  // ── 支出：餐饮 ──
  'expense|餐饮|早餐': 'expense|餐饮|堂食',
  'expense|餐饮|午餐': 'expense|餐饮|堂食',
  'expense|餐饮|晚餐': 'expense|餐饮|堂食',
  'expense|餐饮|咖啡饮品': 'expense|餐饮|咖啡奶茶',
  'expense|餐饮|聚餐请客': 'expense|餐饮|聚餐',

  // 交通
  'expense|交通|火车': 'expense|交通|火车高铁',
  'expense|交通|高铁': 'expense|交通|火车高铁',
  'expense|交通|停车': 'expense|交通|停车费',

  // 购物改名
  'expense|购物|日用品': 'expense|购物|日用百货',
  'expense|购物|数码电子': 'expense|购物|数码电器',
  'expense|购物|家电家居': 'expense|购物|家居家装',
  'expense|购物|书籍文具': 'expense|教育|书籍文具',

  // 住房
  'expense|住房|物业': 'expense|住房|物业费',

  // 娱乐
  'expense|娱乐|KTV': 'expense|娱乐|电影演出',
  'expense|娱乐|景点门票': 'expense|娱乐|旅游度假',

  // 通讯 → 订阅归娱乐
  'expense|通讯|数字订阅': 'expense|娱乐|会员订阅',

  // 医疗旧名
  'expense|医疗健康|门诊挂号': 'expense|医疗|看病挂号',
  'expense|医疗健康|药品': 'expense|医疗|药品',
  'expense|医疗健康|体检': 'expense|医疗|体检',
  'expense|医疗健康|牙科': 'expense|医疗|牙科',
  'expense|医疗健康|保健养生': 'expense|医疗|保健养生',
  'expense|医疗|门诊挂号': 'expense|医疗|看病挂号',

  // 人情
  'expense|人情社交|红包礼金': 'expense|人情往来|红包',
  'expense|人情社交|份子钱': 'expense|人情往来|随礼份子',
  'expense|人情社交|请客送礼': 'expense|人情往来|请客招待',
  'expense|人情往来|红包礼金': 'expense|人情往来|红包',
  'expense|人情往来|份子钱': 'expense|人情往来|随礼份子',
  'expense|人情往来|请客送礼': 'expense|人情往来|请客招待',

  // 废弃一级：汽车 → 交通 / 金融
  'expense||汽车': 'expense||交通',
  'expense|汽车|车贷': 'expense|交通|车贷',
  'expense|汽车|保险': 'expense|金融保险|车险',
  'expense|汽车|保养维修': 'expense|交通|保养维修',
  'expense|汽车|洗车年检': 'expense|交通|洗车年检',

  // 废弃一级：育儿亲子 → 家庭
  'expense||育儿亲子': 'expense||家庭',
  'expense|育儿亲子|奶粉尿布': 'expense|家庭|奶粉尿布',
  'expense|育儿亲子|玩具童装': 'expense|家庭|玩具童装',
  'expense|育儿亲子|早教': 'expense|家庭|早教托育',

  // 废弃一级：宠物 → 家庭·宠物
  'expense||宠物': 'expense|家庭|宠物',
  'expense|宠物|粮食零食': 'expense|家庭|宠物',
  'expense|宠物|医疗保健': 'expense|家庭|宠物',
  'expense|宠物|用品玩具': 'expense|家庭|宠物',

  // 废弃一级：运动健身 → 娱乐
  'expense||运动健身': 'expense|娱乐|运动健身',
  'expense|运动健身|健身瑜伽': 'expense|娱乐|运动健身',
  'expense|运动健身|器材装备': 'expense|娱乐|运动健身',
  'expense|运动健身|球类游泳': 'expense|娱乐|运动健身',

  // 废弃一级：美容美发 → 家庭
  'expense||美容美发': 'expense||家庭',
  'expense|美容美发|理发造型': 'expense|家庭|理发造型',
  'expense|美容美发|美容护肤': 'expense|家庭|美容美甲',
  'expense|美容美发|美甲美睫': 'expense|家庭|美容美甲',
  'expense|美容美发|按摩SPA': 'expense|家庭|美容美甲',

  // 废弃一级：保险 → 金融保险
  'expense||保险': 'expense||金融保险',
  'expense|保险|社保医保': 'expense|金融保险|社保公积金',
  'expense|保险|商业保险': 'expense|金融保险|人身保险',
};

export function catKey(
  type: BillCatType,
  parentName: string | null | undefined,
  name: string,
): string {
  return `${type}|${parentName ?? ''}|${name}`;
}

export function parseCatKey(key: string): {
  type: BillCatType;
  parentName: string | null;
  name: string;
} {
  const [type, parentName, name] = key.split('|');
  return {
    type: type as BillCatType,
    parentName: parentName === '' ? null : parentName,
    name,
  };
}

/** 新种子里所有合法 key（含一级） */
export function buildCanonicalKeys(): Set<string> {
  const keys = new Set<string>();
  for (const c of SYSTEM_CATEGORIES) {
    keys.add(catKey(c.type, null, c.name));
  }
  const typeByParent = new Map(
    SYSTEM_CATEGORIES.map((c) => [c.name, c.type] as const),
  );
  for (const [parentName, children] of Object.entries(SYSTEM_SUBCATEGORIES)) {
    const type = typeByParent.get(parentName);
    if (!type) continue;
    for (const ch of children) {
      keys.add(catKey(type, parentName, ch.name));
    }
  }
  return keys;
}

/**
 * 解析旧分类应迁到的目标 key。
 * 若已在新种子中则返回自身；否则查显式表；再否则回落到「其他*」。
 */
export function resolveLegacyTarget(
  type: BillCatType,
  parentName: string | null,
  name: string,
  canonical: Set<string> = buildCanonicalKeys(),
): string {
  const self = catKey(type, parentName, name);
  if (canonical.has(self)) return self;

  // 一级就地改名：工资 → 工资薪金
  if (!parentName && L1_RENAMES[name]) {
    const renamed = catKey(type, null, L1_RENAMES[name]);
    if (canonical.has(renamed)) return renamed;
  }

  // 父级可能已改名：用 L1_RENAMES 正规化父名后再查
  const normParent =
    parentName && L1_RENAMES[parentName]
      ? L1_RENAMES[parentName]
      : parentName;
  const normSelf = catKey(type, normParent, name);
  if (canonical.has(normSelf)) return normSelf;

  const mapped = LEGACY_CATEGORY_REMAP[self] ?? LEGACY_CATEGORY_REMAP[normSelf];
  if (mapped) {
    // 映射目标再走一轮（最多一次链式）
    const p = parseCatKey(mapped);
    const again = catKey(p.type, p.parentName, p.name);
    if (canonical.has(again)) return again;
    const chained = LEGACY_CATEGORY_REMAP[again];
    if (chained && canonical.has(chained)) return chained;
    if (canonical.has(mapped)) return mapped;
    return mapped;
  }

  // 父仍在种子：挂到父一级
  if (normParent) {
    const parentKey = catKey(type, null, normParent);
    if (canonical.has(parentKey)) return parentKey;
  }

  return type === 'income'
    ? catKey('income', null, '其他收入')
    : catKey('expense', null, '其他支出');
}
