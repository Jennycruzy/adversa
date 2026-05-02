import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';

export type QueuedActionType =
  | 'github-merge'
  | 'github-comment'
  | 'github-request-changes'
  | 'github-close-pr'
  | 'github-approve-pr'
  | 'og-storage-upload'
  | 'og-chain-record-review'
  | 'og-chain-update-reputation'
  | 'og-chain-evolve-inft'
  | 'keeperhub-workflow';

export interface QueuedAction {
  id: string;
  type: QueuedActionType;
  payload: Record<string, unknown>;
  timestamp: number;
  retries: number;
  maxRetries: number;
  lastError?: string;
}

export class OfflineQueue {
  private queue: QueuedAction[] = [];
  private readonly queuePath: string;

  constructor() {
    this.queuePath = config.offline.queuePath;
    this.load();
  }

  enqueue(
    type: QueuedActionType,
    payload: Record<string, unknown>,
    maxRetries: number = 5
  ): QueuedAction {
    const action: QueuedAction = {
      id: crypto.randomUUID(),
      type,
      payload,
      timestamp: Date.now(),
      retries: 0,
      maxRetries,
    };
    this.queue.push(action);
    this.persist();
    emitMeshEvent('action-queued', { queueLength: this.queue.length, actionType: type, id: action.id });
    logger.info('Action queued (offline)', { type, id: action.id, queueLength: this.queue.length });
    return action;
  }

  dequeue(): QueuedAction | undefined {
    return this.queue.shift();
  }

  peek(): QueuedAction | undefined {
    return this.queue[0];
  }

  length(): number {
    return this.queue.length;
  }

  getAll(): QueuedAction[] {
    return [...this.queue];
  }

  markFailed(id: string, error: string): void {
    const action = this.queue.find(a => a.id === id);
    if (!action) return;
    action.retries++;
    action.lastError = error;
    if (action.retries >= action.maxRetries) {
      logger.error('Action permanently failed, removing from queue', { id, type: action.type, error });
      this.queue = this.queue.filter(a => a.id !== id);
    }
    this.persist();
  }

  markComplete(id: string): void {
    this.queue = this.queue.filter(a => a.id !== id);
    this.persist();
    emitMeshEvent('action-completed', {
      id,
      queueLength: this.queue.length,
    });
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.queuePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.queuePath, JSON.stringify(this.queue, null, 2), 'utf8');
    } catch (err) {
      logger.error('Failed to persist offline queue', { err });
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.queuePath)) {
        const data = fs.readFileSync(this.queuePath, 'utf8');
        const loaded = JSON.parse(data) as QueuedAction[];
        this.queue = loaded;
        if (this.queue.length > 0) {
          logger.info('Loaded offline queue from disk', { count: this.queue.length });
          emitMeshEvent('queue-loaded', { count: this.queue.length, items: this.queue.map(a => a.type) });
        }
      }
    } catch (err) {
      logger.warn('Failed to load offline queue', { err });
      this.queue = [];
    }
  }
}
