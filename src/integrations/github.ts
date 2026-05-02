import { Octokit } from '@octokit/rest';
import { createHmac } from 'crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { PRContext, PRFile, ConsensusResult, ReviewFinding } from '../types/review.js';

export class GitHubClient {
  private octokit: Octokit;

  constructor() {
    this.octokit = new Octokit({
      auth: config.github.token,
      userAgent: 'ADVERSA/1.0.0',
    });
  }

  // ─── Webhook verification ─────────────────────────────────────────────────────

  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!config.github.webhookSecret) return true; // Skip in dev
    const expected = 'sha256=' + createHmac('sha256', config.github.webhookSecret)
      .update(payload)
      .digest('hex');
    return signature === expected;
  }

  // ─── PR data fetching ─────────────────────────────────────────────────────────

  async getPRContext(owner: string, repo: string, prNumber: number): Promise<PRContext> {
    const [pr, files, diff] = await Promise.all([
      this.octokit.pulls.get({ owner, repo, pull_number: prNumber }),
      this.octokit.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100 }),
      this.octokit.pulls.get({
        owner, repo, pull_number: prNumber,
        mediaType: { format: 'diff' },
      }),
    ]);

    const prFiles: PRFile[] = files.data.map(f => ({
      filename: f.filename,
      status: f.status as PRFile['status'],
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
      language: this.detectLanguage(f.filename),
    }));

    const diffText = typeof diff.data === 'string' ? diff.data : JSON.stringify(diff.data);
    const prHash = createHmac('sha256', 'adversa-pr')
      .update(`${owner}/${repo}#${prNumber}@${pr.data.head.sha}`)
      .digest('hex');

    return {
      id: pr.data.id,
      number: pr.data.number,
      title: pr.data.title,
      body: pr.data.body ?? '',
      diff: diffText,
      files: prFiles,
      author: pr.data.user?.login ?? 'unknown',
      branch: pr.data.head.ref,
      baseBranch: pr.data.base.ref,
      repoOwner: owner,
      repoName: repo,
      prHash,
      headSha: pr.data.head.sha,
      url: pr.data.html_url,
    };
  }

  // ─── PR actions ───────────────────────────────────────────────────────────────

  async postReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<void> {
    await this.octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
    logger.info('Posted PR comment', { owner, repo, prNumber });
  }

  async postInlineComments(
    owner: string,
    repo: string,
    prNumber: number,
    commitSha: string,
    findings: ReviewFinding[]
  ): Promise<void> {
    // GitHub review with inline comments
    const comments = findings
      .filter(f => f.location.file && f.location.startLine > 0)
      .slice(0, 30) // GitHub limit
      .map(f => ({
        path: f.location.file,
        line: f.location.endLine || f.location.startLine,
        side: 'RIGHT' as const,
        body: this.formatFinding(f),
      }));

    if (comments.length === 0) return;

    await this.octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event: 'COMMENT',
      comments,
      body: `ADVERSA found ${findings.length} issue(s) across ${new Set(findings.map(f => f.category)).size} categories.`,
    });

    logger.info('Posted inline review comments', { count: comments.length, owner, repo, prNumber });
  }

  async requestChanges(
    owner: string,
    repo: string,
    prNumber: number,
    commitSha: string,
    findings: ReviewFinding[],
    body: string
  ): Promise<void> {
    // Use COMMENT event — REQUEST_CHANGES is blocked when reviewer == PR author,
    // which is the case when the bot token belongs to the repo owner.
    const inlineComments = findings
      .filter(f => ['critical', 'high'].includes(f.severity) && f.location.file && (f.location.endLine || f.location.startLine) > 0)
      .slice(0, 20)
      .map(f => ({
        path: f.location.file,
        line: f.location.endLine || f.location.startLine,
        side: 'RIGHT' as const,
        body: this.formatFinding(f),
      }));

    await this.octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event: 'COMMENT',
      body,
      comments: inlineComments,
    });
    logger.info('Posted review comment on PR', { owner, repo, prNumber, inlineCount: inlineComments.length });
  }

  async approvePR(
    owner: string,
    repo: string,
    prNumber: number,
    commitSha: string,
    summary: string
  ): Promise<void> {
    await this.octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event: 'APPROVE',
      body: summary,
    });
    logger.info('Approved PR', { owner, repo, prNumber });
  }

  async closePR(
    owner: string,
    repo: string,
    prNumber: number,
    comment: string
  ): Promise<void> {
    // Post the rejection comment first so it appears before the close event
    await this.octokit.issues.createComment({ owner, repo, issue_number: prNumber, body: comment });
    await this.octokit.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' });
    logger.info('Closed PR', { owner, repo, prNumber });
  }

  async mergePR(
    owner: string,
    repo: string,
    prNumber: number,
    commitMessage: string
  ): Promise<void> {
    await this.octokit.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      commit_message: commitMessage,
      merge_method: 'squash',
    });
    logger.info('Merged PR', { owner, repo, prNumber });
  }

  async createPR(
    owner: string,
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string
  ): Promise<{ number: number; url: string; sha: string }> {
    const response = await this.octokit.pulls.create({
      owner, repo, title, body, head, base, draft: false,
    });
    logger.info('Created PR', { number: response.data.number, url: response.data.html_url });
    return {
      number: response.data.number,
      url: response.data.html_url,
      sha: response.data.head.sha,
    };
  }

  async createBranch(owner: string, repo: string, branchName: string, fromSha: string): Promise<void> {
    await this.octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: fromSha,
    });
  }

  async getDefaultBranchSha(owner: string, repo: string): Promise<{ sha: string; branch: string }> {
    const repoData = await this.octokit.repos.get({ owner, repo });
    const branch = repoData.data.default_branch;
    const ref = await this.octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return { sha: ref.data.object.sha, branch };
  }

  async createOrUpdateFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    branch: string,
    sha?: string
  ): Promise<void> {
    await this.octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      sha,
    });
  }

  // ─── Formatting helpers ───────────────────────────────────────────────────────

  private formatFinding(f: ReviewFinding): string {
    const severityEmoji: Record<string, string> = {
      critical: '🚨', high: '🔴', medium: '🟡', low: '🔵', info: 'ℹ️',
    };
    return [
      `${severityEmoji[f.severity] ?? '⚠️'} **[${f.severity.toUpperCase()}] ${f.title}**`,
      '',
      f.description,
      '',
      `**Recommendation:** ${f.recommendation}`,
      f.cweId ? `**CWE:** ${f.cweId}` : '',
      f.cvssScore ? `**CVSS:** ${f.cvssScore.toFixed(1)}` : '',
      f.teeProof ? `**TEE Proof:** \`${f.teeProof.slice(0, 20)}...\`` : '',
    ].filter(Boolean).join('\n');
  }

  formatReviewBody(findings: ReviewFinding[], summary: string, approved: boolean): string {
    const header = approved
      ? '## ✅ ADVERSA Review: APPROVED\n\n'
      : '## ❌ ADVERSA Review: CHANGES REQUESTED\n\n';

    const bySeverity = ['critical', 'high', 'medium', 'low', 'info'].map(sev => {
      const items = findings.filter(f => f.severity === sev);
      if (items.length === 0) return '';
      return `### ${sev.toUpperCase()} (${items.length})\n${items.map(f => `- **${f.title}** — ${f.location.file}:${f.location.startLine}`).join('\n')}`;
    }).filter(Boolean).join('\n\n');

    return `${header}${summary}\n\n${bySeverity}\n\n*Powered by ADVERSA — Adversarial AI Code Review Swarm on AXL Mesh*`;
  }

  private detectLanguage(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', rs: 'rust', go: 'go', sol: 'solidity', java: 'java',
      rb: 'ruby', php: 'php', cs: 'csharp', cpp: 'cpp', c: 'c',
    };
    return map[ext] ?? 'unknown';
  }
}
