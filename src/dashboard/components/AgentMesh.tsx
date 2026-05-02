import React from 'react';

export interface AgentMeshAgent {
  peerId: string;
  role: string;
  status: string;
  online: boolean;
}

export function AgentMesh({ agents }: { agents: AgentMeshAgent[] }): React.JSX.Element {
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {agents.map(agent => (
        <article key={agent.peerId} className="rounded-md border border-zinc-800 bg-zinc-950 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-zinc-100">{agent.role}</h3>
            <span className={agent.online ? 'text-xs text-emerald-400' : 'text-xs text-zinc-500'}>
              {agent.online ? 'online' : 'offline'}
            </span>
          </div>
          <p className="mt-2 truncate text-xs text-zinc-500">{agent.peerId}</p>
          <p className="mt-3 text-sm text-zinc-300">{agent.status}</p>
        </article>
      ))}
    </section>
  );
}
