import { AgentRole } from '../config.js';

export interface AgentIntelligence {
  role: AgentRole;
  version: number;
  systemPrompt: string;
  learnedPatterns: LearnedPattern[];
  capabilities: string[];
  createdAt: number;
  lastEvolved: number;
}

export interface LearnedPattern {
  type: string;
  description: string;
  frequency: number;
  discoveredAt: number;
}

export interface INFTMetadata {
  name: string;
  description: string;
  image: string;
  attributes: Array<{
    trait_type: string;
    value: string | number;
  }>;
  encryptedIntelligenceURI: string;
  metadataHash: string;
  role: AgentRole;
  evolutionCount: number;
  reputationScore: number;
}
