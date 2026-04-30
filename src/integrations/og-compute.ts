import { ethers } from 'ethers';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface InferenceResult {
  response: string;
  teeProof?: string;
  chatId?: string;
  isValid: boolean;
  model?: string;
  providerAddress?: string;
}

interface ServiceMetadata {
  endpoint: string;
  model: string;
}

/**
 * 0G Compute Sealed Inference wrapper.
 *
 * Every agent's LLM call goes through this — providing TEE-verified responses
 * that can be independently attested on 0G Chain. The `isValid` flag in the
 * result indicates whether the response came from genuine TEE hardware.
 */
export class OGComputeClient {
  private broker: unknown = null;
  private provider: ethers.JsonRpcProvider | null = null;
  private wallet: ethers.Wallet | null = null;
  private providerAddress: string = '';
  private serviceMetadata: ServiceMetadata | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (!config.og.privateKey) {
      logger.warn('OG_PRIVATE_KEY not set — using mock inference mode');
      this.initialized = true;
      return;
    }

    try {
      this.provider = new ethers.JsonRpcProvider(config.og.rpcUrl);
      this.wallet = new ethers.Wallet(config.og.privateKey, this.provider);

      // Dynamically import the 0G broker SDK
      const { createZGComputeNetworkBroker } = await import('@0glabs/0g-serving-broker');
      this.broker = await createZGComputeNetworkBroker(this.wallet as ethers.Wallet);

      if (config.og.computeProviderAddress) {
        this.providerAddress = config.og.computeProviderAddress;
        await this.setupProvider(this.providerAddress);
      } else {
        // Auto-discover a TeeML provider
        await this.discoverProvider();
      }

      this.initialized = true;
      logger.info('0G Compute initialized', {
        provider: this.providerAddress,
        model: this.serviceMetadata?.model,
      });
    } catch (err) {
      logger.error('0G Compute initialization failed — falling back to mock mode', { err });
      this.initialized = true; // Allow degraded operation
    }
  }

  private async discoverProvider(): Promise<void> {
    const b = this.broker as {
      inference: {
        listService: () => Promise<Array<{ provider: string; serviceType: string }>>;
        getServiceMetadata: (addr: string) => Promise<ServiceMetadata>;
        acknowledgeProviderSigner: (addr: string) => Promise<void>;
      };
      ledger: { depositFund: (amount: string) => Promise<void> };
    };

    const services = await b.inference.listService();
    // Prefer TeeML verifiable services
    const teeService = services.find(s => s.serviceType?.includes('tee')) ?? services[0];
    if (!teeService) throw new Error('No 0G Compute services available');

    this.providerAddress = teeService.provider;
    await this.setupProvider(this.providerAddress);
  }

  private async setupProvider(providerAddress: string): Promise<void> {
    const b = this.broker as {
      inference: {
        getServiceMetadata: (addr: string) => Promise<ServiceMetadata>;
        acknowledgeProviderSigner: (addr: string) => Promise<void>;
      };
      ledger: { depositFund: (amount: string) => Promise<void> };
    };

    try {
      await b.inference.acknowledgeProviderSigner(providerAddress);
    } catch (err) {
      logger.debug('Provider already acknowledged or acknowledge failed', { err });
    }

    this.serviceMetadata = await b.inference.getServiceMetadata(providerAddress);
  }

  async inference(systemPrompt: string, userMessage: string): Promise<InferenceResult> {
    if (!this.initialized) await this.initialize();

    // Mock mode when no credentials provided
    if (!this.broker || !this.serviceMetadata) {
      return this.mockInference(systemPrompt, userMessage);
    }

    const b = this.broker as {
      inference: {
        getRequestHeaders: (addr: string, content: string) => Promise<Record<string, string>>;
        processResponse: (addr: string, chatId: string) => Promise<boolean>;
      };
    };

    const content = `${systemPrompt}\n\n${userMessage}`;
    const headers = await b.inference.getRequestHeaders(this.providerAddress, content);

    const response = await fetch(`${this.serviceMetadata.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        model: this.serviceMetadata.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`0G Compute inference failed: ${response.status} ${body}`);
    }

    const data = await response.json() as {
      id: string;
      choices: Array<{ message: { content: string } }>;
    };

    const chatId = response.headers.get('ZG-Res-Key') ?? data.id;
    const responseText = data.choices[0]?.message?.content ?? '';

    // Verify TEE attestation
    let isValid = false;
    try {
      isValid = await b.inference.processResponse(this.providerAddress, chatId);
    } catch (err) {
      logger.warn('TEE verification failed', { err, chatId });
    }

    logger.debug('0G Compute inference complete', {
      chatId,
      isValid,
      responseLength: responseText.length,
    });

    return {
      response: responseText,
      teeProof: chatId,
      chatId,
      isValid,
      model: this.serviceMetadata.model,
      providerAddress: this.providerAddress,
    };
  }

  private mockInference(systemPrompt: string, userMessage: string): InferenceResult {
    logger.debug('Mock inference (no 0G credentials)', {
      promptLength: systemPrompt.length,
      msgLength: userMessage.length,
    });
    // In mock mode, return a placeholder that makes the pipeline runnable for demos
    const response = JSON.stringify({
      findings: [],
      summary: 'Mock analysis — configure OG_PRIVATE_KEY for real TEE-verified inference.',
      overallRisk: 'low',
    });
    return {
      response,
      teeProof: 'mock-tee-proof-' + crypto.randomUUID(),
      isValid: false,
      model: 'mock',
    };
  }

  async fundAccount(amountEther: string): Promise<void> {
    if (!this.broker) throw new Error('Broker not initialized');
    const b = this.broker as { ledger: { depositFund: (a: string) => Promise<void> } };
    await b.ledger.depositFund(amountEther);
    logger.info('0G Compute account funded', { amount: amountEther });
  }
}
