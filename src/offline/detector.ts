import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';

type ConnectivityHandler = (online: boolean) => void | Promise<void>;

export class ConnectivityDetector {
  private online: boolean = true;
  private forcedOffline: boolean = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private handlers: ConnectivityHandler[] = [];
  private checkTargets = [
    config.og.rpcUrl,
    'https://api.github.com',
  ].filter((u): u is string => Boolean(u));

  onStatusChange(handler: ConnectivityHandler): void {
    this.handlers.push(handler);
  }

  isOnline(): boolean {
    return this.online && !this.forcedOffline;
  }

  async setForcedOffline(enabled: boolean): Promise<void> {
    const wasOnline = this.isOnline();
    this.forcedOffline = enabled;
    const nowOnline = this.isOnline();

    if (wasOnline !== nowOnline) {
      logger.info('Demo offline mode changed connectivity status', { online: nowOnline });
      emitMeshEvent('offline-status', { online: nowOnline });
      for (const handler of this.handlers) {
        try {
          await handler(nowOnline);
        } catch (err) {
          logger.error('Connectivity handler error', { err });
        }
      }
    }
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

    const wasEffectiveOnline = wasOnline && !this.forcedOffline;
    const effectiveOnline = this.isOnline();

    if (wasEffectiveOnline !== effectiveOnline) {
      logger.info('Connectivity status changed', { online: effectiveOnline });
      emitMeshEvent('offline-status', { online: effectiveOnline });
      for (const handler of this.handlers) {
        try {
          await handler(effectiveOnline);
        } catch (err) {
          logger.error('Connectivity handler error', { err });
        }
      }
    }

    return effectiveOnline;
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
