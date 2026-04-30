import { OGChainClient } from '../integrations/og-chain.js';
import { KeeperHubClient } from '../integrations/keeperhub.js';
import { IntelligenceEmbedder } from './embed-intelligence.js';
import { AgentIntelligence } from './types.js';
import { config, AgentRole } from '../config.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';

export class INFTMinter {
  private chain: OGChainClient;
  private keeperhub: KeeperHubClient;
  private embedder: IntelligenceEmbedder;

  constructor() {
    this.chain = new OGChainClient();
    this.keeperhub = new KeeperHubClient();
    this.embedder = new IntelligenceEmbedder();
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.chain.initialize(),
      this.keeperhub.initialize(),
      this.embedder.initialize(),
    ]);
  }

  async mintAgent(
    toAddress: string,
    intelligence: AgentIntelligence
  ): Promise<{ tokenId: number; txHash: string; storageURI: string } | null> {
    if (!config.og.inftAddress) {
      logger.warn('ADVERSA_INFT_ADDRESS not configured — skipping mint');
      return null;
    }

    // Embed intelligence to 0G Storage
    const { storageURI, metadataHash } = await this.embedder.embedIntelligence(intelligence);

    // Mint via KeeperHub for reliable tx execution
    const result = await this.keeperhub.mintAgentINFT(
      toAddress,
      storageURI,
      metadataHash,
      intelligence.role,
      config.og.inftAddress
    );

    logger.info('Agent iNFT minted via KeeperHub', {
      role: intelligence.role,
      workflowId: result.workflowId,
      status: result.status,
    });

    emitMeshEvent('inft-update', {
      action: 'minted',
      role: intelligence.role,
      storageURI,
      metadataHash,
      workflowId: result.workflowId,
    });

    return {
      tokenId: 0, // Will be read from tx receipt in production
      txHash: result.txHash ?? '',
      storageURI,
    };
  }
}
