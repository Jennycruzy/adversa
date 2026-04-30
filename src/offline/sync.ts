import { OfflineQueue, QueuedAction } from './queue.js';
import { ConnectivityDetector } from './detector.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';

type ActionExecutor = (action: QueuedAction) => Promise<void>;

export class SyncEngine {
  private executors: Map<string, ActionExecutor> = new Map();
  private draining = false;

  constructor(
    private readonly queue: OfflineQueue,
    private readonly detector: ConnectivityDetector
  ) {
    // When connectivity restores, auto-drain
    detector.onStatusChange(async (online) => {
      if (online && this.queue.length() > 0) {
        logger.info('Connectivity restored — draining offline queue', { count: this.queue.length() });
        await this.drain();
      }
    });
  }

  registerExecutor(actionType: string, executor: ActionExecutor): void {
    this.executors.set(actionType, executor);
  }

  async executeOrQueue(
    type: Parameters<OfflineQueue['enqueue']>[0],
    payload: Record<string, unknown>,
    maxRetries?: number
  ): Promise<'executed' | 'queued'> {
    if (this.detector.isOnline()) {
      // Execute immediately
      const action: QueuedAction = {
        id: crypto.randomUUID(),
        type,
        payload,
        timestamp: Date.now(),
        retries: 0,
        maxRetries: maxRetries ?? 5,
      };
      try {
        await this.executeAction(action);
        return 'executed';
      } catch (err) {
        logger.warn('Immediate execution failed, queuing', { type, err });
        this.queue.enqueue(type, payload, maxRetries);
        return 'queued';
      }
    } else {
      this.queue.enqueue(type, payload, maxRetries);
      return 'queued';
    }
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    const total = this.queue.length();
    let completed = 0;

    logger.info('Starting sync drain', { total });
    emitMeshEvent('sync-started', { total });

    while (this.queue.length() > 0 && this.detector.isOnline()) {
      const action = this.queue.peek();
      if (!action) break;

      emitMeshEvent('action-replaying', {
        action: action.type,
        id: action.id,
        remaining: this.queue.length(),
      });

      try {
        await this.executeAction(action);
        this.queue.markComplete(action.id);
        completed++;
        logger.info('Synced queued action', {
          type: action.type,
          completed,
          remaining: this.queue.length(),
        });
        emitMeshEvent('action-synced', {
          type: action.type,
          completed,
          remaining: this.queue.length(),
          total,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to sync action', { type: action.type, id: action.id, err });
        this.queue.markFailed(action.id, errMsg);
        // Small delay before retrying next item
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    this.draining = false;
    emitMeshEvent('sync-complete', { completed, remaining: this.queue.length(), timestamp: Date.now() });
    logger.info('Sync drain complete', { completed, remaining: this.queue.length() });
  }

  private async executeAction(action: QueuedAction): Promise<void> {
    const executor = this.executors.get(action.type);
    if (!executor) {
      throw new Error(`No executor registered for action type: ${action.type}`);
    }
    await executor(action);
  }
}
