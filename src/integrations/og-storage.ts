import { ethers } from 'ethers';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface StorageUploadResult {
  rootHash: string;
  txHash?: string;
  url: string;
}

/**
 * 0G Storage client.
 *
 * Used for:
 * - Debate transcripts (immutable log of every A2A exchange)
 * - Review findings with TEE proofs
 * - Agent intelligence blobs (encrypted, for iNFT embedding)
 * - Codebase memory patterns propagated across the swarm
 */
export class OGStorageClient {
  private signer: ethers.Wallet | null = null;
  private indexer: unknown = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (!config.og.privateKey) {
      logger.warn('OG_PRIVATE_KEY not set — 0G Storage in mock mode');
      this.initialized = true;
      return;
    }

    try {
      const provider = new ethers.JsonRpcProvider(config.og.rpcUrl);
      this.signer = new ethers.Wallet(config.og.privateKey, provider);

      const { Indexer } = await import('@0gfoundation/0g-ts-sdk');
      this.indexer = new Indexer(config.og.storageIndexerUrl);

      this.initialized = true;
      logger.info('0G Storage initialized', { indexer: config.og.storageIndexerUrl });
    } catch (err) {
      logger.error('0G Storage init failed — mock mode', { err });
      this.initialized = true;
    }
  }

  async upload(data: Record<string, unknown>): Promise<StorageUploadResult> {
    if (!this.initialized) await this.initialize();

    if (!this.indexer || !this.signer) {
      // No credentials configured — dev/demo mode only.
      if (config.og.privateKey) {
        // Credentials were set but initialization failed. Don't return a fake
        // storage URL that would get recorded on-chain as a real reference.
        throw new Error(
          '0G Storage unavailable: OG_PRIVATE_KEY is set but the client failed to initialize. ' +
          'Check OG_RPC_URL and OG_STORAGE_INDEXER_URL connectivity.'
        );
      }
      return this.mockUpload(data);
    }

    const { ZgFile } = await import('@0gfoundation/0g-ts-sdk');
    const jsonBytes = Buffer.from(JSON.stringify(data, null, 2));
    const blob = new Blob([jsonBytes], { type: 'application/json' });

    // ZgFile accepts a Blob-like object; the type differs from Node.js File
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const file = new ZgFile(blob as any);
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr || !tree) throw treeErr ?? new Error('0G Storage merkleTree returned null');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rootHash = (tree as any).rootHash() as string;

    const idx = this.indexer as {
      upload: (file: unknown, rpcUrl: string, signer: ethers.Wallet) => Promise<[string | null, Error | null]>;
    };
    const [tx, uploadErr] = await idx.upload(file, config.og.rpcUrl, this.signer);
    if (uploadErr) throw uploadErr;

    const result: StorageUploadResult = {
      rootHash,
      txHash: tx != null ? tx : undefined,
      url: `0g-storage://${rootHash}`,
    };
    logger.info('0G Storage upload complete', { rootHash, txHash: tx });
    return result;
  }

  async uploadDebateTranscript(transcript: {
    prHash: string;
    messages: unknown[];
    startTime: number;
    endTime: number;
    participants: string[];
  }): Promise<StorageUploadResult> {
    return this.upload({
      type: 'debate-transcript',
      version: '1.0',
      ...transcript,
      uploadedAt: Date.now(),
    });
  }

  async uploadReviewFindings(findings: {
    prHash: string;
    findings: unknown[];
    votes: unknown[];
    consensus: unknown;
    teeProofs: string[];
    teeAttestation?: unknown;
  }): Promise<StorageUploadResult> {
    return this.upload({
      type: 'review-findings',
      version: '1.0',
      ...findings,
      uploadedAt: Date.now(),
    });
  }

  async uploadAgentIntelligence(intelligence: {
    role: string;
    systemPrompt: string;
    learnedPatterns: unknown[];
    version: number;
  }): Promise<StorageUploadResult> {
    // In production, encrypt this before uploading
    return this.upload({
      type: 'agent-intelligence',
      schemaVersion: '1.0',
      role: intelligence.role,
      systemPrompt: intelligence.systemPrompt,
      learnedPatterns: intelligence.learnedPatterns,
      intelligenceVersion: intelligence.version,
      uploadedAt: Date.now(),
    });
  }

  private mockUpload(data: Record<string, unknown>): StorageUploadResult {
    const hash = '0x' + Buffer.from(JSON.stringify(data)).slice(0, 32).toString('hex').padEnd(64, '0');
    logger.debug('0G Storage mock upload', { dataKeys: Object.keys(data) });
    return {
      rootHash: hash,
      url: `0g-storage-mock://${hash}`,
    };
  }
}
