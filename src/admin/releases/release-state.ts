export type ReleaseStatus = 'queued' | 'building' | 'uploading' | 'succeeded' | 'failed';
export type VersionBump = 'patch' | 'minor' | 'major';

export function bumpVersion(current: string, bump: VersionBump): string {
  const [major = 0, minor = 0, patch = 0] = current.split('.').map((part) => Number(part) || 0);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function mapGitHubStatus(status: string, conclusion: string | null): ReleaseStatus {
  if (status === 'queued' || status === 'waiting' || status === 'requested') return 'queued';
  if (status !== 'completed') return 'building';
  return conclusion === 'success' ? 'succeeded' : 'failed';
}

export function isActiveRelease(status: ReleaseStatus): boolean {
  return status === 'queued' || status === 'building' || status === 'uploading';
}
