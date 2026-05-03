import express from 'express';
import { BaseAgent } from './base-agent.js';
import { MCPServiceDef, GoalInjection } from '../types/agent.js';
import { PRContext } from '../types/review.js';
import { GOSSIP_TOPICS } from '../axl/gossipsub.js';
import { ReviewPipeline } from '../review/pipeline.js';
import { GitHubClient } from '../integrations/github.js';
import { OfflineQueue } from '../offline/queue.js';
import { SyncEngine } from '../offline/sync.js';
import { ConnectivityDetector } from '../offline/detector.js';
import type { AgentSnapshot } from '../dashboard/server.js';
import {
  startDashboardServer,
  emitMeshEvent,
  registerGoalHandler,
  registerTeeProviderLister,
  registerTriggerReviewHandler,
  registerOfflineModeHandler,
  registerAgentSnapshotProvider,
} from '../dashboard/server.js';
import { config, AgentRole } from '../config.js';
import { logger } from '../utils/logger.js';

export class GatewayAgent extends BaseAgent {
  private pipeline!: ReviewPipeline;
  private github: GitHubClient;
  private queue: OfflineQueue;
  private syncEngine!: SyncEngine;
  private detector: ConnectivityDetector;
  private webhookServer: express.Application;
  private activePRs: Set<number> = new Set();

  constructor() {
    super('gateway');
    this.github = new GitHubClient();
    this.queue = new OfflineQueue();
    this.detector = new ConnectivityDetector();
    this.webhookServer = express();
  }

  getSystemPrompt(): string {
    return `You are ADVERSA-GATEWAY — the orchestration coordinator for an adversarial code review swarm. You manage workflows, route requests, and ensure consensus is reached.`;
  }

  protected async onStart(): Promise<void> {
    // Start dashboard server
    await startDashboardServer();

    // Register TEE provider lister so the dashboard can show available TeeML services
    registerTeeProviderLister(() => this.ogCompute.listTeeProviders());

    // Wire the dashboard "Review" button to the actual pipeline
    registerTriggerReviewHandler((owner, repo, prNumber) =>
      this.processPR(owner, repo, prNumber)
    );

    // Register goal injection handler for the dashboard API
    registerGoalHandler(async (goal, source) => {
      const injection: GoalInjection = {
        goal,
        source: source as GoalInjection['source'],
        priority: 'medium',
        timestamp: Date.now(),
        requestId: crypto.randomUUID(),
      };
      await this.gossip.publish(GOSSIP_TOPICS.GOALS, injection as unknown as Record<string, unknown>);
      logger.info('Goal injected from dashboard', { goal: goal.slice(0, 50), source });
      emitMeshEvent('gossip-broadcast', { topic: 'adversa:goals', goal, source });
    });

    // Initialize sync engine
    this.syncEngine = new SyncEngine(this.queue, this.detector);

    registerOfflineModeHandler(enabled => this.detector.setForcedOffline(enabled));
    registerAgentSnapshotProvider(async () => {
      const topo = await this.axl.getTopology().catch(err => {
        logger.warn('Failed to refresh agent snapshot from AXL topology', { err });
        return { peers: [] };
      });

      const agents: AgentSnapshot[] = [
        {
          peerId: this.peerId || `${this.role}-local`,
          role: this.role,
          online: true,
          status: this.currentStatus,
          reputationScore: this.reputationScore,
        },
      ];

      for (const peer of topo.peers ?? []) {
        agents.push({
          peerId: peer.peerId,
          role: (peer.agentRole ?? 'gateway') as AgentRole,
          address: peer.address,
          online: peer.online,
          status: 'idle',
          reputationScore: 0,
        });
      }

      return agents;
    });

    this.pipeline = new ReviewPipeline(
      this.axl,
      this.topology,
      this.gossip,
      this.syncEngine
    );
    await this.pipeline.initialize();

    // Start connectivity monitoring
    this.detector.startMonitoring();

    // Subscribe to PR-opened broadcasts from coder agent
    this.gossip.subscribe(GOSSIP_TOPICS.PR_OPENED, async (from, data) => {
      const d = data as { prNumber?: number; repoOwner?: string; repoName?: string };
      if (d.prNumber && d.repoOwner && d.repoName) {
        logger.info('PR opened broadcast received', { prNumber: d.prNumber });
        await this.processPR(d.repoOwner, d.repoName, d.prNumber);
      }
    });

    // Subscribe to critical vuln broadcasts — halt auto-merge
    this.gossip.subscribe(GOSSIP_TOPICS.CRITICAL_VULN, async (from, data) => {
      const d = data as { prId?: number; exploit?: { title: string } };
      logger.error('CRITICAL VULNERABILITY BROADCAST', { prId: d.prId, exploit: d.exploit?.title });
      emitMeshEvent('human-detected', {
        reason: 'Critical vulnerability detected',
        exploit: d.exploit,
        prId: d.prId,
      });
    });

    // Start GitHub webhook server
    this.startWebhookServer();

    logger.info('Gateway agent ready', { peerId: (this.peerId || '').slice(0, 12) });
  }

  private startWebhookServer(): void {
    // Use raw body for webhook route so HMAC is computed over original bytes
    this.webhookServer.post('/webhook/github', express.raw({ type: 'application/json' }), async (req, res) => {
      const signature = req.headers['x-hub-signature-256'] as string ?? '';
      const rawBody = req.body as Buffer;

      if (!this.github.verifyWebhookSignature(rawBody.toString('utf8'), signature)) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      req.body = JSON.parse(rawBody.toString('utf8'));

      const event = req.headers['x-github-event'] as string;
      const payload = req.body as {
        action?: string;
        pull_request?: { number: number; head: { repo: { full_name: string } } };
      };

      // Webhook events are acknowledged but NOT auto-processed.
      // Reviews are triggered manually from the dashboard trigger button only.
      if (event === 'pull_request') {
        const prNumber = payload.pull_request?.number;
        logger.info('GitHub webhook received — awaiting manual trigger', { action: payload.action, prNumber });
        res.json({ status: 'acknowledged', message: 'manual trigger required', prNumber });
        return;
      }

      res.json({ status: 'ignored', event });
    });

    const port = parseInt(process.env.WEBHOOK_PORT ?? '3002');
    this.webhookServer.listen(port, () => {
      logger.info('GitHub webhook server started', { port, path: '/webhook/github' });
    });
  }

  private async processPR(owner: string, repo: string, prNumber: number): Promise<void> {
    if (this.activePRs.has(prNumber)) {
      logger.debug('PR already being processed', { prNumber });
      return;
    }
    this.activePRs.add(prNumber);

    try {
      logger.info('Processing PR', { owner, repo, prNumber });
      emitMeshEvent('pipeline-start', { prNumber, owner, repo });

      // Fetch PR context
      const pr: PRContext = await this.github.getPRContext(owner, repo, prNumber);

      // Broadcast PR opened to all agents
      await this.gossip.publish(GOSSIP_TOPICS.PR_OPENED, {
        prNumber,
        prHash: pr.prHash,
        title: pr.title,
        author: pr.author,
        repoOwner: owner,
        repoName: repo,
        from: this.peerId,
        timestamp: Date.now(),
      });

      // Run the full review pipeline
      const result = await this.pipeline.run(pr);

      logger.info('PR review complete', {
        prNumber,
        approved: result.consensus.approved,
        confidence: `${(result.consensus.confidenceScore / 100).toFixed(1)}%`,
        githubAction: result.githubAction,
        txHash: result.txHash,
      });

      emitMeshEvent('pipeline-complete', {
        prNumber,
        approved: result.consensus.approved,
        confidenceScore: result.consensus.confidenceScore,
        githubAction: result.githubAction,
        txHash: result.txHash,
        txUrl: result.txUrl,
        storageRoot: result.storageRoot,
        exploitsFound: result.consensus.exploitsFound.length,
        exploitsMitigated: result.consensus.exploitsMitigated,
        blockingIssues: result.consensus.blockingIssues.map(f => ({
          title: f.title,
          severity: f.severity,
          description: f.description,
        })),
        rejectionReason: !result.consensus.approved
          ? (result.consensus.blockingIssues.length > 0
              ? result.consensus.blockingIssues.map(f => f.title).join('; ')
              : 'Consensus threshold not met')
          : undefined,
      });

    } catch (err) {
      logger.error('Pipeline error', { prNumber, err });
      emitMeshEvent('pipeline-error', { prNumber, error: String(err) });
    } finally {
      this.activePRs.delete(prNumber);
    }
  }

  getMCPServices(): MCPServiceDef[] {
    return [
      {
        name: 'trigger-review',
        description: 'Trigger a review pipeline for a GitHub PR',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string' },
            repo: { type: 'string' },
            prNumber: { type: 'number' },
          },
          required: ['owner', 'repo', 'prNumber'],
        },
        outputSchema: {
          type: 'object',
          properties: { status: { type: 'string' } },
        },
      },
      {
        name: 'keeperhub',
        description: 'Route KeeperHub workflow calls to other agents on the mesh',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      },
    ];
  }

  async handleMCPCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'trigger-review') {
      const { owner, repo, prNumber } = params;
      this.processPR(String(owner), String(repo), Number(prNumber))
        .catch(err => logger.error('MCP trigger-review error', { err }));
      return { status: 'started', prNumber };
    }
    throw new Error(`GatewayAgent: unknown method ${method}`);
  }

  async handleA2ACall(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { type: 'ack', peerId: this.peerId, role: 'gateway' };
  }
}
