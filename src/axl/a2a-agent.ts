export type A2AMessageType =
  | 'exploit_challenge'
  | 'finding_challenge'
  | 'counter_attack'
  | 'defense'
  | 'concession'
  | 'error';

export interface A2AEnvelope {
  type: A2AMessageType;
  from_peer?: string;
  request_id?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export function unwrapA2APayload(message: Record<string, unknown>): Record<string, unknown> {
  const payload = message['payload'];
  if (
    message['type'] === 'a2a_call' &&
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload)
  ) {
    return payload as Record<string, unknown>;
  }
  return message;
}
