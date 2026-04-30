import { ethers } from 'ethers';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ConsensusResult } from '../types/review.js';

interface KeeperHubWorkflowStep {
  action: string;
  params: Record<string, unknown>;
}

interface KeeperHubWorkflow {
  name: string;
  trigger: { type: 'webhook' | 'schedule'; schedule?: string };
  steps: KeeperHubWorkflowStep[];
  retryPolicy?: { maxAttempts: number; backoffSeconds: number };
}

interface KeeperHubCallResult {
  workflowId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  txHash?: string;
  error?: string;
}

/**
 * KeeperHub MCP client.
 *
 * All on-chain operations route through KeeperHub for:
 * - Gas estimation and optimization
 * - Automatic retry with exponential backoff on congestion
 * - Nonce management across concurrent transactions
 * - Multi-RPC failover
 * - Full audit trail per workflow execution
 *
 * Agents access KeeperHub via AXL MCP routing:
 *   POST localhost:9002/mcp/{gateway_peer}/keeperhub
 * but can also call it directly via HTTP when the gateway is the caller.
 */
export class KeeperHubClient {
  private readonly mcpUrl: string;
  private initialized = false;

  constructor() {
    this.mcpUrl = config.keeperhub.mcpUrl;
  }

  async initialize(): Promise<void> {
    if (!config.keeperhub.apiKey) {
      logger.warn('KEEPERHUB_API_KEY not set — KeeperHub in mock mode');
    }
    this.initialized = true;
    logger.info('KeeperHub client initialized', { mcpUrl: this.mcpUrl });
  }

  private async mcpCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.initialized) await this.initialize();

    if (!config.keeperhub.mcpApiKey) {
      logger.warn('KeeperHub MCP API key not set — running in MOCK mode, no on-chain transactions will be sent', { method });
      return { workflowId: `mock-${crypto.randomUUID()}`, status: 'mock' };
    }

    const response = await fetch(`${this.mcpUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.keeperhub.mcpApiKey,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: crypto.randomUUID(),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`KeeperHub MCP call failed: ${response.status} ${body}`);
    }

    const data = await response.json() as { result?: unknown; error?: { message: string } };
    if (data.error) throw new Error(`KeeperHub error: ${data.error.message}`);
    return data.result;
  }

  private async createAndExecuteWorkflow(workflow: KeeperHubWorkflow): Promise<KeeperHubCallResult> {
    const result = await this.mcpCall('create_workflow', workflow as unknown as Record<string, unknown>) as KeeperHubCallResult;
    logger.info('KeeperHub workflow created', {
      name: workflow.name,
      workflowId: result.workflowId,
      status: result.status,
    });
    return result;
  }

  // ─── Workflow: Record review on 0G Chain ─────────────────────────────────────

  async recordReviewOnChain(
    consensus: ConsensusResult,
    storageRoot: string,
    registryAddress: string
  ): Promise<KeeperHubCallResult> {
    const prHashBytes = ethers.keccak256(ethers.toUtf8Bytes(consensus.prHash));
    return this.createAndExecuteWorkflow({
      name: `adversa-record-review-${consensus.prHash.slice(0, 16)}`,
      trigger: { type: 'webhook' },
      retryPolicy: { maxAttempts: 5, backoffSeconds: 10 },
      steps: [
        {
          action: 'web3.contract_write',
          params: {
            chain: '0g-testnet',
            rpc_url: config.og.rpcUrl,
            contract: registryAddress,
            abi_method: 'recordReview(bytes32,address[],bool,string,string,uint256,uint256,uint256)',
            args: [
              prHashBytes,
              consensus.votes.map(v => v.agentPeerId).filter(id => id.startsWith('0x') && id.length === 42),
              consensus.approved,
              storageRoot,
              consensus.teeProofIds[0] ?? '',
              consensus.confidenceScore,
              consensus.exploitsFound.length,
              consensus.exploitsMitigated,
            ],
          },
        },
        {
          action: 'notification.log',
          params: {
            message: `Review ${consensus.approved ? 'APPROVED' : 'REJECTED'} — PR ${consensus.prHash} — confidence ${consensus.confidenceScore / 100}%`,
          },
        },
      ],
    });
  }

  // ─── Workflow: Update agent reputation ───────────────────────────────────────

  async updateReputation(
    agentAddress: string,
    wasAccurate: boolean,
    reputationAddress: string
  ): Promise<KeeperHubCallResult> {
    return this.createAndExecuteWorkflow({
      name: `adversa-reputation-${agentAddress.slice(0, 10)}-${Date.now()}`,
      trigger: { type: 'webhook' },
      retryPolicy: { maxAttempts: 3, backoffSeconds: 5 },
      steps: [
        {
          action: 'web3.contract_write',
          params: {
            chain: '0g-testnet',
            rpc_url: config.og.rpcUrl,
            contract: reputationAddress,
            abi_method: 'updateReputation(address,bool)',
            args: [agentAddress, wasAccurate],
          },
        },
      ],
    });
  }

  // ─── Workflow: Mint agent iNFT ────────────────────────────────────────────────

  async mintAgentINFT(
    ownerAddress: string,
    encryptedURI: string,
    metadataHash: string,
    role: string,
    inftAddress: string
  ): Promise<KeeperHubCallResult> {
    return this.createAndExecuteWorkflow({
      name: `adversa-mint-${role}-${Date.now()}`,
      trigger: { type: 'webhook' },
      retryPolicy: { maxAttempts: 3, backoffSeconds: 15 },
      steps: [
        {
          action: 'web3.contract_write',
          params: {
            chain: '0g-testnet',
            rpc_url: config.og.rpcUrl,
            contract: inftAddress,
            abi_method: 'mintAgent(address,string,bytes32,string)',
            args: [ownerAddress, encryptedURI, metadataHash, role],
          },
        },
      ],
    });
  }

  // ─── Workflow: Evolve agent iNFT ─────────────────────────────────────────────

  async evolveAgentINFT(
    tokenId: number,
    newEncryptedURI: string,
    newMetadataHash: string,
    inftAddress: string
  ): Promise<KeeperHubCallResult> {
    return this.createAndExecuteWorkflow({
      name: `adversa-evolve-${tokenId}-${Date.now()}`,
      trigger: { type: 'webhook' },
      retryPolicy: { maxAttempts: 3, backoffSeconds: 15 },
      steps: [
        {
          action: 'web3.contract_write',
          params: {
            chain: '0g-testnet',
            rpc_url: config.og.rpcUrl,
            contract: inftAddress,
            abi_method: 'evolveAgent(uint256,string,bytes32)',
            args: [tokenId, newEncryptedURI, newMetadataHash],
          },
        },
      ],
    });
  }

  // ─── Workflow: Fund 0G Compute account ───────────────────────────────────────

  async fundComputeAccount(
    fromAddress: string,
    toAddress: string,
    amountEther: string
  ): Promise<KeeperHubCallResult> {
    return this.createAndExecuteWorkflow({
      name: `adversa-fund-compute-${Date.now()}`,
      trigger: { type: 'webhook' },
      retryPolicy: { maxAttempts: 2, backoffSeconds: 30 },
      steps: [
        {
          action: 'web3.transfer',
          params: {
            chain: '0g-testnet',
            rpc_url: config.og.rpcUrl,
            from: fromAddress,
            to: toAddress,
            amount_ether: amountEther,
          },
        },
      ],
    });
  }

  // ─── Workflow status polling ─────────────────────────────────────────────────

  async getWorkflowStatus(workflowId: string): Promise<KeeperHubCallResult> {
    const result = await this.mcpCall('get_workflow_status', { workflow_id: workflowId });
    return result as KeeperHubCallResult;
  }
}
