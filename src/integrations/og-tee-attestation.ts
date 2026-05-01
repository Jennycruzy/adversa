/**
 * 0G Compute TEE Attestation types and registry.
 *
 * 0G Compute TeeML services run inside Intel TDX (Trusted Domain Extensions)
 * or NVIDIA Hopper confidential compute hardware. Each provider registers a
 * Remote Attestation (RA) report on-chain that proves:
 *   1. The signing key was generated inside genuine TEE hardware
 *   2. The TEE measurement matches the expected model binary
 *
 * Every inference response is signed by that TEE key. The 0G serving broker
 * SDK verifies the chain: RA → signing address → per-chat signature → response
 * content, giving cryptographic proof that the response came from the model
 * running in a real TEE.
 *
 * Data stored here comes from:
 *   - broker.inference.verifyService()          → service-level RA verification
 *   - broker.inference.getSignerRaDownloadLink() → link to download the full RA
 *   - broker.inference.getChatSignatureDownloadLink() → link to per-chat proof
 *   - broker.inference.processResponse()         → per-response verification
 */

export interface TEEProviderAttestation {
  /** 0G Compute provider wallet address */
  providerAddress: string;
  /** Model served by this provider */
  model: string;
  /** Whether the provider's TDX Remote Attestation verified on-chain */
  serviceVerified: boolean | null;
  /** URL to download the provider's full Signer RA report (DCAP quote + NVIDIA payload) */
  signerRaLink: string;
  /** Timestamp when we verified this provider's RA */
  verifiedAt: number;
}

export interface TEEChatAttestation {
  /** The chat/response ID returned in the ZG-Res-Key header */
  chatId: string;
  /** Provider that produced this response */
  providerAddress: string;
  /** URL to download this chat's cryptographic signature from the provider */
  chatSignatureLink: string;
  /** Whether broker.inference.processResponse() confirmed the response is valid */
  responseVerified: boolean | null;
  /** Timestamp of the inference call */
  timestamp: number;
}

/**
 * In-process registry of all TEE attestations gathered in this session.
 * These are serialised into ConsensusResult.teeProofIds and uploaded to
 * 0G Storage alongside review findings.
 */
export class TEEAttestationRegistry {
  private providers = new Map<string, TEEProviderAttestation>();
  private chats = new Map<string, TEEChatAttestation>();

  recordProvider(attestation: TEEProviderAttestation): void {
    this.providers.set(attestation.providerAddress, attestation);
  }

  recordChat(attestation: TEEChatAttestation): void {
    this.chats.set(attestation.chatId, attestation);
  }

  getProvider(providerAddress: string): TEEProviderAttestation | undefined {
    return this.providers.get(providerAddress);
  }

  getChat(chatId: string): TEEChatAttestation | undefined {
    return this.chats.get(chatId);
  }

  allChats(): TEEChatAttestation[] {
    return Array.from(this.chats.values());
  }

  /** Summary counts for dashboard / on-chain record */
  summary(): { totalInferences: number; verified: number; unverified: number } {
    const all = this.allChats();
    const verified = all.filter(c => c.responseVerified === true).length;
    return { totalInferences: all.length, verified, unverified: all.length - verified };
  }

  /** All chat IDs — stored in ConsensusResult.teeProofIds */
  allChatIds(): string[] {
    return Array.from(this.chats.keys());
  }

  toJSON(): object {
    return {
      providers: Array.from(this.providers.values()),
      chats: Array.from(this.chats.values()),
      summary: this.summary(),
    };
  }
}

/** Singleton registry shared across all agents in this process */
export const globalTEERegistry = new TEEAttestationRegistry();
