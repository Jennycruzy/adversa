import { AXLClient } from './client.js';
import { GOSSIP_TOPICS, GossipTopic } from '../types/axl.js';
import { logger } from '../utils/logger.js';

type GossipHandler = (
  from: string,
  data: Record<string, unknown>,
  timestamp: number
) => void | Promise<void>;

export class GossipSub {
  private handlers: Map<string, GossipHandler[]> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  // Deduplicate by from+topic+timestamp fingerprint
  private seenMessages: Set<string> = new Set();
  private seenMessageQueue: string[] = [];
  private readonly maxSeen = 2000;

  constructor(private readonly axl: AXLClient) {}

  subscribe(topic: GossipTopic, handler: GossipHandler): void {
    const existing = this.handlers.get(topic) ?? [];
    this.handlers.set(topic, [...existing, handler]);
    logger.info('GossipSub subscribed', { topic });
  }

  unsubscribe(topic: GossipTopic, handler: GossipHandler): void {
    const existing = this.handlers.get(topic) ?? [];
    this.handlers.set(topic, existing.filter(h => h !== handler));
  }

  async publish(topic: GossipTopic, data: Record<string, unknown>): Promise<void> {
    await this.axl.gossipPublish(topic, data);
    logger.debug('GossipSub published', { topic });
  }

  startListening(intervalMs: number = 2000): void {
    this.pollInterval = setInterval(async () => {
      for (const [topic, handlers] of this.handlers.entries()) {
        try {
          const messages = await this.axl.gossipReceive(topic as GossipTopic);
          for (const msg of messages) {
            // Deduplicate
            const key = `${msg.from}:${topic}:${msg.timestamp}`;
            if (this.seenMessages.has(key)) continue;
            this.seenMessages.add(key);
            this.seenMessageQueue.push(key);
            if (this.seenMessageQueue.length > this.maxSeen) {
              const evicted = this.seenMessageQueue.shift();
              if (evicted) this.seenMessages.delete(evicted);
            }

            for (const handler of handlers) {
              try {
                await handler(msg.from, msg.data, msg.timestamp);
              } catch (err) {
                logger.error('GossipSub handler threw', { topic, err });
              }
            }
          }
        } catch (err) {
          logger.debug('GossipSub poll error', { topic, err });
        }
      }
    }, intervalMs);
    logger.info('GossipSub listening', { topics: [...this.handlers.keys()], intervalMs });
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

export { GOSSIP_TOPICS };
