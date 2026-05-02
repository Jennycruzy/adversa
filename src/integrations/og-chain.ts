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

    if (!config.og.rpcUrl) {
      logger.warn('OG_RPC_URL not set — 0G Chain in mock mode. Set to 0G Galileo testnet RPC to enable on-chain recording.');
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
    void consensus;
    void storageRoot;
    throw new Error('Direct 0G Chain writes are disabled. Use KeeperHubClient.recordReviewOnChain().');
  }

  async updateReputation(agentAddress: string, wasAccurate: boolean): Promise<string | null> {
    void agentAddress;
    void wasAccurate;
    throw new Error('Direct 0G Chain writes are disabled. Use KeeperHubClient.updateReputation().');
  }

  async mintAgentINFT(
    toAddress: string,
    encryptedURI: string,
    metadataHash: string,
    role: string
  ): Promise<{ tokenId: number; txHash: string } | null> {
    void toAddress;
    void encryptedURI;
    void metadataHash;
    void role;
    throw new Error('Direct iNFT minting is disabled. Use KeeperHubClient.mintAgentINFT().');
  }

  async evolveAgentINFT(
    tokenId: number,
    newEncryptedURI: string,
    newMetadataHash: string
  ): Promise<string | null> {
    void tokenId;
    void newEncryptedURI;
    void newMetadataHash;
    throw new Error('Direct iNFT evolution is disabled. Use KeeperHubClient.evolveAgentINFT().');
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
