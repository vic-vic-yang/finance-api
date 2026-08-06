import {
  hasChineseText,
  parseEastmoneyChineseName,
  toEastmoneySecid,
} from './stock-name';

describe('stock-name', () => {
  it('把 A 股和港股 Yahoo 代码转成东方财富 secid', () => {
    expect(toEastmoneySecid('601868.SS')).toBe('1.601868');
    expect(toEastmoneySecid('002327.SZ')).toBe('0.002327');
    expect(toEastmoneySecid('0700.HK')).toBe('116.00700');
    expect(toEastmoneySecid('AAPL')).toBeNull();
  });

  it('从东方财富响应提取中文简称', () => {
    expect(
      parseEastmoneyChineseName({ rc: 0, data: { f58: '中国能建' } }),
    ).toBe('中国能建');
    expect(
      parseEastmoneyChineseName({ rc: 0, data: { f58: ' 医疗ETF ' } }),
    ).toBe('医疗ETF');
  });

  it('拒绝空值、占位符和纯英文名称', () => {
    expect(parseEastmoneyChineseName({ data: { f58: '-' } })).toBeNull();
    expect(parseEastmoneyChineseName({ data: { f58: 'Tencent' } })).toBeNull();
    expect(parseEastmoneyChineseName({ data: null })).toBeNull();
  });

  it('识别中文文本', () => {
    expect(hasChineseText('中国能建')).toBe(true);
    expect(hasChineseText('医疗ETF')).toBe(true);
    expect(hasChineseText('China Energy')).toBe(false);
  });
});
