const ACTIVE_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export function shouldTouchLastActive(lastActiveAt: Date | null, now = new Date()): boolean {
  return !lastActiveAt || now.getTime() - lastActiveAt.getTime() >= ACTIVE_WRITE_INTERVAL_MS;
}
