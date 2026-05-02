import { AXLClient } from './client.js';
import { PeerInfo, AgentRole } from '../types/agent.js';
import { logger } from '../utils/logger.js';

type TopologyChangeHandler = (added: PeerInfo[], removed: PeerInfo[]) => void | Promise<void>;

export class TopologyManager {
  private peers: Map<string, PeerInfo> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private changeHandlers: TopologyChangeHandler[] = [];
  private eventEmitter?: (event: string, data: Record<string, unknown>) => void;

  constructor(private readonly axl: AXLClient) {}

  setEventEmitter(fn: (event: string, data: Record<string, unknown>) => void): void {
    this.eventEmitter = fn;
  }

  private emit(event: string, data: Record<string, unknown>): void {
    this.eventEmitter?.(event, data);
  }

  async refresh(): Promise<void> {
    const topo = await this.axl.getTopology();
    const newOnlineIds = new Set(
      topo.peers.filter(p => p.online).map(p => p.peerId)
    );
    const oldPeerIds = new Set(this.peers.keys());

    const added: PeerInfo[] = [];
    const removed: PeerInfo[] = [];

    // Process current topology
    for (const peer of topo.peers) {
      const info: PeerInfo = {
        peerId: peer.peerId,
        role: (peer.agentRole ?? 'gateway') as AgentRole,
        address: peer.address,
        online: peer.online,
        lastSeen: Date.now(),
        services: peer.services,
      };

      if (peer.online && !oldPeerIds.has(peer.peerId)) {
        added.push(info);
        this.emit('agent-online', { peerId: peer.peerId, role: peer.agentRole, address: peer.address });
        logger.info('Peer joined mesh', { peerId: peer.peerId.slice(0, 12), role: peer.agentRole });
      }

      if (peer.online) {
        this.peers.set(peer.peerId, info);
      } else if (this.peers.has(peer.peerId)) {
        const existing = this.peers.get(peer.peerId)!;
        this.peers.set(peer.peerId, { ...existing, online: false });
      }
    }

    // Detect gone peers
    for (const oldId of oldPeerIds) {
      if (!newOnlineIds.has(oldId)) {
        const peer = this.peers.get(oldId);
        if (peer?.online) {
          removed.push(peer);
          this.peers.set(oldId, { ...peer, online: false });
          this.emit('agent-offline', { peerId: oldId, role: peer.role });
          logger.info('Peer left mesh', { peerId: oldId.slice(0, 12), role: peer.role });
        }
      }
    }

    if (added.length > 0 || removed.length > 0) {
      for (const handler of this.changeHandlers) {
        try {
          await handler(added, removed);
        } catch (err) {
          logger.error('Topology change handler error', { err });
        }
      }
    }
  }

  onTopologyChange(handler: TopologyChangeHandler): void {
    this.changeHandlers.push(handler);
  }

  getPeersByRole(role: AgentRole): PeerInfo[] {
    return Array.from(this.peers.values()).filter(p => p.role === role && p.online);
  }

  updatePeerRole(peerId: string, role: AgentRole): void {
    const peer = this.peers.get(peerId);
    if (!peer || peer.role === role) return;
    this.peers.set(peerId, { ...peer, role });
    this.emit('agent-online', { peerId, role, address: peer.address });
    logger.info('Peer role learned from heartbeat', { peerId: peerId.slice(0, 12), role });
  }

  getOnlinePeers(): PeerInfo[] {
    return Array.from(this.peers.values()).filter(p => p.online);
  }

  getPeer(peerId: string): PeerInfo | undefined {
    return this.peers.get(peerId);
  }

  getAllPeers(): Map<string, PeerInfo> {
    return this.peers;
  }

  startPolling(intervalMs: number = 5000): void {
    this.refresh().catch(err => logger.debug('Initial topology refresh failed', { err }));
    this.pollInterval = setInterval(() => {
      this.refresh().catch(err => logger.debug('Topology refresh error', { err }));
    }, intervalMs);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}
