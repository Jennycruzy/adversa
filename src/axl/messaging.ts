import { AXLClient } from './client.js';
import { logger } from '../utils/logger.js';

// Lightweight coordination messages — heartbeats, progress, done signals
export interface CoordinationMessage {
  type: 'heartbeat' | 'progress' | 'done' | 'ack' | 'nack' | 'request';
  from: string;
  payload: Record<string, unknown>;
  timestamp: number;
  requestId?: string;
}

export class Messaging {
  private pendingRequests: Map<string, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  constructor(private readonly axl: AXLClient) {}

  async sendCoordination(peerId: string, msg: Omit<CoordinationMessage, 'from' | 'timestamp'>): Promise<void> {
    await this.axl.send(peerId, {
      ...msg,
      from: this.axl.selfPeerId,
      timestamp: Date.now(),
    });
  }

  // Send and wait for ack/response
  async sendAndWait(
    peerId: string,
    msg: Record<string, unknown>,
    timeoutMs: number = 30000
  ): Promise<Record<string, unknown>> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request ${requestId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      this.axl.send(peerId, { ...msg, request_id: requestId, from: this.axl.selfPeerId })
        .catch(err => {
          clearTimeout(timeout);
          this.pendingRequests.delete(requestId);
          reject(err);
        });
    });
  }

  // Call this from recv handler when a response arrives
  handleResponse(requestId: string, data: Record<string, unknown>): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);
    pending.resolve(data);
    return true;
  }

  async broadcastProgress(topic: string, percentage: number, detail?: string): Promise<void> {
    logger.debug('Progress broadcast', { topic, percentage, detail });
    // Progress goes via send/recv lightweight channel, not gossip
    // In a real deployment, send to all known peers
  }
}
