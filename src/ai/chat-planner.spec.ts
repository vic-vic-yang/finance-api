import { buildPlan, shouldPlan } from './chat-planner';

describe('chat-planner', () => {
  it('复杂财务总览触发 plan', () => {
    expect(shouldPlan('帮我全面看看这个月财务状况怎么样')).toBe(true);
    const plan = buildPlan('帮我全面看看这个月财务状况怎么样');
    expect(plan?.steps.length).toBeGreaterThanOrEqual(2);
    expect(plan?.hint).toContain('getHealthScore');
  });

  it('简单单意图不 plan', () => {
    expect(shouldPlan('预算还剩多少')).toBe(false);
    expect(buildPlan('预算还剩多少')).toBeNull();
  });

  it('风险+周期组合触发 plan', () => {
    expect(shouldPlan('有什么风险，下周固定支出有哪些')).toBe(true);
  });
});
