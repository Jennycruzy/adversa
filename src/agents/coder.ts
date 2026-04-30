import { BaseAgent } from './base-agent.js';
import { MCPServiceDef, GoalInjection } from '../types/agent.js';
import { PRContext } from '../types/review.js';
import { GOSSIP_TOPICS } from '../axl/gossipsub.js';
import { GitHubClient } from '../integrations/github.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';

export class CoderAgent extends BaseAgent {
  private github: GitHubClient;
  private goalQueue: GoalInjection[] = [];

  constructor() {
    super('coder');
    this.github = new GitHubClient();
  }

  getSystemPrompt(): string {
    return `You are ADVERSA-CODE — an expert software engineer who writes clean, secure, performant code.

You receive goals from the swarm and implement them as pull requests.

When implementing code:
1. Write production-quality TypeScript/JavaScript (or whatever language is appropriate)
2. Follow existing patterns in the codebase
3. Include proper error handling
4. Write self-documenting code
5. Consider security implications (input validation, output encoding, auth checks)
6. Consider performance (avoid N+1s, unnecessary loops, missing indexes)
7. Write meaningful commit messages explaining WHY, not what

When defending your code in debate:
1. Explain the design decisions
2. Acknowledge legitimate security concerns
3. Propose fixes for valid issues
4. Argue against false positives with evidence

Response format for code generation:
{
  "files": [
    {
      "path": "relative/path/to/file.ts",
      "content": "full file content",
      "description": "what this file does"
    }
  ],
  "prTitle": "feat: add rate limiting to API endpoints",
  "prBody": "## Summary\\n\\nDetailed explanation...",
  "branchName": "adversa/rate-limiting-1234",
  "commitMessage": "feat: implement rate limiting with sliding window algorithm"
}`;
  }

  protected async onStart(): Promise<void> {
    // Subscribe to goal injection broadcasts
    this.gossip.subscribe(GOSSIP_TOPICS.GOALS, async (from, data) => {
      const goal = data as unknown as GoalInjection;
      logger.info('Received goal via GossipSub', { goal: goal.goal?.slice(0, 50), from: from.slice(0, 12) });
      this.goalQueue.push(goal);
      await this.processNextGoal();
    });

    logger.info('Coder agent ready', { peerId: this.peerId.slice(0, 12) });
  }

  private async processNextGoal(): Promise<void> {
    const goal = this.goalQueue.shift();
    if (!goal || !config.github.repoOwner || !config.github.repoName) return;

    emitMeshEvent('goal-injected', { goal: goal.goal, source: goal.source, timestamp: goal.timestamp });
    this.setStatus('generating');

    try {
      logger.info('Processing goal', { goal: goal.goal.slice(0, 100) });

      // Get default branch info
      const { sha, branch: baseBranch } = await this.github.getDefaultBranchSha(
        config.github.repoOwner,
        config.github.repoName
      );

      // Generate code via 0G Compute
      const { response, teeProof, isValid } = await this.callLLM(
        `Implement this goal as a pull request for the repository ${config.github.repoOwner}/${config.github.repoName}:

GOAL: ${goal.goal}

Analyze what files need to be changed/created and write the implementation.
The base branch is '${baseBranch}'.

Return ONLY valid JSON with the file changes and PR metadata.`
      );

      let implementation: {
        files: Array<{ path: string; content: string; description: string }>;
        prTitle: string;
        prBody: string;
        branchName: string;
        commitMessage: string;
      };

      try {
        const m = response.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('No JSON in response');
        implementation = JSON.parse(m[0]);
        if (!Array.isArray(implementation.files)) throw new Error('No files array');
      } catch (err) {
        logger.error('Failed to parse code generation response', { err });
        this.setStatus('idle');
        return;
      }

      // Create branch
      const branchName = `adversa/${implementation.branchName ?? goal.goal.slice(0, 30).replace(/\s+/g, '-').toLowerCase()}-${Date.now()}`;
      await this.github.createBranch(config.github.repoOwner, config.github.repoName, branchName, sha);

      // Commit files
      for (const file of implementation.files) {
        await this.github.createOrUpdateFile(
          config.github.repoOwner,
          config.github.repoName,
          file.path,
          file.content,
          implementation.commitMessage ?? `feat: ${goal.goal.slice(0, 60)}`,
          branchName
        );
        logger.debug('Committed file', { path: file.path });
      }

      // Open PR
      const pr = await this.github.createPR(
        config.github.repoOwner,
        config.github.repoName,
        implementation.prTitle ?? `feat: ${goal.goal.slice(0, 60)}`,
        [
          implementation.prBody ?? `## Goal\n\n${goal.goal}\n\n## Implementation\n\n${implementation.files.map(f => `- \`${f.path}\`: ${f.description}`).join('\n')}`,
          '',
          `---`,
          `*Generated by ADVERSA Coder Agent — TEE proof: ${isValid ? teeProof?.slice(0, 20) : 'unverified'}*`,
        ].join('\n'),
        branchName,
        baseBranch
      );

      logger.info('PR created by coder agent', { prNumber: pr.number, url: pr.url });

      // Broadcast to swarm
      await this.gossip.publish(GOSSIP_TOPICS.PR_OPENED, {
        prNumber: pr.number,
        url: pr.url,
        sha: pr.sha,
        goal: goal.goal,
        repoOwner: config.github.repoOwner,
        repoName: config.github.repoName,
        timestamp: Date.now(),
        from: this.peerId,
      });

      emitMeshEvent('gossip-broadcast', {
        topic: 'adversa:pr-opened',
        prNumber: pr.number,
        url: pr.url,
        goal: goal.goal,
      });

    } catch (err) {
      logger.error('Failed to process goal', { goal: goal.goal, err });
    } finally {
      this.setStatus('idle');
    }
  }

  getMCPServices(): MCPServiceDef[] {
    return [{
      name: 'generate-code',
      description: 'Generate code for a given goal and open a PR',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What to implement' },
          context: { type: 'object', description: 'Additional context' },
        },
        required: ['goal'],
      },
      outputSchema: {
        type: 'object',
        properties: { prNumber: { type: 'number' }, url: { type: 'string' } },
      },
    }];
  }

  async handleMCPCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'generate-code') {
      const goal: GoalInjection = {
        goal: params['goal'] as string,
        source: 'agent',
        priority: 'medium',
        timestamp: Date.now(),
        requestId: crypto.randomUUID(),
      };
      this.goalQueue.push(goal);
      await this.processNextGoal();
      return { status: 'queued', goal: goal.goal };
    }
    throw new Error(`CoderAgent: unknown method ${method}`);
  }

  async handleA2ACall(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const type = payload['type'] as string;

    if (type === 'revision_request') {
      // Security/review agents can send revision requests back to coder
      const feedback = payload['feedback'] as string;
      const prContext = payload['pr'] as Partial<PRContext>;
      logger.info('Received revision request from review agents', { prId: prContext?.id });

      const goal: GoalInjection = {
        goal: `Revise PR #${prContext?.number} to address: ${feedback}`,
        source: 'agent',
        priority: 'high',
        timestamp: Date.now(),
        requestId: crypto.randomUUID(),
      };
      this.goalQueue.push(goal);
      this.processNextGoal().catch(err => logger.error('Revision processing failed', { err }));

      return { type: 'ack', message: 'Revision request queued', goalId: goal.requestId };
    }

    return { type: 'error', message: 'CoderAgent: unsupported A2A type' };
  }
}
