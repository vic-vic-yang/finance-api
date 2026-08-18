import { Injectable, InternalServerErrorException } from '@nestjs/common';

type WorkflowRun = {
  id: number;
  display_title: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
};

@Injectable()
export class GithubActionsClient {
  private readonly owner = process.env.GITHUB_RELEASE_OWNER || 'vic-vic-yang';
  private readonly repo = process.env.GITHUB_RELEASE_REPO || 'finance-app';
  private readonly workflow = process.env.GITHUB_RELEASE_WORKFLOW || 'release.yml';
  private readonly branch = process.env.GITHUB_RELEASE_BRANCH || 'main';

  async dispatch(input: {
    jobId: string;
    notes: string;
    versionBump: string;
    releaseType: string;
    version: string;
    buildNumber: number;
  }) {
    await this.request(`/actions/workflows/${this.workflow}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({
        ref: this.branch,
        inputs: {
          job_id: input.jobId,
          notes: input.notes,
          version_bump: input.versionBump,
          release_type: input.releaseType,
          target_version: input.version,
          build_number: String(input.buildNumber),
        },
      }),
    });
  }

  async findRun(jobId: string, createdAfter: Date): Promise<WorkflowRun | null> {
    const data = await this.request<{ workflow_runs: WorkflowRun[] }>(
      `/actions/workflows/${this.workflow}/runs?event=workflow_dispatch&per_page=30`,
    );
    return (
      data.workflow_runs.find(
        (run) =>
          run.display_title === jobId && new Date(run.created_at).getTime() >= createdAfter.getTime() - 60000,
      ) || null
    );
  }

  private async request<T = void>(path: string, init: RequestInit = {}): Promise<T> {
    const token = process.env.GITHUB_RELEASE_TOKEN;
    if (!token) throw new InternalServerErrorException('未配置 GitHub 发版 Token');
    const response = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    if (!response.ok) {
      const message = await response.text();
      throw new InternalServerErrorException(`GitHub API ${response.status}: ${message.slice(0, 300)}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
