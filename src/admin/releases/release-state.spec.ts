import { bumpVersion, isActiveRelease, mapGitHubStatus } from './release-state';

describe('release state helpers', () => {
  it.each([
    ['patch', '1.2.3', '1.2.4'],
    ['minor', '1.2.3', '1.3.0'],
    ['major', '1.2.3', '2.0.0'],
  ] as const)('bumps %s versions', (bump, current, expected) => {
    expect(bumpVersion(current, bump)).toBe(expected);
  });

  it('maps GitHub workflow states', () => {
    expect(mapGitHubStatus('queued', null)).toBe('queued');
    expect(mapGitHubStatus('in_progress', null)).toBe('building');
    expect(mapGitHubStatus('completed', 'success')).toBe('succeeded');
    expect(mapGitHubStatus('completed', 'failure')).toBe('failed');
    expect(mapGitHubStatus('completed', 'cancelled')).toBe('failed');
  });

  it('only treats unfinished releases as active', () => {
    expect(isActiveRelease('queued')).toBe(true);
    expect(isActiveRelease('building')).toBe(true);
    expect(isActiveRelease('uploading')).toBe(true);
    expect(isActiveRelease('succeeded')).toBe(false);
    expect(isActiveRelease('failed')).toBe(false);
  });
});
