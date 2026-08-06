import {
  normalizeMerchantKey,
  findCorrectionMatches,
  matchCorrectionsInText,
  buildFewShotLines,
  MAX_FEWSHOT_CORRECTIONS,
} from './correction-matcher';

describe('normalizeMerchantKey', () => {
  it('trim + 去全部空白 + 小写', () => {
    expect(normalizeMerchantKey('  瑞幸 咖啡 ')).toBe('瑞幸咖啡');
    expect(normalizeMerchantKey('Luckin Coffee')).toBe('luckincoffee');
    expect(normalizeMerchantKey('美团\t外卖\n平台')).toBe('美团外卖平台');
  });
  it('空值归一为空串', () => {
    expect(normalizeMerchantKey('')).toBe('');
    expect(normalizeMerchantKey('   ')).toBe('');
    expect(normalizeMerchantKey(null)).toBe('');
    expect(normalizeMerchantKey(undefined)).toBe('');
  });
  it('截断到 100 字符', () => {
    expect(normalizeMerchantKey('x'.repeat(150))).toHaveLength(100);
  });
});

describe('findCorrectionMatches', () => {
  const corrections = [
    { merchantKey: '瑞幸咖啡', categoryId: 'cat-coffee' },
    { merchantKey: 'luckincoffee', categoryId: 'cat-luckin' },
    { merchantKey: '美团外卖', categoryId: 'cat-waimai' },
    { merchantKey: '滴滴出行', categoryId: 'cat-didi' },
  ];

  it('精确匹配', () => {
    const r = findCorrectionMatches(corrections, '瑞幸咖啡');
    expect(r).toEqual([{ merchantKey: '瑞幸咖啡', categoryId: 'cat-coffee' }]);
  });

  it('contains 正向：短商户名命中更长的纠正 key', () => {
    const r = findCorrectionMatches(corrections, '瑞幸');
    expect(r.map((c) => c.categoryId)).toEqual(['cat-coffee']);
  });

  it('contains 反向：长商户名命中更短的纠正 key', () => {
    const r = findCorrectionMatches(corrections, '美团外卖平台(北京)');
    expect(r.map((c) => c.categoryId)).toEqual(['cat-waimai']);
  });

  it('无匹配返回空', () => {
    expect(findCorrectionMatches(corrections, '星巴克')).toEqual([]);
  });

  it('空商户名返回空', () => {
    expect(findCorrectionMatches(corrections, '')).toEqual([]);
    expect(findCorrectionMatches(corrections, '   ')).toEqual([]);
  });

  it('规范化后匹配：大小写与空白不敏感', () => {
    const r = findCorrectionMatches(corrections, ' Luckin  COFFEE ');
    expect(r.map((c) => c.categoryId)).toEqual(['cat-luckin']);
    const r2 = findCorrectionMatches(corrections, '瑞幸 咖啡');
    expect(r2.map((c) => c.categoryId)).toEqual(['cat-coffee']);
  });

  it('精确匹配排在 contains 匹配之前', () => {
    const cs = [
      { merchantKey: '瑞幸咖啡 luckin', categoryId: 'cat-a' },
      { merchantKey: '瑞幸咖啡', categoryId: 'cat-b' },
    ];
    const r = findCorrectionMatches(cs, '瑞幸咖啡');
    expect(r[0].categoryId).toBe('cat-b');
  });

  it('超过上限截断（默认 8 条）', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      merchantKey: `瑞幸${i}号店`,
      categoryId: `cat-${i}`,
    }));
    const r = findCorrectionMatches(many, '瑞幸');
    expect(r).toHaveLength(MAX_FEWSHOT_CORRECTIONS);
  });

  it('相同 merchantKey 去重，保留先出现的（更新的）', () => {
    const cs = [
      { merchantKey: '瑞幸咖啡', categoryId: 'cat-new' },
      { merchantKey: '瑞幸 咖啡', categoryId: 'cat-old' },
    ];
    const r = findCorrectionMatches(cs, '瑞幸咖啡');
    expect(r).toEqual([{ merchantKey: '瑞幸咖啡', categoryId: 'cat-new' }]);
  });
});

describe('matchCorrectionsInText', () => {
  const corrections = [
    { merchantKey: '瑞幸咖啡', categoryId: 'cat-coffee' },
    { merchantKey: '滴滴出行', categoryId: 'cat-didi' },
    { merchantKey: '国家电网', categoryId: 'cat-power' },
  ];

  it('流水文本里出现的纠正 key 被选中，未出现的不选', () => {
    const text = '2026-07-01 瑞幸咖啡 消费 32.50\n2026-07-02 滴滴出行 消费 18.00';
    const r = matchCorrectionsInText(corrections, text);
    expect(r.map((c) => c.categoryId)).toEqual(['cat-coffee', 'cat-didi']);
  });

  it('空白/大小写差异不影响文本匹配', () => {
    const r = matchCorrectionsInText(
      [{ merchantKey: 'luckin coffee', categoryId: 'cat-luckin' }],
      '商户:LUCKINCOFFEE 金额 25',
    );
    expect(r).toHaveLength(1);
  });

  it('空文本返回空', () => {
    expect(matchCorrectionsInText(corrections, '')).toEqual([]);
  });

  it('超过上限截断', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      merchantKey: `商户${i}`,
      categoryId: `cat-${i}`,
    }));
    const text = many.map((c) => c.merchantKey).join(' ');
    expect(matchCorrectionsInText(many, text)).toHaveLength(
      MAX_FEWSHOT_CORRECTIONS,
    );
  });
});

describe('buildFewShotLines', () => {
  it('格式化为「商户 → 分类（用户历史纠正）」', () => {
    const lines = buildFewShotLines(
      [{ merchantKey: '瑞幸咖啡', categoryId: 'cat-coffee' }],
      (id) => (id === 'cat-coffee' ? '餐饮>咖啡' : id),
    );
    expect(lines).toEqual(['- 瑞幸咖啡 → 餐饮>咖啡（用户历史纠正）']);
  });
});
