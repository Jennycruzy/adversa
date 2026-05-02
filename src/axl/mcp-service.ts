import { MCPServiceDef } from '../types/agent.js';

export interface MCPToolCall {
  service: string;
  method: string;
  params: Record<string, unknown>;
  requestId: string;
}

export function defineMCPService(service: MCPServiceDef): MCPServiceDef {
  return service;
}

export function assertMCPParams(
  value: unknown,
  service: string
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid MCP params for ${service}`);
  }
}
