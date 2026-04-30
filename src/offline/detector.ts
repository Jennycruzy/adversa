import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';

type ConnectivityHandler = (online: boolean) => void | Promise<void>;

export class ConnectivityDetector {
  private online: boolean = true;
  private checkInterval: NodeJS.Timeout | null = null;
  private handlers: ConnectivityHandler[] = [];
  private checkTargets = [
    config.og.rpcUrl,
    'https://api.github.com',
  ];

  onStatusChange(handler: ConnectivityHandler): void {
    this.handlers.push(handler);
  }

  isOnline(): boolean {
    return this.online;
  }

  async check(): Promise<boolean> {
    let reachable = false;
    for (const url of this.checkTargets) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeout);
        reachable = true;
        break;
      } catch {
        // Continue to next target
      }
    }

    const wasOnline = this.online;
    this.online = reachable;

    if (wasOnline !== this.online) {
      logger.info('Connectivity status changed', { online: this.online });
      emitMeshEvent('offline-status', { online: this.online });
      for (const handler of this.handlers) {
        try {
          await handler(this.online);
        } catch (err) {
          logger.error('Connectivity handler error', { err });
        }
      }
    }

    return this.online;
  }

  startMonitoring(): void {
    this.check().catch(() => {}); // Initial check
    this.checkInterval = setInterval(
      () => this.check().catch(() => {}),
      config.offline.connectivityCheckIntervalMs
    );
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}
