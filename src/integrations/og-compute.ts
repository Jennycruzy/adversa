import { ethers } from 'ethers';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { globalTEERegistry } from './og-tee-attestation.js';

export interface InferenceResult {
  response: string;
  /** The ZG-Res-Key / chatId returned by the provider — links to per-chat signature */
  chatId?: string;
  /** Alias for chatId — stored in ConsensusResult.teeProofIds */
  teeProof?: string;
  /** True when processResponse() confirmed the response was signed by a verified TEE key */
  isValid: boolean;
  /** URL to download this chat's cryptographic signature from the provider */
  chatSignatureLink?: string;
  /** URL to download the provider's full Signer RA (Remote Attestation) report */
  signerRaLink?: string;
  model?: string;
  providerAddress?: string;
}

interface ServiceMetadata {
  endpoint: string;
  model: string;
}

/**
 * 0G Compute TEE-Verified Inference client.
 *
 * TEE proof chain:
 *   1. Provider registers a TDX/NVIDIA Remote Attestation (RA) on-chain
 *   2. RA proves the signing key was generated inside genuine TEE hardware
 *   3. broker.inference.verifyService() verifies the RA on-chain
 *   4. Each response is signed by that TEE key
 *   5. broker.inference.processResponse(provider, responseText, chatId) verifies
 *      the per-response signature against the verified signing key
 *   6. chatId links to a downloadable signature for independent audit
 *
 * Critical SDK note (v2.0.0):
 *   processResponse(providerAddress, content, chatID?)
 *     content  = the response text returned by the provider
 *     chatID   = the ZG-Res-Key header value (optional, auto-fetched if omitted)
 */
export class OGComputeClient {
  private broker: import('@0glabs/0g-serving-broker').ZGComputeNetworkBroker | null = null;
  private wallet: ethers.Wallet | null = null;
  private providerAddress = '';
  private serviceMetadata: ServiceMetadata | null = null;
  private initialized = false;
  private signerRaLink = '';

  // Contract addresses for 0G testnet (chain 16602)
  private static readonly LEDGER_CA = '0x815B93ab4Ba4BDF530dbF1552649a3c534F8BbF7';
  private static readonly INFERENCE_CA = '0x41bD7Ac5c19000A974D5c192bcd5FB67b56C85c5';

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!config.og.privateKey) {
      logger.warn('OG_PRIVATE_KEY not set — using mock inference (no TEE verification)');
      this.initialized = true;
      return;
    }

    try {
      const provider = new ethers.JsonRpcProvider(config.og.rpcUrl);
      this.wallet = new ethers.Wallet(config.og.privateKey, provider);

      const { createZGComputeNetworkBroker } = await import('@0glabs/0g-serving-broker');
      this.broker = await createZGComputeNetworkBroker(
        this.wallet,
        OGComputeClient.LEDGER_CA,
        OGComputeClient.INFERENCE_CA,
      );

      await this.ensureLedger();

      if (config.og.computeProviderAddress) {
        this.providerAddress = config.og.computeProviderAddress;
        await this.setupProvider(this.providerAddress);
      } else {
        await this.discoverProvider();
      }

      this.initialized = true;
      logger.info('0G Compute initialized with TEE verification', {
        provider: this.providerAddress,
        model: this.serviceMetadata?.model,
        signerRaLink: this.signerRaLink,
      });
    } catch (err) {
      logger.error('0G Compute init failed — falling back to mock inference', { err });
      this.initialized = true;
    }
  }

  /**
   * Ensure the caller's ledger exists and has funds.
   *
   * LedgerBroker.getLedger() returns LedgerDetailStructOutput with:
   *   ledgerInfo: bigint[]  — packed struct; index 1 = availableBalance in neuron
   *   infers: [provider, balance, pending][]
   *
   * Creates a ledger with OG_LEDGER_INITIAL_BALANCE A0GI if none exists.
   * Tops up by OG_LEDGER_DEPOSIT_AMOUNT A0GI if availableBalance is below threshold.
   */
  private async ensureLedger(): Promise<void> {
    if (!this.broker) return;

    const initialBalance = config.og.ledgerInitialBalance ?? 1;
    const depositAmount = config.og.ledgerDepositAmount ?? 0.5;
    const lowBalanceThreshold = config.og.ledgerLowBalanceThreshold ?? 0.1;

    try {
      const detail = await this.broker.ledger.getLedger();
      // ledgerInfo is the ABI-decoded Ledger struct as a bigint array:
      // [0]=user (as bigint address), [1]=availableBalance, [2]=totalBalance, ...
      const availableNeuron: bigint = Array.isArray(detail.ledgerInfo)
        ? (detail.ledgerInfo[1] ?? 0n)
        : 0n;
      const balanceA0GI = Number(availableNeuron) / 1e18;
      logger.debug('0G Compute ledger balance', { balanceA0GI });

      if (balanceA0GI < lowBalanceThreshold) {
        logger.info('0G Compute ledger balance low — depositing funds', {
          current: balanceA0GI,
          depositing: depositAmount,
        });
        await this.broker.ledger.depositFund(depositAmount);
        logger.info('0G Compute ledger topped up', { depositAmount });
      }
    } catch (err: unknown) {
      // getLedger throws when no ledger exists for this wallet yet
      logger.info('0G Compute creating new ledger', { initialBalance });
      try {
        await this.broker.ledger.addLedger(initialBalance);
        logger.info('0G Compute ledger created', { initialBalance });
      } catch (addErr) {
        logger.warn('0G Compute ledger creation failed — inference may fail later', { addErr });
      }
    }
  }

  /**
   * Discover the best TeeML-verifiable inference provider from the on-chain
   * service registry. Prefers services with verifiability !== 'IFTTT' (non-TEE).
   */
  private async discoverProvider(): Promise<void> {
    if (!this.broker) throw new Error('Broker not initialized');

    const services = await this.broker.inference.listService();

    if (services.length === 0) {
      throw new Error('0G Compute: no inference providers registered on-chain');
    }

    // Prefer TeeML (TEE-verified) services. Fall back to any service.
    const teeService = services.find(s =>
      s.verifiability?.toLowerCase().includes('tee') ||
      s.serviceType?.toLowerCase().includes('tee')
    ) ?? services[0];

    this.providerAddress = teeService.provider;
    await this.setupProvider(this.providerAddress);
  }

  /**
   * Configure a specific provider:
   *   1. Verify the provider's Remote Attestation (TDX quote) on-chain
   *   2. Acknowledge the provider's TEE signing key
   *   3. Fetch service metadata (endpoint + model)
   *   4. Record attestation links in the global registry
   */
  private async setupProvider(providerAddress: string): Promise<void> {
    if (!this.broker) throw new Error('Broker not initialized');

    // Step 1: Verify the provider's TEE attestation on-chain
    // This checks that the provider's signing key was generated inside genuine
    // Intel TDX hardware with a valid DCAP attestation quote.
    let serviceVerified: boolean | null = null;
    try {
      serviceVerified = await this.broker.inference.verifyService(providerAddress);
      if (serviceVerified === false) {
        logger.warn('0G Compute: provider TEE attestation FAILED verification', { providerAddress });
      } else if (serviceVerified === true) {
        logger.info('0G Compute: provider TEE attestation verified', { providerAddress });
      }
    } catch (err) {
      logger.warn('0G Compute: verifyService failed (provider may not support RA)', { err });
    }

    // Step 2: Fetch the RA download link for audit trail
    try {
      this.signerRaLink = await this.broker.inference.getSignerRaDownloadLink(providerAddress);
    } catch {
      this.signerRaLink = '';
    }

    // Step 3: Acknowledge the provider's signing key (required before billing headers)
    try {
      await this.broker.inference.getAccount(providerAddress);
    } catch {
      // Account may not exist yet — that's fine, getRequestHeaders will create it
    }

    // Step 4: Fetch endpoint + model
    this.serviceMetadata = await this.broker.inference.getServiceMetadata(providerAddress);

    // Record in global attestation registry
    globalTEERegistry.recordProvider({
      providerAddress,
      model: this.serviceMetadata.model,
      serviceVerified,
      signerRaLink: this.signerRaLink,
      verifiedAt: Date.now(),
    });
  }

  /**
   * Run LLM inference through a TEE-verified 0G Compute provider.
   *
   * Returns the response text plus attestation proof:
   *   - chatId      → unique ID linking to the provider's per-response signature
   *   - isValid     → true when the response was signed by a TEE-verified key
   *   - chatSignatureLink → URL to download the signature for independent verification
   *   - signerRaLink      → URL to download the provider's full TDX RA report
   */
  async inference(systemPrompt: string, userMessage: string, retries = 2): Promise<InferenceResult> {
    if (!this.initialized) await this.initialize();

    if (!this.broker || !this.serviceMetadata) {
      return this.mockInference(systemPrompt, userMessage);
    }

    try {
      return await this.inferenceOnce(systemPrompt, userMessage);
    } catch (err) {
      if (retries > 0) {
        logger.warn('0G Compute inference error — retrying', { err, retriesLeft: retries - 1 });
        // Re-initialize on retry in case the provider connection staled
        this.initialized = false;
        await this.initialize();
        return this.inference(systemPrompt, userMessage, retries - 1);
      }
      throw err;
    }
  }

  private async inferenceOnce(systemPrompt: string, userMessage: string): Promise<InferenceResult> {
    const content = userMessage; // content billed = user's input tokens

    // Get signed billing headers (proves this wallet is paying for the request)
    const headers = await this.broker!.inference.getRequestHeaders(this.providerAddress, content);

    const httpResponse = await fetch(`${this.serviceMetadata!.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        model: this.serviceMetadata!.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 4096,
        stream: false,
      }),
    });

    if (!httpResponse.ok) {
      const body = await httpResponse.text();
      throw new Error(`0G Compute inference failed: ${httpResponse.status} ${body}`);
    }

    const data = await httpResponse.json() as {
      id: string;
      choices: Array<{ message: { content: string } }>;
    };

    // ZG-Res-Key is the chat ID used to fetch the per-response TEE signature
    const chatId = httpResponse.headers.get('ZG-Res-Key') ?? data.id;
    const responseText = data.choices[0]?.message?.content ?? '';

    // Verify TEE attestation:
    //   processResponse(providerAddress, responseContent, chatId?)
    //   - responseContent: the text the provider returned (what was signed by TEE key)
    //   - chatId: links to the downloadable signature for this specific response
    //   Returns true if the response signature is valid against the verified TEE signing key
    let isValid: boolean | null = null;
    try {
      isValid = await this.broker!.inference.processResponse(
        this.providerAddress,
        responseText,
        chatId,
      );
    } catch (err) {
      logger.warn('0G Compute TEE response verification failed', { err, chatId });
    }

    // Fetch the per-chat signature download link for audit trail
    let chatSignatureLink = '';
    try {
      chatSignatureLink = await this.broker!.inference.getChatSignatureDownloadLink(
        this.providerAddress,
        chatId,
      );
    } catch {
      // Non-fatal — link is optional audit artifact
    }

    // Record in global attestation registry
    globalTEERegistry.recordChat({
      chatId,
      providerAddress: this.providerAddress,
      chatSignatureLink,
      responseVerified: isValid,
      timestamp: Date.now(),
    });

    logger.debug('0G Compute inference complete', {
      chatId,
      isValid,
      responseLength: responseText.length,
      chatSignatureLink,
    });

    return {
      response: responseText,
      chatId,
      teeProof: chatId,
      isValid: isValid === true,
      chatSignatureLink: chatSignatureLink || undefined,
      signerRaLink: this.signerRaLink || undefined,
      model: this.serviceMetadata!.model,
      providerAddress: this.providerAddress,
    };
  }

  /**
   * Verify the provider's Remote Attestation on demand.
   * Returns the RA download link so callers can store it for audit.
   */
  async verifyProvider(providerAddress?: string): Promise<{
    verified: boolean | null;
    signerRaLink: string;
  }> {
    if (!this.broker) return { verified: null, signerRaLink: '' };
    const addr = providerAddress ?? this.providerAddress;
    const [verified, link] = await Promise.all([
      this.broker.inference.verifyService(addr).catch(() => null),
      this.broker.inference.getSignerRaDownloadLink(addr).catch(() => ''),
    ]);
    return { verified, signerRaLink: link };
  }

  /** List all inference providers currently registered on-chain with their TEE verifiability type */
  async listTeeProviders(): Promise<Array<{
    provider: string;
    model: string;
    serviceType: string;
    verifiability: string;
    /** Input price in neuron per token (as string to avoid JSON bigint issues) */
    inputPrice: string;
    outputPrice: string;
    updatedAt: number;
  }>> {
    if (!this.broker) return [];
    const services = await this.broker.inference.listService();
    return services.map(s => ({
      provider: s.provider,
      model: s.model,
      serviceType: s.serviceType,
      verifiability: s.verifiability,
      inputPrice: s.inputPrice.toString(),
      outputPrice: s.outputPrice.toString(),
      updatedAt: Number(s.updatedAt),
    }));
  }

  async fundAccount(amountA0GI: number): Promise<void> {
    if (!this.broker) throw new Error('Broker not initialized');
    await this.broker.ledger.depositFund(amountA0GI);
    logger.info('0G Compute ledger funded', { amountA0GI });
  }

  private mockInference(systemPrompt: string, userMessage: string): InferenceResult {
    logger.debug('Mock inference (no 0G credentials — TEE NOT active)', {
      promptLength: systemPrompt.length,
      msgLength: userMessage.length,
    });
    const response = JSON.stringify({
      findings: [],
      summary: 'Mock analysis — set OG_PRIVATE_KEY for real TEE-verified inference.',
      overallRisk: 'low',
    });
    return {
      response,
      teeProof: 'mock-' + crypto.randomUUID(),
      isValid: false,
      model: 'mock',
    };
  }
}
