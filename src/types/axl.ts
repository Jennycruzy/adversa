export interface AXLSendRequest {
  peer_id: string;
  data: string; // base64-encoded JSON
}

export interface AXLSendResponse {
  success: boolean;
  message_id?: string;
  error?: string;
}

export interface AXLRawMessage {
  from: string;
  data: string; // base64-encoded
  timestamp: number;
  message_id: string;
}

export interface AXLRecvResponse {
  messages: AXLRawMessage[];
}

export interface AXLPeer {
  peer_id: string;
  address: string;
  latency_ms?: number;
  online: boolean;
  last_seen?: number;
  services?: string[];
  agent_role?: string;
}

export interface AXLTopologyResponse {
  self_peer_id: string;
  peers: AXLPeer[];
}

export interface AXLMCPRequest {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
  id: string;
}

export interface AXLMCPResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: string;
}

export interface AXLA2ARequest {
  type: string;
  from_peer: string;
  payload: Record<string, unknown>;
  request_id: string;
  timestamp: number;
}

export interface AXLA2AResponse {
  type: string;
  from_peer: string;
  payload: Record<string, unknown>;
  request_id: string;
  timestamp: number;
}

export interface AXLGossipPublishRequest {
  topic: string;
  data: string; // base64-encoded
}

export interface AXLGossipMessage {
  topic: string;
  from: string;
  data: string; // base64-encoded
  timestamp: number;
}

export interface AXLConvergecastRequest {
  topic: string;
  data: string; // base64-encoded
  aggregation_fn: 'sum' | 'max' | 'min' | 'collect';
}

export interface AXLConvergecastResult {
  topic: string;
  aggregated: string; // base64-encoded
  contributor_count: number;
}

// Gossip topic constants — shared across all agents
export const GOSSIP_TOPICS = {
  PR_OPENED: 'adversa:pr-opened',
  CRITICAL_VULN: 'adversa:critical-vuln',
  GOALS: 'adversa:goals',
  HUMAN_ACTIVITY: 'adversa:human-activity',
  CONSENSUS: 'adversa:consensus',
  HEARTBEAT: 'adversa:heartbeat',
  OFFLINE_STATUS: 'adversa:offline-status',
} as const;

export type GossipTopic = typeof GOSSIP_TOPICS[keyof typeof GOSSIP_TOPICS];
