import { shouldTouchLastActive } from './activity';

describe('shouldTouchLastActive', () => {
  const now = new Date('2026-08-18T12:00:00.000Z');

  it('updates users that have never been active', () => {
    expect(shouldTouchLastActive(null, now)).toBe(true);
  });

  it('does not update again within five minutes', () => {
    expect(shouldTouchLastActive(new Date('2026-08-18T11:56:00.000Z'), now)).toBe(false);
  });

  it('updates after five minutes', () => {
    expect(shouldTouchLastActive(new Date('2026-08-18T11:55:00.000Z'), now)).toBe(true);
  });
});
