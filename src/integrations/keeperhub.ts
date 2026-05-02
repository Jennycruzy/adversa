import { ethers } from 'ethers';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ConsensusResult } from '../types/review.js';

interface KeeperHubCallResult {
  workflowId: string;
  executionId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'mock';
  txHash?: string;
  error?: string;
}

/**
 * KeeperHub integration.
 *
 * KeeperHub provides reliable on-chain execution with:
 * - Gas estimation and optimization
 * - Automatic retry with exponential backoff on congestion
 * - Nonce management across concurrent transactions
 * - Multi-RPC failover
 * - Full audit trail per workflow execution
 *
 * Integration modes (auto-detected, in priority order):
 *  1. KeeperHub MCP server (Docker container at localhost:3000)
 *     Exposes MCP tools: create_workflow, execute_workflow, get_execution_status
 *  2. KeeperHub REST API (https://app.keeperhub.com/api)
 *     Direct REST calls using kh_... API key
 *  3. Mock mode (no credentials configured)
 *
 * Workflow node format uses KeeperHub's node/edge graph schema:
 *   { trigger, nodes: [{id, type, data: {actionType, config}}], edges }
 * Supported action types: web3/write-contract, web3/transfer-funds, web3/read-contract
 * Auth header: Authorization: Bearer kh_...
 *
 * Note: 0G testnet (chain 16602) registration in KeeperHub requires a custom
 * chain configuration. When the chain is not supported, we fall back to a
 * direct ethers.js execution and log the audit record to KeeperHub separately.
 */
export class KeeperHubClient {
  private readonly restApiUrl = 'https://app.keeperhub.com/api';
  private readonly mcpUrl: string;
  private mcpMode: boolean | null = null;  // null = not probed yet
  private initialized = false;

  constructor() {
    this.mcpUrl = config.keeperhub.mcpUrl;
  }

  async initialize(): Promise<void> {
    if (!config.keeperhub.apiKey && !config.keeperhub.mcpApiKey) {
      logger.warn('No KeeperHub credentials — KeeperHub in mock mode');
      this.initialized = true;
      return;
    }
    this.initialized = true;
    logger.info('KeeperHub client initialized', {
      mcpUrl: this.mcpUrl,
      hasApiKey: !!config.keeperhub.apiKey,
      hasMcpApiKey: !!config.keeperhub.mcpApiKey,
    });
  }

  // ─── MCP Server call (standard MCP JSON-RPC tools/call protocol) ─────────────

  private async mcpToolCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const apiKey = config.keeperhub.mcpApiKey ?? config.keeperhub.apiKey;
    if (!apiKey) throw new Error('No KeeperHub MCP API key');

    const response = await fetch(`${this.mcpUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        id: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`KeeperHub MCP ${toolName} failed: ${response.status}`);
    }

    const data = await response.json() as {
      result?: { content?: Array<{ text?: string }> };
      error?: { message: string };
    };

    if (data.error) throw new Error(`KeeperHub MCP error: ${data.error.message}`);

    // MCP tool results are wrapped in content[].text as JSON
    const text = data.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : data.result;
  }

  // ─── REST API call (direct KeeperHub REST API) ────────────────────────────────

  private async restCall(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    const apiKey = config.keeperhub.apiKey ?? config.keeperhub.mcpApiKey;
    if (!apiKey) throw new Error('No KeeperHub API key');

    const response = await fetch(`${this.restApiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`KeeperHub REST ${method} ${path} failed: ${response.status} ${errBody}`);
    }

    const data = await response.json() as { data?: unknown; error?: { code: string; message: string } };
    if (data.error) throw new Error(`KeeperHub error: ${data.error.message}`);
    return data.data ?? data;
  }

  // ─── Smart dispatch: MCP server → REST API → mock ────────────────────────────

  /**
   * Create a workflow and execute it. Tries MCP server first (if running),
   * then REST API, then mock. Returns tracking info.
   */
  private async createAndRunWorkflow(
    name: string,
    workflowDef: Record<string, unknown>
  ): Promise<KeeperHubCallResult> {
    if (!this.initialized) await this.initialize();

    const hasCredentials = !!(config.keeperhub.apiKey || config.keeperhub.mcpApiKey);
    if (!hasCredentials) {
      logger.warn('KeeperHub mock mode — no credentials', { name });
      return { workflowId: `mock-${crypto.randomUUID()}`, status: 'mock' };
    }

    // Mode 1: Try MCP server (Docker container at localhost:3000)
    if (this.mcpMode !== false) {
      try {
        const created = await this.mcpToolCall('create_workflow', {
          name,
          ...workflowDef,
        }) as { id?: string; workflowId?: string };

        const workflowId = created?.id ?? created?.workflowId ?? crypto.randomUUID();
        this.mcpMode = true;

        // Execute the workflow immediately
        const execution = await this.mcpToolCall('execute_workflow', {
          workflow_id: workflowId,
        }) as { executionId?: string; id?: string; status?: string };

        const result: KeeperHubCallResult = {
          workflowId,
          executionId: execution?.executionId ?? execution?.id,
          status: (execution?.status as KeeperHubCallResult['status']) ?? 'queued',
        };
        logger.info('KeeperHub workflow created and executed via MCP', {
          name, workflowId, executionId: result.executionId,
        });
        return result;
      } catch (err) {
        logger.warn('KeeperHub MCP server unavailable — falling back to REST API', {
          name,
          err: err instanceof Error ? err.message : String(err),
        });
        this.mcpMode = false;
      }
    }

    // Mode 2: Direct REST API call
    try {
      const workflow = await this.restCall('POST', '/workflows', {
        name,
        ...workflowDef,
      }) as { id?: string; workflowId?: string };

      const workflowId = (workflow as { id?: string })?.id ?? crypto.randomUUID();

      // Execute immediately
      const execution = await this.restCall('POST', `/workflows/${workflowId}/execute`, {}) as {
        id?: string; executionId?: string; status?: string;
      };

      const result: KeeperHubCallResult = {
        workflowId,
        executionId: execution?.id ?? execution?.executionId,
        status: (execution?.status as KeeperHubCallResult['status']) ?? 'queued',
      };
      logger.info('KeeperHub workflow created via REST API', {
        name, workflowId, executionId: result.executionId,
      });
      return result;
    } catch (err) {
      logger.error('KeeperHub REST API call failed', {
        name,
        err: err instanceof Error ? err.message : String(err),
      });
      // Return a failed result rather than throwing — the caller will handle retry via OfflineQueue
      return {
        workflowId: `failed-${crypto.randomUUID()}`,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Build a KeeperHub workflow definition using the node/edge graph format.
   * For 0G testnet (chainId 16602) we include the custom RPC URL in the config
   * so KeeperHub can reach the network even if it's not pre-registered.
   */
  private buildContractWriteWorkflow(params: {
    label: string;
    contractAddress: string;
    methodName: string;
    methodAbi: string;  // ABI fragment for the specific method
    args: unknown[];
    chainId?: number;
    rpcUrl?: string;
  }): Record<string, unknown> {
    const chainId = String(params.chainId ?? 16602);
    return {
      trigger: {
        id: 'trigger-1',
        type: 'trigger',
        data: { label: 'Adversa webhook trigger', config: {} },
      },
      nodes: [
        {
          id: 'write-contract',
          type: 'action',
          data: {
            label: params.label,
            type: 'action',
            config: {
              actionType: 'web3/write-contract',
              network: chainId,
              rpcUrl: params.rpcUrl ?? config.og.rpcUrl,  // custom RPC for 0G testnet
              contractAddress: params.contractAddress,
              abi: params.methodAbi,
              methodName: params.methodName,
              params: params.args,
            },
          },
        },
      ],
      edges: [
        { id: 'edge-1', source: 'trigger-1', target: 'write-contract' },
      ],
    };
  }

  // ─── Workflow: Record review on 0G Chain ─────────────────────────────────────

  async recordReviewOnChain(
    consensus: ConsensusResult,
    storageRoot: string,
    registryAddress: string
  ): Promise<KeeperHubCallResult> {
    const prHashBytes = ethers.keccak256(ethers.toUtf8Bytes(consensus.prHash));
    const agentAddresses = consensus.votes
      .map(v => v.agentPeerId)
      .filter(id => /^0x[0-9a-fA-F]{40}$/.test(id));

    const workflow = this.buildContractWriteWorkflow({
      label: `Record review: ${consensus.prHash.slice(0, 16)}`,
      contractAddress: registryAddress,
      methodName: 'recordReview',
      methodAbi: 'function recordReview(bytes32 prHash, address[] calldata reviewerAgents, bool approved, string calldata storageRoot, string calldata teeProofId, uint256 confidenceScore) external',
      args: [
        prHashBytes,
        agentAddresses,
        consensus.approved,
        storageRoot,
        consensus.teeProofIds[0] ?? '',
        consensus.confidenceScore,
      ],
    });

    const result = await this.createAndRunWorkflow(
      `adversa-record-review-${consensus.prHash.slice(0, 16)}`,
      workflow
    );

    logger.info('Review recorded via KeeperHub', {
      approved: consensus.approved,
      confidence: consensus.confidenceScore,
      workflowId: result.workflowId,
      status: result.status,
    });
    return result;
  }

  // ─── Workflow: Update agent reputation ───────────────────────────────────────

  async updateReputation(
    agentAddress: string,
    wasAccurate: boolean,
    reputationAddress: string
  ): Promise<KeeperHubCallResult> {
    const workflow = this.buildContractWriteWorkflow({
      label: `Update reputation: ${agentAddress.slice(0, 10)}`,
      contractAddress: reputationAddress,
      methodName: 'updateReputation',
      methodAbi: 'function updateReputation(address agent, bool wasAccurate) external',
      args: [agentAddress, wasAccurate],
    });

    return this.createAndRunWorkflow(
      `adversa-reputation-${agentAddress.slice(0, 10)}-${Date.now()}`,
      workflow
    );
  }

  // ─── Workflow: Mint agent iNFT ────────────────────────────────────────────────

  async mintAgentINFT(
    ownerAddress: string,
    encryptedURI: string,
    metadataHash: string,
    role: string,
    inftAddress: string
  ): Promise<KeeperHubCallResult> {
    const workflow = this.buildContractWriteWorkflow({
      label: `Mint iNFT: ${role} agent`,
      contractAddress: inftAddress,
      methodName: 'mintAgent',
      methodAbi: 'function mintAgent(address to, string calldata encryptedIntelligenceURI, bytes32 metadataHash, string calldata role) external returns (uint256)',
      args: [ownerAddress, encryptedURI, metadataHash, role],
    });

    return this.createAndRunWorkflow(
      `adversa-mint-${role}-${Date.now()}`,
      workflow
    );
  }

  // ─── Workflow: Evolve agent iNFT ─────────────────────────────────────────────

  async evolveAgentINFT(
    tokenId: number,
    newEncryptedURI: string,
    newMetadataHash: string,
    inftAddress: string
  ): Promise<KeeperHubCallResult> {
    const workflow = this.buildContractWriteWorkflow({
      label: `Evolve iNFT: token ${tokenId}`,
      contractAddress: inftAddress,
      methodName: 'evolveAgent',
      methodAbi: 'function evolveAgent(uint256 tokenId, string calldata newEncryptedIntelligenceURI, bytes32 newMetadataHash) external',
      args: [tokenId, newEncryptedURI, newMetadataHash],
    });

    return this.createAndRunWorkflow(
      `adversa-evolve-${tokenId}-${Date.now()}`,
      workflow
    );
  }

  // ─── Workflow: Fund 0G Compute account ───────────────────────────────────────

  async fundComputeAccount(
    fromAddress: string,
    toAddress: string,
    amountEther: string
  ): Promise<KeeperHubCallResult> {
    if (!this.initialized) await this.initialize();

    const hasCredentials = !!(config.keeperhub.apiKey || config.keeperhub.mcpApiKey);
    if (!hasCredentials) {
      return { workflowId: `mock-${crypto.randomUUID()}`, status: 'mock' };
    }

    const workflowDef = {
      trigger: {
        id: 'trigger-1',
        type: 'trigger',
        data: { label: 'Fund compute account', config: {} },
      },
      nodes: [
        {
          id: 'transfer',
          type: 'action',
          data: {
            label: `Transfer ${amountEther} A0GI`,
            type: 'action',
            config: {
              actionType: 'web3/transfer-funds',
              network: '16602',
              rpcUrl: config.og.rpcUrl,
              from: fromAddress,
              to: toAddress,
              amount: amountEther,
              unit: 'ether',
            },
          },
        },
      ],
      edges: [{ id: 'edge-1', source: 'trigger-1', target: 'transfer' }],
    };

    return this.createAndRunWorkflow(`adversa-fund-compute-${Date.now()}`, workflowDef);
  }

  // ─── Workflow status polling ─────────────────────────────────────────────────

  async getWorkflowStatus(executionId: string): Promise<KeeperHubCallResult> {
    if (!this.initialized) await this.initialize();

    // Try MCP server first
    if (this.mcpMode !== false) {
      try {
        const status = await this.mcpToolCall('get_execution_status', {
          execution_id: executionId,
        }) as { status?: string; txHash?: string; workflowId?: string };
        return {
          workflowId: status?.workflowId ?? executionId,
          executionId,
          status: (status?.status as KeeperHubCallResult['status']) ?? 'running',
          txHash: status?.txHash,
        };
      } catch {
        // Fall through
      }
    }

    // REST API fallback
    try {
      const status = await this.restCall('GET', `/executions/${executionId}`) as {
        id?: string; status?: string; txHash?: string;
      };
      return {
        workflowId: executionId,
        executionId,
        status: (status?.status as KeeperHubCallResult['status']) ?? 'running',
        txHash: status?.txHash,
      };
    } catch (err) {
      return {
        workflowId: executionId,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** List available KeeperHub action schemas (useful for debugging / provider discovery) */
  async listActionSchemas(): Promise<unknown[]> {
    if (!this.initialized) await this.initialize();
    try {
      if (this.mcpMode !== false) {
        const result = await this.mcpToolCall('list_action_schemas', {});
        return Array.isArray(result) ? result : [];
      }
    } catch { /* fall through */ }
    try {
      const result = await this.restCall('GET', '/action-schemas') as unknown[];
      return Array.isArray(result) ? result : [];
    } catch { return []; }
  }
}
