import { AXLClient } from '../axl/client.js';
import { GossipSub, GOSSIP_TOPICS } from '../axl/gossipsub.js';
import { TopologyManager } from '../axl/topology.js';
import { OGComputeClient, InferenceResult } from '../integrations/og-compute.js';
import { config, AgentRole } from '../config.js';
import { MCPServiceDef, HeartbeatPayload, AgentCard } from '../types/agent.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';

export abstract class BaseAgent {
  protected axl: AXLClient;
  protected gossip: GossipSub;
  protected topology: TopologyManager;
  protected ogCompute: OGComputeClient;
  protected peerId: string = '';
  protected reputationScore: number = 0;
  protected currentStatus: 'idle' | 'reviewing' | 'debating' | 'generating' = 'idle';
  protected inftTokenId?: number;

  constructor(protected readonly role: AgentRole) {
    this.axl = new AXLClient(config.axl.nodePort, config.axl.nodeHost);
    this.gossip = new GossipSub(this.axl);
    this.topology = new TopologyManager(this.axl);
    this.ogCompute = new OGComputeClient();
  }

  async start(): Promise<void> {
    logger.info('Starting agent', { role: this.role });

    this.peerId = await this.axl.initialize();
    logger.info('AXL peer initialized', { peerId: this.peerId.slice(0, 12), role: this.role });

    // Wire up event emitter for topology
    this.topology.setEventEmitter((event, data) => emitMeshEvent(event, data));

    await this.ogCompute.initialize();

    this.topology.startPolling(5000);

    this.subscribeToGossipTopics();
    this.gossip.startListening(2000);

    this.axl.startPolling(1000, msg => this.handleRawMessage(msg));

    this.startHeartbeat();

    await this.onStart();

    logger.info('Agent started', { role: this.role, peerId: this.peerId.slice(0, 12) });
    emitMeshEvent('agent-online', { peerId: this.peerId, role: this.role, status: 'idle' });
  }

  protected abstract onStart(): Promise<void>;
  protected abstract getMCPServices(): MCPServiceDef[];
  protected abstract handleMCPCall(method: string, params: Record<string, unknown>): Promise<unknown>;
  protected abstract handleA2ACall(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  protected abstract getSystemPrompt(): string;

  protected subscribeToGossipTopics(): void {
    this.gossip.subscribe(GOSSIP_TOPICS.HEARTBEAT, (from, data) => {
      if (from !== this.peerId) {
        const hb = data as unknown as HeartbeatPayload;
        logger.debug('Heartbeat from peer', { from: from.slice(0, 12), role: hb.role });
      }
    });
  }

  protected async callLLM(
    userMessage: string,
    systemOverride?: string
  ): Promise<InferenceResult> {
    const systemPrompt = systemOverride ?? this.getSystemPrompt();
    this.setStatus('reviewing');
    try {
      const result = await this.ogCompute.inference(systemPrompt, userMessage);
      if (!result.isValid) {
        logger.warn('TEE inference not verified', {
          role: this.role,
          model: result.model,
          chatId: result.chatId,
        });
      }
      return result;
    } finally {
      this.setStatus('idle');
    }
  }

  protected setStatus(status: 'idle' | 'reviewing' | 'debating' | 'generating'): void {
    this.currentStatus = status;
    emitMeshEvent('agent-status', { peerId: this.peerId, role: this.role, status });
  }

  private startHeartbeat(): void {
    setInterval(async () => {
      const heartbeat: HeartbeatPayload = {
        peerId: this.peerId,
        role: this.role,
        timestamp: Date.now(),
        status: this.currentStatus,
        reputationScore: this.reputationScore,
      };
      try {
        await this.gossip.publish(
          GOSSIP_TOPICS.HEARTBEAT,
          heartbeat as unknown as Record<string, unknown>  // Safe cast for gossip transport
        );
      } catch (err) {
        logger.debug('Heartbeat publish failed', { err });
      }
    }, 15000);
  }

  private handleRawMessage(msg: {
    from: string;
    data: Record<string, unknown>;
    timestamp: number;
    messageId: string;
  }): void {
    const { from, data } = msg;
    const msgType = data['type'] as string;
    const requestId = data['request_id'] as string | undefined;

    if (msgType === 'mcp_call') {
      const method = data['method'] as string;
      const params = data['params'] as Record<string, unknown>;
      this.handleMCPCall(method, params)
        .then(result =>
          this.axl.send(from, { type: 'mcp_response', result, request_id: requestId })
        )
        .catch(err =>
          this.axl.send(from, { type: 'mcp_error', error: String(err), request_id: requestId })
        );
    } else if (msgType === 'a2a_call') {
      const payload = data['payload'] as Record<string, unknown>;
      this.handleA2ACall({ ...payload, from_peer: from, request_id: requestId })
        .then(result =>
          this.axl.send(from, { type: 'a2a_response', ...result, request_id: requestId })
        )
        .catch(err =>
          this.axl.send(from, { type: 'a2a_error', error: String(err), request_id: requestId })
        );
    }
  }

  getAgentCard(): AgentCard {
    return {
      type: 'adversa-agent',
      version: '1.0',
      role: this.role,
      peerId: this.peerId,
      capabilities: this.getMCPServices().map(s => s.name),
      mcpServices: this.getMCPServices(),
      description: `ADVERSA ${this.role} agent — adversarial AI code review swarm`,
    };
  }

  async stop(): Promise<void> {
    this.gossip.stop();
    this.topology.stop();
    this.axl.stopPolling();
    emitMeshEvent('agent-offline', { peerId: this.peerId, role: this.role });
    logger.info('Agent stopped', { role: this.role });
  }
}
