import 'dotenv/config';
import { config } from './config.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  logger.info('ADVERSA starting', { role: config.agent.role });

  let agent;

  switch (config.agent.role) {
    case 'gateway': {
      const { GatewayAgent } = await import('./agents/gateway.js');
      agent = new GatewayAgent();
      break;
    }
    case 'security': {
      const { SecurityAgent } = await import('./agents/security.js');
      agent = new SecurityAgent();
      break;
    }
    case 'performance': {
      const { PerformanceAgent } = await import('./agents/performance.js');
      agent = new PerformanceAgent();
      break;
    }
    case 'style': {
      const { StyleAgent } = await import('./agents/style.js');
      agent = new StyleAgent();
      break;
    }
    case 'redteam': {
      const { RedTeamAgent } = await import('./agents/redteam.js');
      agent = new RedTeamAgent();
      break;
    }
    case 'coder': {
      const { CoderAgent } = await import('./agents/coder.js');
      agent = new CoderAgent();
      break;
    }
    default:
      throw new Error(`Unknown agent role: ${config.agent.role}`);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info('Shutting down', { signal, role: config.agent.role });
    await agent.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', err => {
    logger.error('Uncaught exception', { err });
    shutdown('uncaughtException').catch(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason });
  });

  await agent.start();
  logger.info('Agent running', { role: config.agent.role });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
