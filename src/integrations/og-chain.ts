import { ethers } from 'ethers';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ConsensusResult } from '../types/review.js';

const REGISTRY_ABI = [
  'function recordReview(bytes32 prHash, address[] calldata reviewerAgents, bool approved, string calldata storageRoot, string calldata teeProofId, uint256 confidenceScore, uint256 exploitsFound, uint256 exploitsMitigated) external',
  'function getReview(bytes32 prHash) external view returns (tuple(bytes32 prHash, address[] reviewerAgents, bool approved, string storageRoot, string teeProofId, uint256 timestamp, uint256 confidenceScore, uint256 exploitsFound, uint256 exploitsMitigated, bool exists))',
  'function getTotalReviews() external view returns (uint256)',
  'event ReviewRecorded(bytes32 indexed prHash, bool approved, uint256 confidenceScore, uint256 timestamp)',
];

const REPUTATION_ABI = [
  'function updateReputation(address agent, bool wasAccurate) external',
  'function recordExploit(address agent, bool falsePositive) external',
  'function registerAgent(address agent) external',
  'function getReputation(address agent) external view returns (tuple(int256 reputationScore, uint256 totalReviews, uint256 accurateReviews, uint256 exploitsFound, uint256 exploitsFalsePositive, uint256 lastUpdated, bool exists))',
  'function getAccuracyRate(address agent) external view returns (uint256)',
];

const INFT_ABI = [
  'function mintAgent(address to, string calldata encryptedURI, bytes32 metadataHash, string calldata role) external returns (uint256)',
  'function evolveAgent(uint256 tokenId, string calldata newEncryptedURI, bytes32 newMetadataHash) external',
  'function getAgentMetadata(uint256 tokenId) external view returns (tuple(string encryptedIntelligenceURI, bytes32 metadataHash, string role, uint256 evolutionCount, uint256 lastUpdated, int256 reputationScore, uint256 totalReviews, bool active))',
  'function totalSupply() external view returns (uint256)',
  'event AgentMinted(uint256 indexed tokenId, string role, bytes32 metadataHash, address to)',
  'event AgentEvolved(uint256 indexed tokenId, uint256 evolutionCount, bytes32 newMetadataHash)',
];

export class OGChainClient {
  private provider: ethers.JsonRpcProvider | null = null;
  private wallet: ethers.Wallet | null = null;
  private registry: ethers.Contract | null = null;
  private reputation: ethers.Contract | null = null;
  private inft: ethers.Contract | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (!config.og.privateKey) {
      logger.warn('OG_PRIVATE_KEY not set — 0G Chain in mock mode');
      this.initialized = true;
      return;
    }

    try {
      this.provider = new ethers.JsonRpcProvider(config.og.rpcUrl);
      this.wallet = new ethers.Wallet(config.og.privateKey, this.provider);

      if (config.og.registryAddress) {
        this.registry = new ethers.Contract(config.og.registryAddress, REGISTRY_ABI, this.wallet);
      }
      if (config.og.reputationAddress) {
        this.reputation = new ethers.Contract(config.og.reputationAddress, REPUTATION_ABI, this.wallet);
      }
      if (config.og.inftAddress) {
        this.inft = new ethers.Contract(config.og.inftAddress, INFT_ABI, this.wallet);
      }

      this.initialized = true;
      logger.info('0G Chain client initialized', {
        chainId: 16602,
        wallet: this.wallet.address,
        hasRegistry: !!this.registry,
        hasReputation: !!this.reputation,
        hasINFT: !!this.inft,
      });
    } catch (err) {
      logger.error('0G Chain init failed', { err });
      this.initialized = true;
    }
  }

  async recordReview(consensus: ConsensusResult, storageRoot: string): Promise<string | null> {
    if (!this.initialized) await this.initialize();
    if (!this.registry) {
      logger.warn('Registry contract not configured — skipping on-chain record');
      return null;
    }

    try {
      const prHashBytes = ethers.keccak256(ethers.toUtf8Bytes(consensus.prHash));
      const reviewerAddresses = consensus.votes
        .map(v => v.agentPeerId)
        .filter(id => ethers.isAddress(id));

      const tx = await this.registry.recordReview(
        prHashBytes,
        reviewerAddresses.length > 0 ? reviewerAddresses : [ethers.ZeroAddress],
        consensus.approved,
        storageRoot,
        consensus.teeProofIds[0] ?? '',
        consensus.confidenceScore,
        consensus.exploitsFound.length,
        consensus.exploitsMitigated,
      );
      const receipt = await tx.wait();
      logger.info('Review recorded on 0G Chain', { txHash: receipt.hash, prHash: consensus.prHash });
      return receipt.hash as string;
    } catch (err) {
      logger.error('Failed to record review on chain', { err });
      return null;
    }
  }

  async updateReputation(agentAddress: string, wasAccurate: boolean): Promise<string | null> {
    if (!this.reputation) return null;
    try {
      const tx = await this.reputation.updateReputation(agentAddress, wasAccurate);
      const receipt = await tx.wait();
      return receipt.hash as string;
    } catch (err) {
      logger.error('Failed to update reputation', { err, agentAddress });
      return null;
    }
  }

  async mintAgentINFT(
    toAddress: string,
    encryptedURI: string,
    metadataHash: string,
    role: string
  ): Promise<{ tokenId: number; txHash: string } | null> {
    if (!this.inft) return null;
    try {
      const hashBytes = ethers.hexlify(ethers.toUtf8Bytes(metadataHash)).padEnd(66, '0').slice(0, 66);
      const tx = await this.inft.mintAgent(toAddress, encryptedURI, hashBytes, role);
      const receipt = await tx.wait();
      const event = receipt.logs
        .map((log: ethers.Log) => {
          try { return this.inft!.interface.parseLog(log); } catch { return null; }
        })
        .find((e: ethers.LogDescription | null) => e?.name === 'AgentMinted');
      const tokenId = event ? Number(event.args[0]) : 0;
      logger.info('Agent iNFT minted', { tokenId, role, txHash: receipt.hash });
      return { tokenId, txHash: receipt.hash as string };
    } catch (err) {
      logger.error('Failed to mint agent iNFT', { err, role });
      return null;
    }
  }

  async evolveAgentINFT(
    tokenId: number,
    newEncryptedURI: string,
    newMetadataHash: string
  ): Promise<string | null> {
    if (!this.inft) return null;
    try {
      const hashBytes = ethers.hexlify(ethers.toUtf8Bytes(newMetadataHash)).padEnd(66, '0').slice(0, 66);
      const tx = await this.inft.evolveAgent(tokenId, newEncryptedURI, hashBytes);
      const receipt = await tx.wait();
      logger.info('Agent iNFT evolved', { tokenId, txHash: receipt.hash });
      return receipt.hash as string;
    } catch (err) {
      logger.error('Failed to evolve iNFT', { err, tokenId });
      return null;
    }
  }

  async getReputationScore(agentAddress: string): Promise<number> {
    if (!this.reputation) return 0;
    try {
      const stats = await this.reputation.getReputation(agentAddress);
      return Number(stats.reputationScore);
    } catch {
      return 0;
    }
  }
}
