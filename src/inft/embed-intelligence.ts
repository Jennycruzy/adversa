import { createHash } from 'crypto';
import { OGStorageClient } from '../integrations/og-storage.js';
import { AgentIntelligence, INFTMetadata } from './types.js';
import { AgentRole } from '../config.js';
import { logger } from '../utils/logger.js';

export class IntelligenceEmbedder {
  private storage: OGStorageClient;

  constructor() {
    this.storage = new OGStorageClient();
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
  }

  /**
   * Serialize, (conceptually encrypt), and upload agent intelligence to 0G Storage.
   * Returns the storage URI and metadata hash for minting the iNFT.
   *
   * In production, encrypt with the agent owner's public key before upload.
   * For demo, we upload the JSON directly (marked as demo-unencrypted).
   */
  async embedIntelligence(intelligence: AgentIntelligence): Promise<{
    storageURI: string;
    metadataHash: string;
  }> {
    const serialized = JSON.stringify({
      ...intelligence,
      embeddedAt: Date.now(),
      encrypted: false, // In production: true, use owner's public key
    });

    // Hash before upload
    const metadataHash = '0x' + createHash('sha256').update(serialized).digest('hex');

    // Upload to 0G Storage
    const uploadResult = await this.storage.uploadAgentIntelligence({
      role: intelligence.role,
      systemPrompt: intelligence.systemPrompt,
      learnedPatterns: intelligence.learnedPatterns,
      version: intelligence.version,
    });

    logger.info('Intelligence embedded to 0G Storage', {
      role: intelligence.role,
      rootHash: uploadResult.rootHash,
      metadataHash: metadataHash.slice(0, 20),
    });

    return {
      storageURI: uploadResult.url,
      metadataHash,
    };
  }

  buildINFTMetadata(
    role: AgentRole,
    storageURI: string,
    metadataHash: string,
    evolutionCount: number,
    reputationScore: number
  ): INFTMetadata {
    const roleDescriptions: Record<AgentRole, string> = {
      gateway: 'Orchestrates the review swarm, manages consensus, routes via AXL mesh',
      security: 'Elite security reviewer — finds vulnerabilities, defends against red-team',
      performance: 'Performance engineer — identifies complexity issues and scalability problems',
      style: 'Code quality specialist — ensures maintainability and documentation standards',
      redteam: 'Adversarial attacker — generates real exploits and challenges security agents via A2A',
      coder: 'Autonomous developer — writes code from goals, opens PRs, defends in review',
    };

    return {
      name: `ADVERSA ${role.charAt(0).toUpperCase() + role.slice(1)} Agent`,
      description: roleDescriptions[role],
      image: `https://adversa.ai/agent-avatars/${role}.png`,
      attributes: [
        { trait_type: 'Role', value: role },
        { trait_type: 'Evolution Count', value: evolutionCount },
        { trait_type: 'Reputation Score', value: reputationScore },
        { trait_type: 'Network', value: 'AXL (Yggdrasil Mesh)' },
        { trait_type: 'Inference', value: '0G Compute (TEE-verified)' },
        { trait_type: 'Storage', value: '0G Storage' },
        { trait_type: 'Chain', value: '0G Chain (chainId: 16602)' },
      ],
      encryptedIntelligenceURI: storageURI,
      metadataHash,
      role,
      evolutionCount,
      reputationScore,
    };
  }
}
