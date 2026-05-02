import { ethers } from 'ethers';
import { writeFile, unlink, open } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
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

    if (!config.og.rpcUrl || !config.og.storageIndexerUrl) {
      logger.warn('OG_RPC_URL or OG_STORAGE_INDEXER_URL not set — 0G Storage in mock mode. Set to 0G Galileo testnet values to enable real storage.');
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
    const tempPath = join(tmpdir(), `adversa-og-storage-${crypto.randomUUID()}.json`);

    let tx: string | null = null;
    let rootHash: string | null = null;
    let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      await writeFile(tempPath, jsonBytes, { mode: 0o600 });
      fileHandle = await open(tempPath, 'r');
      const file = await ZgFile.fromNodeFileHandle(fileHandle);

      const idx = this.indexer as {
        upload: (
          file: unknown,
          rpcUrl: string,
          signer: ethers.Wallet
        ) => Promise<[{
          txHash: string;
          rootHash: string;
          txSeq: number;
        } | null, Error | null]>;
      };
      const [uploadResult, uploadErr] = await idx.upload(file, config.og.rpcUrl!, this.signer);
      if (uploadErr) throw uploadErr;
      if (!uploadResult) {
        throw new Error('0G Storage upload returned no result');
      }
      tx = uploadResult.txHash || null;
      rootHash = uploadResult.rootHash || null;
      if (!rootHash) throw new Error('0G Storage merkle tree returned empty root hash');
    } finally {
      if (fileHandle) {
        await fileHandle.close().catch(() => undefined);
      }
      await unlink(tempPath).catch(() => undefined);
    }

    const finalRootHash = rootHash;
    const result: StorageUploadResult = {
      rootHash: finalRootHash,
      txHash: tx != null ? tx : undefined,
      url: `0g-storage://${finalRootHash}`,
    };
    logger.info('0G Storage upload complete', { rootHash: finalRootHash, txHash: tx });
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
