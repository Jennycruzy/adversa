import { KeeperHubClient } from '../integrations/keeperhub.js';
import { IntelligenceEmbedder } from './embed-intelligence.js';
import { AgentIntelligence, LearnedPattern } from './types.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';

export class AgentEvolver {
  private keeperhub: KeeperHubClient;
  private embedder: IntelligenceEmbedder;

  constructor() {
    this.keeperhub = new KeeperHubClient();
    this.embedder = new IntelligenceEmbedder();
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.keeperhub.initialize(),
      this.embedder.initialize(),
    ]);
  }

  /**
   * Called when an agent learns a new pattern (e.g., red-team finds a new exploit type,
   * security agent develops a new defense pattern).
   *
   * Re-embeds the updated intelligence to 0G Storage and evolves the iNFT.
   */
  async evolve(
    tokenId: number,
    intelligence: AgentIntelligence,
    newPatterns: LearnedPattern[]
  ): Promise<void> {
    if (!config.og.inftAddress || tokenId === 0) {
      logger.debug('iNFT evolution skipped (no token ID or contract)');
      return;
    }

    const updated: AgentIntelligence = {
      ...intelligence,
      learnedPatterns: [...intelligence.learnedPatterns, ...newPatterns].slice(-50),
      version: intelligence.version + 1,
      lastEvolved: Date.now(),
    };

    const { storageURI, metadataHash } = await this.embedder.embedIntelligence(updated);

    const result = await this.keeperhub.evolveAgentINFT(
      tokenId,
      storageURI,
      metadataHash,
      config.og.inftAddress
    );

    logger.info('Agent iNFT evolved', {
      tokenId,
      role: intelligence.role,
      version: updated.version,
      newPatterns: newPatterns.length,
      workflowId: result.workflowId,
    });

    emitMeshEvent('inft-update', {
      action: 'evolved',
      tokenId,
      role: intelligence.role,
      version: updated.version,
      newPatternCount: newPatterns.length,
      storageURI,
      explorerLink: `https://chainscan-galileo.0g.ai/token/${config.og.inftAddress}/${tokenId}`,
    });
  }
}
