import 'dotenv/config';
import { z } from 'zod';

const AgentRoleSchema = z.enum(['gateway', 'security', 'performance', 'style', 'redteam', 'coder']);

const ConfigSchema = z.object({
  axl: z.object({
    nodePort: z.number().default(9002),
    nodeHost: z.string().default('localhost'),
    privateKeyPath: z.string().default('./keys/agent-private.pem'),
    configPath: z.string().default('./config/node-config.json'),
  }),
  github: z.object({
    appId: z.string().optional(),
    appPrivateKey: z.string().optional(),
    webhookSecret: z.string().optional(),
    repoOwner: z.string().default(''),
    repoName: z.string().default(''),
    token: z.string().optional(),
  }),
  og: z.object({
    privateKey: z.string().optional(),
    rpcUrl: z.string().default('https://evmrpc-testnet.0g.ai'),
    computeProviderAddress: z.string().optional(),
    storageIndexerUrl: z.string().default('https://indexer-storage-testnet-turbo.0g.ai'),
    registryAddress: z.string().optional(),
    reputationAddress: z.string().optional(),
    inftAddress: z.string().optional(),
    deployerPrivateKey: z.string().optional(),
  }),
  keeperhub: z.object({
    apiKey: z.string().optional(),
    mcpApiKey: z.string().optional(),
    mcpPort: z.number().default(3000),
    mcpUrl: z.string().default('http://localhost:3000'),
  }),
  agent: z.object({
    role: AgentRoleSchema.default('gateway'),
    consensusThreshold: z.number().default(7500),
    humanTimeoutMs: z.number().default(300000),
  }),
  dashboard: z.object({
    port: z.number().default(3001),
    host: z.string().default('0.0.0.0'),
  }),
  offline: z.object({
    queuePath: z.string().default('./data/offline-queue.json'),
    connectivityCheckIntervalMs: z.number().default(5000),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type AgentRole = z.infer<typeof AgentRoleSchema>;

function loadConfig(): Config {
  const raw = {
    axl: {
      nodePort: parseInt(process.env.AXL_NODE_PORT ?? '9002'),
      nodeHost: process.env.AXL_NODE_HOST ?? 'localhost',
      privateKeyPath: process.env.AXL_PRIVATE_KEY_PATH ?? './keys/agent-private.pem',
      configPath: process.env.AXL_CONFIG_PATH ?? './config/node-config.json',
    },
    github: {
      appId: process.env.GITHUB_APP_ID,
      appPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
      repoOwner: process.env.GITHUB_REPO_OWNER ?? '',
      repoName: process.env.GITHUB_REPO_NAME ?? '',
      token: process.env.GITHUB_TOKEN,
    },
    og: {
      privateKey: process.env.OG_PRIVATE_KEY,
      rpcUrl: process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai',
      computeProviderAddress: process.env.OG_COMPUTE_PROVIDER_ADDRESS,
      storageIndexerUrl: process.env.OG_STORAGE_INDEXER_URL ?? 'https://indexer-storage-testnet-turbo.0g.ai',
      registryAddress: process.env.ADVERSA_REGISTRY_ADDRESS,
      reputationAddress: process.env.ADVERSA_REPUTATION_ADDRESS,
      inftAddress: process.env.ADVERSA_INFT_ADDRESS,
      deployerPrivateKey: process.env.DEPLOYER_PRIVATE_KEY,
    },
    keeperhub: {
      apiKey: process.env.KEEPERHUB_API_KEY,
      mcpApiKey: process.env.KEEPERHUB_MCP_API_KEY,
      mcpPort: parseInt(process.env.KEEPERHUB_MCP_PORT ?? '3000'),
      mcpUrl: process.env.KEEPERHUB_MCP_URL ?? 'http://localhost:3000',
    },
    agent: {
      role: (process.env.AGENT_ROLE ?? 'gateway') as z.infer<typeof AgentRoleSchema>,
      consensusThreshold: parseInt(process.env.CONSENSUS_THRESHOLD ?? '7500'),
      humanTimeoutMs: parseInt(process.env.HUMAN_TIMEOUT_MS ?? '300000'),
    },
    dashboard: {
      port: parseInt(process.env.DASHBOARD_PORT ?? '3001'),
      host: process.env.DASHBOARD_HOST ?? '0.0.0.0',
    },
    offline: {
      queuePath: process.env.OFFLINE_QUEUE_PATH ?? './data/offline-queue.json',
      connectivityCheckIntervalMs: parseInt(process.env.CONNECTIVITY_CHECK_INTERVAL_MS ?? '5000'),
    },
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${JSON.stringify(result.error.format(), null, 2)}`);
  }
  return result.data;
}

export const config = loadConfig();
