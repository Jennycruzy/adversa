import type { AgentRole } from '../config.js';

export type { AgentRole };

export interface AgentConfig {
  role: AgentRole;
  axlPort: number;
  walletAddress?: string;
  inftTokenId?: number;
  encryptedIntelligenceURI?: string;
}

export interface PeerInfo {
  peerId: string;
  role: AgentRole;
  address: string;
  online: boolean;
  lastSeen: number;
  services: string[];
  reputationScore?: number;
  inftTokenId?: number;
}

export interface AgentCard {
  type: 'adversa-agent';
  version: '1.0';
  role: AgentRole;
  peerId: string;
  capabilities: string[];
  mcpServices: MCPServiceDef[];
  description: string;
}

export interface MCPServiceDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface HeartbeatPayload {
  peerId: string;
  role: AgentRole;
  timestamp: number;
  status: 'idle' | 'reviewing' | 'debating' | 'generating';
  reputationScore: number;
  currentTask?: string;
}

export interface GoalInjection {
  goal: string;
  source: 'dashboard' | 'agent' | 'human';
  priority: 'low' | 'medium' | 'high' | 'critical';
  timestamp: number;
  requestId: string;
}

export interface SwarmState {
  peers: Record<string, PeerInfo>;
  activePRs: string[];
  completedReviews: number;
  lastUpdated: number;
}
